"""
Import problems from a JSON file.

    python manage.py import_problems ../problems/merged_problems.json

Two input shapes are recognised:

ARENA FORMAT — judgeable. Requires stdin/stdout test cases:
    {
      "title": "Two Sum", "difficulty": "easy",
      "description": "...", "input_format": "...", "output_format": "...",
      "constraints": "...", "sample_input": "...", "sample_output": "...",
      "test_cases": [{"input": "...", "expected_output": "..."}]
    }

LEETCODE FORMAT — the shape of `problems/merged_problems.json`. These records
carry prose examples but no stdin/stdout cases, so they CANNOT be judged by this
platform's runner. They are imported as reference content with is_active=False.
Nothing selects inactive problems for a battle, so importing this file will not
add anything to the rotation; it exists so the text is queryable. To make one
playable, add `test_cases` and re-import, or use --require-tests to skip them
entirely.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from problems.models import Problem

DIFFICULTY_ALIASES = {
    "easy": Problem.Difficulty.EASY,
    "medium": Problem.Difficulty.MEDIUM,
    "med": Problem.Difficulty.MEDIUM,
    "hard": Problem.Difficulty.HARD,
}


def _normalise_difficulty(value: Any) -> str | None:
    return DIFFICULTY_ALIASES.get(str(value or "").strip().lower())


def _as_text(value: Any) -> str:
    """Flatten the list-or-string fields the LeetCode dataset mixes."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(str(item) for item in value)
    return str(value)


def _valid_test_cases(raw: Any) -> list[dict]:
    """Keep only well-formed {input, expected_output} pairs."""
    if not isinstance(raw, list):
        return []
    cases = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        if "input" not in item or "expected_output" not in item:
            continue
        cases.append(
            {
                "input": str(item["input"]),
                "expected_output": str(item["expected_output"]),
            }
        )
    return cases


def _leetcode_examples_to_samples(record: dict) -> tuple[str, str]:
    """
    Best-effort sample extraction from the LeetCode `examples` prose.

    Only used for display. It is deliberately NOT used to synthesise test cases:
    guessing a stdin encoding from prose would produce a judge that marks correct
    solutions wrong, which is worse than having no problem at all.
    """
    examples = record.get("examples") or []
    if not examples or not isinstance(examples, list):
        return "", ""
    text = str(examples[0].get("example_text", "")) if isinstance(examples[0], dict) else ""
    sample_input, sample_output = "", ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("input:"):
            sample_input = stripped[len("input:") :].strip()
        elif stripped.lower().startswith("output:"):
            sample_output = stripped[len("output:") :].strip()
    return sample_input, sample_output


def _to_problem_fields(record: dict) -> dict | None:
    title = str(record.get("title") or "").strip()
    difficulty = _normalise_difficulty(record.get("difficulty"))
    if not title or difficulty is None:
        return None

    test_cases = _valid_test_cases(record.get("test_cases"))

    sample_input = _as_text(record.get("sample_input"))
    sample_output = _as_text(record.get("sample_output"))
    if not sample_input and not sample_output:
        sample_input, sample_output = _leetcode_examples_to_samples(record)

    # Fall back to the first test case so the UI always has something to show.
    if not sample_input and test_cases:
        sample_input = test_cases[0]["input"]
        sample_output = test_cases[0]["expected_output"]

    return {
        "title": title,
        "difficulty": difficulty,
        "description": _as_text(record.get("description")),
        "input_format": _as_text(record.get("input_format")),
        "output_format": _as_text(record.get("output_format")),
        "constraints": _as_text(record.get("constraints")),
        "sample_input": sample_input,
        "sample_output": sample_output,
        "test_cases": test_cases,
        # Only judgeable problems may enter the battle rotation.
        "is_active": bool(test_cases),
    }


def _iter_records(payload: Any) -> Iterable[dict]:
    if isinstance(payload, list):
        return (r for r in payload if isinstance(r, dict))
    if isinstance(payload, dict):
        for key in ("problems", "data", "results"):
            if isinstance(payload.get(key), list):
                return (r for r in payload[key] if isinstance(r, dict))
        return iter([payload])
    return iter(())


class Command(BaseCommand):
    help = "Import problems from a JSON file into the Problem table."

    def add_arguments(self, parser):
        parser.add_argument("path", type=str, help="Path to the JSON file.")
        parser.add_argument(
            "--limit", type=int, default=0, help="Import at most N records."
        )
        parser.add_argument(
            "--require-tests",
            action="store_true",
            help="Skip records with no usable test cases instead of importing them inactive.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would happen without writing anything.",
        )

    def handle(self, *args, **options):
        path = Path(options["path"]).expanduser()
        if not path.exists():
            raise CommandError(f"No such file: {path}")

        try:
            with path.open(encoding="utf-8") as handle:
                payload = json.load(handle)
        except json.JSONDecodeError as exc:
            raise CommandError(f"{path} is not valid JSON: {exc}") from exc

        limit = options["limit"]
        require_tests = options["require_tests"]
        dry_run = options["dry_run"]

        created = updated = skipped_invalid = skipped_no_tests = 0
        judgeable = 0

        with transaction.atomic():
            for index, record in enumerate(_iter_records(payload)):
                if limit and (created + updated) >= limit:
                    break

                fields = _to_problem_fields(record)
                if fields is None:
                    skipped_invalid += 1
                    continue
                if require_tests and not fields["test_cases"]:
                    skipped_no_tests += 1
                    continue
                if fields["test_cases"]:
                    judgeable += 1

                if dry_run:
                    created += 1
                    continue

                title = fields.pop("title")
                _, was_created = Problem.objects.update_or_create(
                    title=title, defaults=fields
                )
                if was_created:
                    created += 1
                else:
                    updated += 1

            if dry_run:
                transaction.set_rollback(True)

        verb = "Would import" if dry_run else "Imported"
        self.stdout.write(
            self.style.SUCCESS(
                f"{verb} {created} new, {updated} updated "
                f"({judgeable} judgeable / battle-eligible)."
            )
        )
        if skipped_invalid:
            self.stdout.write(
                f"Skipped {skipped_invalid} record(s) missing a title or valid difficulty."
            )
        if skipped_no_tests:
            self.stdout.write(f"Skipped {skipped_no_tests} record(s) with no test cases.")

        if not judgeable:
            self.stdout.write(
                self.style.WARNING(
                    "No imported problem has stdin/stdout test cases, so none were "
                    "activated. Battles draw only from active problems that have "
                    "test cases — this file cannot extend the rotation on its own."
                )
            )
