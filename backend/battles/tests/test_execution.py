"""
Sandbox behaviour for untrusted submissions.

The headline property: submitted code must not be able to read this process's
environment. It previously inherited it wholesale, which handed any submitter
DJANGO_SECRET_KEY, MYSQL_PASSWORD, REDIS_URL and CLERK_WEBHOOK_SECRET.
"""
from __future__ import annotations

import os
import shutil
import time

import pytest

from battles.execution import (
    MAX_OUTPUT_CHARS,
    ExecutionResult,
    run_batch,
    run_code_safe,
)

needs_node = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed"
)
needs_gpp = pytest.mark.skipif(
    shutil.which("g++") is None, reason="g++ is not installed"
)

# Upper bound on how long a trivial C++ compile may take before we treat the
# host's toolchain as unusable for testing. A healthy machine compiles
# `#include <iostream>` in well under a second; some sandboxed or network
# filesystems make SDK header reads take tens of seconds, at which point these
# tests measure the filesystem rather than our code.
SLOW_TOOLCHAIN_SECONDS = 10.0


@pytest.fixture(scope="session")
def cpp_toolchain_is_usable() -> bool:
    if shutil.which("g++") is None:
        return False
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "probe.cpp")
        with open(source, "w") as handle:
            handle.write("#include <iostream>\nint main(){return 0;}\n")
        start = time.monotonic()
        try:
            subprocess.run(
                ["g++", "-o", os.path.join(tmp, "probe"), source],
                capture_output=True,
                timeout=90,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False
    return (time.monotonic() - start) < SLOW_TOOLCHAIN_SECONDS


@pytest.fixture(autouse=True)
def _skip_when_toolchain_is_slow(request, cpp_toolchain_is_usable):
    """Skip the C++ suite on hosts where compilation is pathologically slow."""
    if request.node.get_closest_marker("cpp") and not cpp_toolchain_is_usable:
        pytest.skip(
            "C++ toolchain is unavailable or slower than "
            f"{SLOW_TOOLCHAIN_SECONDS}s for a trivial compile"
        )


class TestEnvironmentIsolation:
    def test_secrets_are_not_visible_to_submitted_code(self, monkeypatch):
        monkeypatch.setenv("DJANGO_SECRET_KEY", "super-secret-value")
        monkeypatch.setenv("MYSQL_PASSWORD", "db-password-value")
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", "webhook-secret-value")

        result = run_code_safe(
            "import os\nprint(sorted(os.environ.keys()))", "", "python"
        )

        assert result.return_code == 0
        assert "DJANGO_SECRET_KEY" not in result.stdout
        assert "MYSQL_PASSWORD" not in result.stdout
        assert "CLERK_WEBHOOK_SECRET" not in result.stdout

    def test_secret_values_cannot_be_exfiltrated(self, monkeypatch):
        monkeypatch.setenv("DJANGO_SECRET_KEY", "canary-abc123")
        result = run_code_safe(
            "import os\nprint(os.environ.get('DJANGO_SECRET_KEY', 'ABSENT'))",
            "",
            "python",
        )
        assert result.stdout.strip() == "ABSENT"
        assert "canary-abc123" not in result.stdout

    def test_runs_in_a_private_working_directory(self):
        result = run_code_safe(
            "import os\nprint(os.listdir('.'))", "", "python"
        )
        # Only the submission itself should be present.
        assert "solution.py" in result.stdout
        assert "manage.py" not in result.stdout


class TestLimits:
    def test_infinite_loop_is_killed(self):
        start = time.monotonic()
        result = run_code_safe("while True:\n    pass", "", "python", timeout=2)
        elapsed = time.monotonic() - start

        assert result.timed_out is True
        assert elapsed < 15  # killed, not left running

    def test_sleep_is_bounded_by_wall_clock_not_cpu_time(self):
        """RLIMIT_CPU alone would never fire here — the parent timeout must."""
        result = run_code_safe("import time\ntime.sleep(30)", "", "python", timeout=2)
        assert result.timed_out is True

    def test_forking_cannot_escape_the_time_limit(self):
        """
        A fork bomb must not leave work running after the call returns.

        Two defences can catch this and either is acceptable: RLIMIT_NPROC
        refuses the fork outright, or the wall-clock timeout fires and the whole
        process *group* is killed (start_new_session + killpg). What must never
        happen is the call returning while children keep running.
        """
        code = (
            "import os, time\n"
            "while True:\n"
            "    if os.fork() == 0:\n"
            "        time.sleep(60)\n"
            "        os._exit(0)\n"
        )
        start = time.monotonic()
        result = run_code_safe(code, "", "python", timeout=2)
        elapsed = time.monotonic() - start

        assert elapsed < 15
        # Either the fork was denied (non-zero exit) or we timed out and killed it.
        assert result.timed_out or result.return_code != 0

    def test_output_is_truncated(self):
        result = run_code_safe(
            "print('x' * 500000)", "", "python", timeout=10
        )
        assert len(result.stdout) <= MAX_OUTPUT_CHARS + 100
        assert "truncated" in result.stdout

    def test_oversized_submission_is_refused(self):
        results = run_batch("x" * (300 * 1024), ["" ], "python")
        assert results[0].return_code == -1
        assert "too large" in results[0].stderr.lower()


class TestExecutionBasics:
    def test_stdin_is_delivered(self):
        result = run_code_safe(
            "import sys\nprint(sys.stdin.read().strip().upper())", "hello", "python"
        )
        assert result.stdout == "HELLO"

    def test_runtime_error_is_reported(self):
        result = run_code_safe("raise ValueError('boom')", "", "python")
        assert result.return_code != 0
        assert "boom" in result.stderr

    def test_unsupported_language(self):
        result = run_code_safe("print(1)", "", "brainfuck")
        assert result.return_code == -1
        assert "Unsupported language" in result.stderr

    def test_batch_stops_at_first_failure(self):
        code = "import sys\nn=int(sys.stdin.read())\nprint(1//n)"
        results = run_batch(code, ["1", "0", "2"], "python", stop_on_failure=True)
        assert len(results) == 2  # third input never runs
        assert results[0].ok
        assert not results[1].ok

    def test_batch_can_run_every_case(self):
        results = run_batch(
            "import sys\nprint(sys.stdin.read().strip())",
            ["a", "b", "c"],
            "python",
            stop_on_failure=False,
        )
        assert [r.stdout for r in results] == ["a", "b", "c"]

    @needs_node
    def test_javascript(self):
        result = run_code_safe(
            "let d='';process.stdin.on('data',c=>d+=c)"
            ".on('end',()=>console.log(d.trim().length));",
            "abcd",
            "javascript",
        )
        assert result.stdout == "4"


@needs_gpp
@pytest.mark.cpp
class TestCppCompilation:
    SOURCE = (
        "#include <iostream>\nint main(){int n;std::cin>>n;"
        "std::cout<<n*2<<std::endl;return 0;}"
    )

    def test_compiles_and_runs(self):
        result = run_code_safe(self.SOURCE, "21", "cpp")
        assert result.stdout == "42"

    def test_compile_error_is_reported_once(self):
        results = run_batch("int main(){ this is not c++ }", ["1", "2"], "cpp")
        assert len(results) == 1
        assert results[0].return_code == -1

    def test_compiles_only_once_for_many_cases(self, monkeypatch):
        """
        Regression: the judge called the compiler once per test case, so a
        5-case C++ submission could spend 75s in g++ and blow the client's
        20s HTTP timeout.

        Asserted by counting compiler invocations rather than by timing — wall
        clock here depends on filesystem cache warmth and host load, which makes
        a duration comparison meaningless.
        """
        import subprocess as sp

        from battles import execution

        compiles = []
        real_run = sp.run

        def counting_run(cmd, *args, **kwargs):
            if cmd and str(cmd[0]).endswith(("g++", "clang++")):
                compiles.append(cmd)
            return real_run(cmd, *args, **kwargs)

        monkeypatch.setattr(execution.subprocess, "run", counting_run)

        results = run_batch(
            self.SOURCE, ["1", "2", "3", "4", "5"], "cpp", stop_on_failure=False
        )

        assert [r.stdout for r in results] == ["2", "4", "6", "8", "10"]
        assert len(compiles) == 1, f"compiled {len(compiles)} times for 5 test cases"
