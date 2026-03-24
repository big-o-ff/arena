# Data migration: load first 100 LeetCode-derived problems into Problem rows.
#
# Source dataset (JSON on GitHub): https://github.com/neenza/leetcode-problems
# Bundled file: problems/data/first_100_leetcode.json — see problems/data/SOURCE.txt

import json
from pathlib import Path

from django.db import migrations


def seed_leetcode_problems(apps, schema_editor):
    Problem = apps.get_model("problems", "Problem")
    data_path = Path(__file__).resolve().parent.parent / "data" / "first_100_leetcode.json"
    if not data_path.exists():
        return
    with open(data_path, encoding="utf-8") as f:
        rows = json.load(f)
    for row in rows:
        Problem.objects.get_or_create(
            title=row["title"],
            defaults={
                "difficulty": row["difficulty"],
                "description": row["description"],
                "input_format": row["input_format"],
                "output_format": row["output_format"],
                "constraints": row["constraints"],
                "sample_input": row["sample_input"],
                "sample_output": row["sample_output"],
                "test_cases": row["test_cases"],
                "is_active": row.get("is_active", True),
            },
        )


def unseed_leetcode_problems(apps, schema_editor):
    Problem = apps.get_model("problems", "Problem")
    data_path = Path(__file__).resolve().parent.parent / "data" / "first_100_leetcode.json"
    if not data_path.exists():
        return
    with open(data_path, encoding="utf-8") as f:
        rows = json.load(f)
    titles = {r["title"] for r in rows}
    Problem.objects.filter(title__in=titles).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("problems", "0002_add_sample_fields"),
    ]

    operations = [
        migrations.RunPython(seed_leetcode_problems, unseed_leetcode_problems),
    ]
