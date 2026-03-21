"""
Sandboxed code execution via native subprocess + resource limits.

No Docker required — uses Linux RLIMIT_* to constrain memory, CPU, file size,
and process count.  Each invocation runs in a fresh tempdir that is destroyed
after execution.

Supported languages: python, javascript, cpp.
"""
from __future__ import annotations

import os
import resource
import subprocess
import tempfile
import time
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Language configuration
# ---------------------------------------------------------------------------

LANGUAGE_CMD: dict[str, callable] = {
    "python": lambda f: ["python3", "-u", f],
    "javascript": lambda f: ["node", f],
    "cpp": lambda f: [f.replace(".cpp", "")],  # post-compile binary
}

COMPILE_CMD: dict[str, callable] = {
    "cpp": lambda src, out: ["g++", "-O2", "-o", out, src],
}

EXTENSIONS: dict[str, str] = {
    "python": "py",
    "javascript": "js",
    "cpp": "cpp",
}


@dataclass
class ExecutionResult:
    stdout: str
    stderr: str
    return_code: int
    elapsed_ms: int


def _make_limiter(timeout: int):
    """Return a preexec_fn that applies resource limits to the child process."""

    def _limit():
        # 128 MB address space
        resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
        # CPU time limit
        resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout))
        # 1 MB max file size
        resource.setrlimit(resource.RLIMIT_FSIZE, (1 * 1024 * 1024, 1 * 1024 * 1024))
        # Max 32 child processes
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))

    return _limit


def run_code_safe(
    code: str,
    stdin_str: str,
    language: str,
    timeout: int = 5,
) -> ExecutionResult:
    """
    Execute untrusted code in a subprocess with strict resource limits.

    Returns an ExecutionResult with stdout, stderr, return_code, and elapsed_ms.
    """
    if language not in EXTENSIONS:
        return ExecutionResult(
            stdout="",
            stderr=f"Unsupported language: {language}",
            return_code=-1,
            elapsed_ms=0,
        )

    with tempfile.TemporaryDirectory() as tmpdir:
        ext = EXTENSIONS[language]
        src = os.path.join(tmpdir, f"solution.{ext}")

        with open(src, "w") as f:
            f.write(code)

        # ------------------------------------------------------------------
        # Compile step for C++
        # ------------------------------------------------------------------
        if language == "cpp":
            binary = os.path.join(tmpdir, "solution")
            try:
                compile_result = subprocess.run(
                    COMPILE_CMD["cpp"](src, binary),
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
            except subprocess.TimeoutExpired:
                return ExecutionResult("", "Compilation timed out", -1, 0)

            if compile_result.returncode != 0:
                return ExecutionResult("", compile_result.stderr.strip(), -1, 0)
            cmd = [binary]
        else:
            cmd = LANGUAGE_CMD[language](src)

        # ------------------------------------------------------------------
        # Run with resource limits
        # ------------------------------------------------------------------
        start = time.perf_counter()
        try:
            result = subprocess.run(
                cmd,
                input=stdin_str,
                capture_output=True,
                text=True,
                timeout=timeout,
                preexec_fn=_make_limiter(timeout),
                cwd=tmpdir,
            )
            elapsed_ms = int((time.perf_counter() - start) * 1000)
            return ExecutionResult(
                stdout=result.stdout.strip(),
                stderr=result.stderr.strip(),
                return_code=result.returncode,
                elapsed_ms=elapsed_ms,
            )
        except subprocess.TimeoutExpired:
            return ExecutionResult(
                stdout="",
                stderr="Time limit exceeded",
                return_code=1,
                elapsed_ms=timeout * 1000,
            )
