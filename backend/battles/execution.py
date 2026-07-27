"""
Execution of untrusted, user-submitted code.

WHAT THIS DOES
    Runs each submission in a throwaway directory, as a fresh process group, with
    a scrubbed environment and best-effort RLIMIT_* caps, and kills the whole
    process group on timeout so forked children cannot outlive the request.

WHAT THIS IS NOT
    This is not a sandbox. The child still shares the host kernel, filesystem and
    network namespace. It can read world-readable files and open sockets to
    localhost (MySQL, Redis). Treat these limits as defence in depth around a
    real isolation boundary — gVisor, Firecracker, or at minimum a container run
    with `--network=none --read-only --pids-limit --memory`. The environment is
    scrubbed here specifically so that a compromise cannot walk away with
    DJANGO_SECRET_KEY / MYSQL_PASSWORD / REDIS_URL, which the parent process
    holds and which used to be inherited wholesale.

Supported languages: python, javascript, cpp.
"""
from __future__ import annotations

import logging
import os
import resource
import shutil
import signal
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterable, Iterator, Sequence

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------
def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, default)))
    except (TypeError, ValueError):
        return default


# Wall-clock budgets. Both are tunable because they are sensitive to host load
# and disk speed: a busy judge box that fails correct submissions with "time
# limit exceeded" is worse than one that is simply slower.
ARENA_RUN_TIMEOUT = _env_int("ARENA_RUN_TIMEOUT", 5)
# Generous because compilation now happens once per submission rather than once
# per test case. A cold filesystem cache can make the first `#include <iostream>`
# take well over 15 seconds.
COMPILE_TIMEOUT_SECONDS = _env_int("ARENA_COMPILE_TIMEOUT", 45)

DEFAULT_TIMEOUT_SECONDS = ARENA_RUN_TIMEOUT
MEMORY_LIMIT_BYTES = 256 * 1024 * 1024
FILE_SIZE_LIMIT_BYTES = 1 * 1024 * 1024
MAX_PROCESSES = 64
# Captured streams are truncated so a program printing in a loop cannot exhaust
# memory here or blow up the JSON response.
MAX_OUTPUT_CHARS = 64 * 1024
MAX_CODE_CHARS = 200 * 1024
MAX_STDIN_CHARS = 256 * 1024

EXTENSIONS: dict[str, str] = {
    "python": "py",
    "javascript": "js",
    "cpp": "cpp",
}

SUPPORTED_LANGUAGES = tuple(EXTENSIONS)

# Interpreter/compiler binaries, resolved from the *parent* PATH so the child can
# be given a minimal one. Homebrew installs (/opt/homebrew/bin) resolve fine.
_TOOL_FOR_LANGUAGE = {
    "python": "python3",
    "javascript": "node",
    "cpp": "g++",
}


class ExecutionUnavailable(RuntimeError):
    """The toolchain for a language is not installed on this host."""


def _resolve_tool(language: str) -> str:
    tool = _TOOL_FOR_LANGUAGE[language]
    path = shutil.which(tool)
    if not path:
        raise ExecutionUnavailable(
            f"`{tool}` is not installed or not on PATH; cannot run {language} submissions."
        )
    return path


@dataclass
class ExecutionResult:
    stdout: str
    stderr: str
    return_code: int
    elapsed_ms: int
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return self.return_code == 0 and not self.timed_out


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated at {limit} characters]"


def _child_env(workdir: str) -> dict[str, str]:
    """
    A deliberately empty-ish environment.

    The parent process holds database credentials, the Django secret key, the
    Clerk webhook secret and the Redis URL. Inheriting those into a process that
    runs attacker-controlled code hands them over for free.
    """
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": workdir,
        "TMPDIR": workdir,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        # Stop Node from picking up an inherited config that could load modules.
        "NODE_OPTIONS": "",
    }


def _make_limiter(cpu_seconds: int):
    """
    Build the `preexec_fn` that caps the child's resources.

    Note: preexec_fn runs between fork and exec, and is documented as unsafe in
    multi-threaded parents (Daphne and the Celery worker both qualify). It is
    retained because RLIMIT_* has no in-process alternative; the calls made here
    are async-signal-safe, and `start_new_session=True` is handled natively by
    CPython rather than in this hook. Moving execution behind a container removes
    the need for it entirely.
    """

    def _apply() -> None:
        def _try_set(which: int, soft: int, hard: int) -> None:
            try:
                resource.setrlimit(which, (soft, hard))
            except (ValueError, OSError):
                # Darwin rejects several of these; a missing limit must not turn
                # into a failed fork, so every cap is best-effort.
                pass

        # CPU seconds consumed (not wall-clock — the wall-clock bound is the
        # `timeout` on communicate(), which is enforced by the parent).
        _try_set(resource.RLIMIT_CPU, cpu_seconds, cpu_seconds + 1)
        _try_set(resource.RLIMIT_FSIZE, FILE_SIZE_LIMIT_BYTES, FILE_SIZE_LIMIT_BYTES)
        _try_set(resource.RLIMIT_AS, MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES)
        _try_set(resource.RLIMIT_NPROC, MAX_PROCESSES, MAX_PROCESSES)
        _try_set(resource.RLIMIT_CORE, 0, 0)

    return _apply


def _kill_process_group(proc: subprocess.Popen) -> None:
    """SIGKILL the child's entire process group, so forks die with it."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _spawn(
    cmd: Sequence[str],
    stdin_str: str,
    workdir: str,
    timeout: int,
) -> ExecutionResult:
    start = time.perf_counter()
    try:
        proc = subprocess.Popen(
            list(cmd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=workdir,
            env=_child_env(workdir),
            preexec_fn=_make_limiter(timeout),
            start_new_session=True,  # own process group → killpg on timeout
        )
    except OSError as exc:
        return ExecutionResult("", f"Could not start process: {exc}", -1, 0)

    timed_out = False
    try:
        stdout, stderr = proc.communicate(input=stdin_str, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_process_group(proc)
        try:
            stdout, stderr = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            stdout, stderr = "", ""
        stderr = (stderr or "") + "\nTime limit exceeded"

    elapsed_ms = int((time.perf_counter() - start) * 1000)
    return ExecutionResult(
        stdout=_truncate((stdout or "").strip()),
        stderr=_truncate((stderr or "").strip()),
        return_code=proc.returncode if proc.returncode is not None else -1,
        elapsed_ms=elapsed_ms,
        timed_out=timed_out,
    )


@contextmanager
def _prepared_program(code: str, language: str) -> Iterator[tuple[list[str], str] | ExecutionResult]:
    """
    Materialise the submission on disk and, for compiled languages, build it once.

    Yields either `(argv, workdir)` ready to run repeatedly, or an ExecutionResult
    describing a compile failure.
    """
    with tempfile.TemporaryDirectory(prefix="arena-exec-") as workdir:
        os.chmod(workdir, 0o700)
        source = os.path.join(workdir, f"solution.{EXTENSIONS[language]}")
        with open(source, "w", encoding="utf-8") as handle:
            handle.write(code)

        if language == "cpp":
            binary = os.path.join(workdir, "solution")
            compiler = _resolve_tool("cpp")
            try:
                compiled = subprocess.run(
                    [compiler, "-O2", "-std=c++17", "-o", binary, source],
                    capture_output=True,
                    text=True,
                    timeout=COMPILE_TIMEOUT_SECONDS,
                    cwd=workdir,
                    env=_child_env(workdir),
                )
            except subprocess.TimeoutExpired:
                yield ExecutionResult("", "Compilation timed out", -1, 0)
                return
            except OSError as exc:
                yield ExecutionResult("", f"Compiler failed to start: {exc}", -1, 0)
                return

            if compiled.returncode != 0:
                yield ExecutionResult("", _truncate(compiled.stderr.strip()), -1, 0)
                return

            yield ([binary], workdir)
        elif language == "python":
            yield ([_resolve_tool("python"), "-I", "-u", source], workdir)
        else:  # javascript
            yield ([_resolve_tool("javascript"), source], workdir)


def run_batch(
    code: str,
    stdins: Iterable[str],
    language: str,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    stop_on_failure: bool = True,
) -> list[ExecutionResult]:
    """
    Run one submission against several inputs, compiling at most once.

    The previous implementation compiled C++ per test case, which meant a 5-case
    submission could spend 75 seconds in `g++` alone. Returns one result per
    input consumed; with `stop_on_failure` the list is short when a case fails.
    """
    stdins = list(stdins)
    if language not in EXTENSIONS:
        return [ExecutionResult("", f"Unsupported language: {language}", -1, 0)]
    if len(code) > MAX_CODE_CHARS:
        return [ExecutionResult("", "Submission is too large.", -1, 0)]
    if not stdins:
        return []

    try:
        with _prepared_program(code, language) as prepared:
            if isinstance(prepared, ExecutionResult):
                return [prepared]  # compile error / toolchain failure

            argv, workdir = prepared
            results: list[ExecutionResult] = []
            for stdin_str in stdins:
                result = _spawn(argv, stdin_str[:MAX_STDIN_CHARS], workdir, timeout)
                results.append(result)
                if stop_on_failure and not result.ok:
                    break
            return results
    except ExecutionUnavailable as exc:
        return [ExecutionResult("", str(exc), -1, 0)]
    except Exception:
        logger.exception("Unexpected failure executing a %s submission", language)
        return [ExecutionResult("", "Internal execution error", -1, 0)]


def run_code_safe(
    code: str,
    stdin_str: str,
    language: str,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> ExecutionResult:
    """Single-input convenience wrapper around `run_batch`."""
    results = run_batch(code, [stdin_str], language, timeout=timeout)
    return results[0] if results else ExecutionResult("", "No result", -1, 0)
