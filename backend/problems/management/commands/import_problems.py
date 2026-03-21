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
      {"input": "...", "output": "..."}
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
                problems = json.load(f)
        except json.JSONDecodeError as e:
            raise CommandError(f"Invalid JSON: {e}")

        if not isinstance(problems, list):
            raise CommandError("JSON root must be a list of problem objects.")

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
            # Validate required fields
            missing = required_fields - set(data.keys())
            if missing:
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem #{i + 1} missing fields: {missing} — skipping"
                    )
                )
                error_count += 1
                continue

            if data["difficulty"] not in valid_difficulties:
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem '{data['title']}' has invalid difficulty "
                        f"'{data['difficulty']}' — skipping"
                    )
                )
                error_count += 1
                continue

            if not isinstance(data["test_cases"], list):
                self.stderr.write(
                    self.style.ERROR(
                        f"  ✗ Problem '{data['title']}' test_cases must be a list — skipping"
                    )
                )
                error_count += 1
                continue

            obj, created = Problem.objects.get_or_create(
                title=data["title"],
                defaults={
                    "difficulty": data["difficulty"],
                    "description": data["description"],
                    "input_format": data["input_format"],
                    "output_format": data["output_format"],
                    "constraints": data["constraints"],
                    "sample_input": data["sample_input"],
                    "sample_output": data["sample_output"],
                    "test_cases": data["test_cases"],
                    "is_active": data.get("is_active", True),
                },
            )

            if created:
                created_count += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"  ✓ Imported: {obj.title} [{obj.difficulty}] "
                        f"({len(data['test_cases'])} test cases)"
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
