"""
Management command: seed_problems

Idempotent — uses get_or_create keyed on title.
Run: python3 manage.py seed_problems
"""
from django.core.management.base import BaseCommand

from problems.models import Problem


PROBLEMS = [
    {
        "title": "Two Sum",
        "difficulty": "easy",
        "description": (
            "Given an array of integers nums and an integer target, "
            "return indices of the two numbers that add up to target.\n"
            "You may assume exactly one solution exists.\n"
            "You may not use the same element twice.\n"
            "Return the answer in any order."
        ),
        "input_format": (
            "First line: space-separated integers (the array)\n"
            "Second line: integer target"
        ),
        "output_format": "Two space-separated integers (the indices)",
        "constraints": (
            "2 <= nums.length <= 10^4\n"
            "-10^9 <= nums[i] <= 10^9\n"
            "Exactly one valid answer exists"
        ),
        "sample_input": "2 7 11 15\n9",
        "sample_output": "0 1",
        "test_cases": [
            {"input": "2 7 11 15\n9", "output": "0 1"},
            {"input": "3 2 4\n6", "output": "1 2"},
            {"input": "3 3\n6", "output": "0 1"},
            {"input": "1 2 3 4 5\n9", "output": "3 4"},
            {"input": "0 4 3 0\n0", "output": "0 3"},
        ],
    },
    {
        "title": "Valid Parentheses",
        "difficulty": "medium",
        "description": (
            "Given a string s containing only '(', ')', '{', '}', '[', ']', "
            "determine if the input string is valid.\n"
            "A string is valid if:\n"
            "- Open brackets are closed by the same type of bracket\n"
            "- Open brackets are closed in the correct order\n"
            "- Every close bracket has a corresponding open bracket"
        ),
        "input_format": "A single string containing only bracket characters",
        "output_format": "True or False",
        "constraints": (
            "1 <= s.length <= 10^4\n"
            "s consists of brackets only"
        ),
        "sample_input": "()[]{} ",
        "sample_output": "True",
        "test_cases": [
            {"input": "()[]{}", "output": "True"},
            {"input": "(]", "output": "False"},
            {"input": "([)]", "output": "False"},
            {"input": "{[]}", "output": "True"},
            {"input": "", "output": "True"},
        ],
    },
    {
        "title": "Longest Substring Without Repeating Characters",
        "difficulty": "hard",
        "description": (
            "Given a string s, find the length of the longest substring "
            "without repeating characters.\n"
            "A substring is a contiguous sequence of characters within a string."
        ),
        "input_format": "A single string s",
        "output_format": "A single integer — the length of the longest substring",
        "constraints": (
            "0 <= s.length <= 5 * 10^4\n"
            "s consists of English letters, digits, symbols, spaces"
        ),
        "sample_input": "abcabcbb",
        "sample_output": "3",
        "test_cases": [
            {"input": "abcabcbb", "output": "3"},
            {"input": "bbbbb", "output": "1"},
            {"input": "pwwkew", "output": "3"},
            {"input": "", "output": "0"},
            {"input": "au", "output": "2"},
        ],
    },
]


class Command(BaseCommand):
    help = "Seed the database with the 3 canonical problems (idempotent)."

    def handle(self, *args, **options):
        created_count = 0
        for data in PROBLEMS:
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
                    "is_active": True,
                },
            )
            if created:
                created_count += 1
                self.stdout.write(
                    self.style.SUCCESS(f"  ✓ Created: {obj.title} [{obj.difficulty}]")
                )
            else:
                self.stdout.write(
                    self.style.WARNING(f"  — Skipped (exists): {obj.title}")
                )

        self.stdout.write(
            self.style.SUCCESS(
                f"\nDone. {created_count} problem(s) created, "
                f"{len(PROBLEMS) - created_count} skipped."
            )
        )
