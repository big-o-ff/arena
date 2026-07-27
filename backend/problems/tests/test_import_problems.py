"""The `import_problems` management command the README has always referenced."""
from __future__ import annotations

import json

import pytest
from django.core.management import CommandError, call_command

from problems.models import Problem

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _empty_problem_table():
    """Migrations seed the battle rotation; these tests want a blank slate."""
    Problem.objects.all().delete()

ARENA_RECORD = {
    "title": "Echo",
    "difficulty": "easy",
    "description": "Echo it back.",
    "input_format": "a line",
    "output_format": "the line",
    "constraints": "none",
    "sample_input": "hi",
    "sample_output": "hi",
    "test_cases": [{"input": "hi", "expected_output": "hi"}],
}

LEETCODE_RECORD = {
    "title": "Container With Most Water",
    "problem_id": "11",
    "difficulty": "Medium",
    "topics": ["Array", "Two Pointers"],
    "description": "You are given an integer array height...",
    "constraints": ["n == height.length", "2 <= n <= 105"],
    "examples": [
        {
            "example_num": 1,
            "example_text": "Input: height = [1,8,6,2,5,4,8,3,7]\nOutput: 49",
            "images": [],
        }
    ],
}


def _write(tmp_path, payload):
    path = tmp_path / "problems.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def test_the_command_exists():
    """It was referenced twice in the README and had never been written."""
    with pytest.raises(CommandError):
        call_command("import_problems", "/nonexistent/path.json")


def test_imports_arena_format_and_activates_it(tmp_path):
    call_command("import_problems", _write(tmp_path, [ARENA_RECORD]))

    problem = Problem.objects.get(title="Echo")
    assert problem.is_active is True
    assert problem.difficulty == "easy"
    assert problem.test_cases == ARENA_RECORD["test_cases"]


def test_leetcode_records_import_but_stay_inactive(tmp_path):
    """
    They carry no stdin/stdout cases, so the judge cannot score them. Importing
    them active would put unjudgeable problems into the battle rotation.
    """
    call_command("import_problems", _write(tmp_path, [LEETCODE_RECORD]))

    problem = Problem.objects.get(title="Container With Most Water")
    assert problem.is_active is False
    assert problem.test_cases == []
    assert problem.difficulty == "medium"  # normalised from "Medium"


def test_leetcode_examples_populate_the_sample(tmp_path):
    call_command("import_problems", _write(tmp_path, [LEETCODE_RECORD]))
    problem = Problem.objects.get(title="Container With Most Water")
    assert problem.sample_input == "height = [1,8,6,2,5,4,8,3,7]"
    assert problem.sample_output == "49"


def test_list_fields_are_flattened(tmp_path):
    call_command("import_problems", _write(tmp_path, [LEETCODE_RECORD]))
    problem = Problem.objects.get(title="Container With Most Water")
    assert "n == height.length" in problem.constraints
    assert "2 <= n <= 105" in problem.constraints


def test_require_tests_skips_unjudgeable_records(tmp_path):
    call_command(
        "import_problems",
        _write(tmp_path, [ARENA_RECORD, LEETCODE_RECORD]),
        "--require-tests",
    )
    assert Problem.objects.count() == 1
    assert Problem.objects.get().title == "Echo"


def test_reimport_updates_rather_than_duplicates(tmp_path):
    path = _write(tmp_path, [ARENA_RECORD])
    call_command("import_problems", path)
    call_command("import_problems", path)
    assert Problem.objects.filter(title="Echo").count() == 1


def test_dry_run_writes_nothing(tmp_path):
    call_command("import_problems", _write(tmp_path, [ARENA_RECORD]), "--dry-run")
    assert Problem.objects.count() == 0


def test_limit_is_respected(tmp_path):
    records = [{**ARENA_RECORD, "title": f"Echo {i}"} for i in range(5)]
    call_command("import_problems", _write(tmp_path, records), "--limit", "2")
    assert Problem.objects.count() == 2


def test_records_without_a_valid_difficulty_are_skipped(tmp_path):
    bad = {**ARENA_RECORD, "title": "Bad", "difficulty": "impossible"}
    call_command("import_problems", _write(tmp_path, [ARENA_RECORD, bad]))
    assert Problem.objects.count() == 1


def test_accepts_a_wrapped_payload(tmp_path):
    call_command("import_problems", _write(tmp_path, {"problems": [ARENA_RECORD]}))
    assert Problem.objects.filter(title="Echo").exists()


def test_rejects_malformed_json(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(CommandError, match="not valid JSON"):
        call_command("import_problems", str(path))
