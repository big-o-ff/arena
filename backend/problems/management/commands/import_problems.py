"""
Management command: import_problems

Imports problems from a JSON file. Idempotent — skips if title already exists.
Run: python3 manage.py import_problems problems.json

Expected JSON format:
[
  {
    "title": "...",
    "difficulty": "easy|medium|hard",
    "description": "...",
    "input_format": "...",
    "output_format": "...",
    "constraints": "...",
    "sample_input": "...",
    "sample_output": "...",
    "test_cases": [
      {"input": "...", "expected_output": "..."}
    ]
  }
]
"""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from problems.models import Problem


class Command(BaseCommand):
    help = "Import problems from a JSON file (idempotent — skips existing titles)."

    def add_arguments(self, parser):
        parser.add_argument(
            "json_file",
            type=str,
            help="Path to the JSON file containing problems.",
        )

    def handle(self, *args, **options):
        json_path = Path(options["json_file"])
        if not json_path.exists():
            raise CommandError(f"File not found: {json_path}")

        try:
            with open(json_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except json.JSONDecodeError as e:
            raise CommandError(f"Invalid JSON: {e}")

        # Support both:
        # 1) [ {problem...}, ... ]
        # 2) { "questions": [ {problem...}, ... ] }  (merged_problems.json)
        if isinstance(raw, list):
            problems = raw
        elif isinstance(raw, dict) and isinstance(raw.get("questions"), list):
            problems = raw["questions"]
        else:
            raise CommandError(
                "JSON root must be a list of problem objects or an object with 'questions' list."
            )

        required_fields = {
            "title", "difficulty", "description",
            "input_format", "output_format", "constraints",
            "sample_input", "sample_output", "test_cases",
        }
        valid_difficulties = {"easy", "medium", "hard"}

        created_count = 0
        skipped_count = 0
        error_count = 0

        for i, data in enumerate(problems):
            # Normalize merged format into the canonical import shape.
            normalized = dict(data)
            if "examples" in normalized and "sample_input" not in normalized:
                # Try to infer sample input/output from first example text:
                # "Input: ...\nOutput: ..."
                example_text = ""
                examples = normalized.get("examples") or []
                if examples and isinstance(examples[0], dict):
                    example_text = str(examples[0].get("example_text") or "")
                lines = example_text.splitlines()
                input_lines = [
                    ln for ln in lines if ln.strip().lower().startswith("input:")
                ]
                output_lines = [
                    ln for ln in lines if ln.strip().lower().startswith("output:")
                ]
                normalized["sample_input"] = (
                    input_lines[0].split(":", 1)[1].strip() if input_lines else ""
                )
                normalized["sample_output"] = (
                    output_lines[0].split(":", 1)[1].strip() if output_lines else ""
                )
            if "constraints" in normalized and isinstance(normalized["constraints"], list):
                normalized["constraints"] = "\n".join(
                    str(x) for x in normalized["constraints"]
                )
            # merged_problems.json often has no hidden tests: keep import valid.
            if "test_cases" not in normalized:
                normalized["test_cases"] = []
            if "input_format" not in normalized:
                normalized["input_format"] = "See problem statement"
            if "output_format" not in normalized:
                normalized["output_format"] = "See problem statement"
            if "difficulty" in normalized:
                normalized["difficulty"] = str(normalized["difficulty"]).lower()

            # Validate required fields
            missing = required_fields - set(normalized.keys())
            if missing:
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem #{i + 1} missing fields: {missing} — skipping"
                    )
                )
                error_count += 1
                continue

            if normalized["difficulty"] not in valid_difficulties:
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem '{normalized.get('title', '')}' has invalid difficulty "
                        f"'{normalized['difficulty']}' — skipping"
                    )
                )
                error_count += 1
                continue

            if not isinstance(normalized["test_cases"], list):
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem '{normalized.get('title', '')}' test_cases must be a list — skipping"
                    )
                )
                error_count += 1
                continue

            # Normalize keys for the judge (battles.tasks.evaluate_submission)
            normalized_cases = []
            for tc in normalized["test_cases"]:
                if not isinstance(tc, dict):
                    continue
                inp = tc.get("input", "")
                exp = tc.get("expected_output", tc.get("output", ""))
                normalized_cases.append({"input": inp, "expected_output": exp})

            obj, created = Problem.objects.get_or_create(
                title=normalized["title"],
                defaults={
                    "difficulty": normalized["difficulty"],
                    "description": normalized["description"],
                    "input_format": normalized["input_format"],
                    "output_format": normalized["output_format"],
                    "constraints": normalized["constraints"],
                    "sample_input": normalized["sample_input"],
                    "sample_output": normalized["sample_output"],
                    "test_cases": normalized_cases,
                    "is_active": normalized.get("is_active", True),
                },
            )

            if created:
                created_count += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"  ✓ Imported: {obj.title} [{obj.difficulty}] "
                        f"({len(normalized['test_cases'])} test cases)"
                    )
                )
            else:
                skipped_count += 1
                self.stdout.write(
                    self.style.WARNING(f"  — Skipped (exists): {obj.title}")
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"\nDone. {created_count} created, {skipped_count} skipped, "
                f"{error_count} errors."
            )
        )
