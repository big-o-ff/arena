"""
Expand the battle rotation beyond the three problems seeded by 0004.

`_create_battle` picks one active problem per difficulty, so with exactly one
candidate per tier every battle drew the same three problems in the same order.
This adds three more per tier from problems/data/arena_problems.json.

Every test case in that file is verified against a reference solution executed
through the real judge — see the note in the file's accompanying tests.
"""
import json
from pathlib import Path

from django.db import migrations

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "arena_problems.json"


def _load() -> list[dict]:
    if not DATA_FILE.exists():
        return []
    with DATA_FILE.open(encoding="utf-8") as handle:
        return json.load(handle)


def seed(apps, schema_editor):
    Problem = apps.get_model("problems", "Problem")
    for record in _load():
        Problem.objects.update_or_create(
            title=record["title"],
            defaults={
                "difficulty": record["difficulty"],
                "description": record["description"],
                "input_format": record["input_format"],
                "output_format": record["output_format"],
                "constraints": record["constraints"],
                "sample_input": record["sample_input"],
                "sample_output": record["sample_output"],
                "test_cases": record["test_cases"],
                "is_active": True,
            },
        )


def unseed(apps, schema_editor):
    Problem = apps.get_model("problems", "Problem")
    titles = [record["title"] for record in _load()]
    if titles:
        Problem.objects.filter(title__in=titles).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [
        ("problems", "0004_seed_arena_problems"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
