# Data migration: upsert 3 canonical arena problems with verified test cases.
#
# Deactivates all previously-seeded problems (LeetCode format, no stdin test cases)
# then creates/updates 3 arena-ready problems that work with the stdin judge.

from django.db import migrations

ARENA_PROBLEMS = [
    {
        "title": "Two Sum",
        "difficulty": "easy",
        "description": (
            "Given an array of integers and a target integer, return the indices "
            "of the two numbers that add up to the target.\n\n"
            "You may assume exactly one solution exists. "
            "You may not use the same element twice.\n\n"
            "Return the two indices in ascending order.\n\n"
            "Example 1:\n"
            "  Input:\n"
            "    2 7 11 15\n"
            "    9\n"
            "  Output:\n"
            "    0 1\n"
            "  Explanation: nums[0] + nums[1] = 2 + 7 = 9\n\n"
            "Example 2:\n"
            "  Input:\n"
            "    3 2 4\n"
            "    6\n"
            "  Output:\n"
            "    1 2\n"
            "  Explanation: nums[1] + nums[2] = 2 + 4 = 6\n\n"
            "Example 3:\n"
            "  Input:\n"
            "    3 3\n"
            "    6\n"
            "  Output:\n"
            "    0 1\n"
            "  Explanation: nums[0] + nums[1] = 3 + 3 = 6"
        ),
        "input_format": (
            "Line 1: Space-separated integers (the array)\n"
            "Line 2: Target integer"
        ),
        "output_format": "Two space-separated integers (the indices, in ascending order)",
        "constraints": (
            "2 <= nums.length <= 10^4\n"
            "-10^9 <= nums[i] <= 10^9\n"
            "Exactly one valid answer exists"
        ),
        "sample_input": "2 7 11 15\n9",
        "sample_output": "0 1",
        "test_cases": [
            {"input": "2 7 11 15\n9",   "expected_output": "0 1"},
            {"input": "3 2 4\n6",        "expected_output": "1 2"},
            {"input": "3 3\n6",          "expected_output": "0 1"},
            {"input": "1 2 3 4 5\n9",    "expected_output": "3 4"},
            {"input": "0 4 3 0\n0",      "expected_output": "0 3"},
        ],
    },
    {
        "title": "Valid Parentheses",
        "difficulty": "medium",
        "description": (
            "Given a string containing only the characters '(', ')', '{', '}', "
            "'[', and ']', determine whether the input string is valid.\n\n"
            "A string is valid if:\n"
            "  - Every open bracket is closed by the same type of bracket\n"
            "  - Open brackets are closed in the correct order\n"
            "  - Every close bracket has a matching open bracket\n\n"
            "An empty string is considered VALID.\n\n"
            "Example 1:\n"
            "  Input:\n"
            "    ()[]{}\n"
            "  Output:\n"
            "    VALID\n\n"
            "Example 2:\n"
            "  Input:\n"
            "    ([)]\n"
            "  Output:\n"
            "    INVALID\n"
            "  Explanation: '[' is closed by ')' before ']' — wrong order.\n\n"
            "Example 3:\n"
            "  Input:\n"
            "    {[]}\n"
            "  Output:\n"
            "    VALID\n"
            "  Explanation: '{' contains '[]' which is valid, then closes correctly."
        ),
        "input_format": (
            "A single line containing only bracket characters: ( ) { } [ ]"
        ),
        "output_format": "VALID or INVALID",
        "constraints": (
            "0 <= s.length <= 10^4\n"
            "s consists only of '(', ')', '{', '}', '[', ']'\n"
            "An empty string is considered VALID"
        ),
        "sample_input": "()[]{}",
        "sample_output": "VALID",
        "test_cases": [
            {"input": "()",       "expected_output": "VALID"},
            {"input": "()[]{}", "expected_output": "VALID"},
            {"input": "(]",     "expected_output": "INVALID"},
            {"input": "([)]",   "expected_output": "INVALID"},
            {"input": "{[]}",   "expected_output": "VALID"},
        ],
    },
    {
        "title": "Longest Increasing Subsequence",
        "difficulty": "hard",
        "description": (
            "Given an integer array, return the length of the longest strictly "
            "increasing subsequence.\n\n"
            "A subsequence is a sequence derived from the array by deleting some "
            "or no elements without changing the order of the remaining elements. "
            "The subsequence must be strictly increasing (each element greater "
            "than the previous).\n\n"
            "Example 1:\n"
            "  Input:\n"
            "    10 9 2 5 3 7 101 18\n"
            "  Output:\n"
            "    4\n"
            "  Explanation: [2, 3, 7, 101] is the longest increasing subsequence.\n\n"
            "Example 2:\n"
            "  Input:\n"
            "    0 1 0 3 2 3\n"
            "  Output:\n"
            "    4\n"
            "  Explanation: [0, 1, 2, 3] is the longest increasing subsequence.\n\n"
            "Example 3:\n"
            "  Input:\n"
            "    7 7 7 7 7\n"
            "  Output:\n"
            "    1\n"
            "  Explanation: All elements are equal — no strictly increasing "
            "subsequence longer than 1 exists.\n\n"
            "Hint: An O(n²) DP solution works within constraints. "
            "An O(n log n) patience-sorting approach is optimal."
        ),
        "input_format": "A single line of space-separated integers",
        "output_format": "A single integer — the length of the longest strictly increasing subsequence",
        "constraints": (
            "1 <= nums.length <= 2500\n"
            "-10^4 <= nums[i] <= 10^4"
        ),
        "sample_input": "10 9 2 5 3 7 101 18",
        "sample_output": "4",
        "test_cases": [
            {"input": "10 9 2 5 3 7 101 18", "expected_output": "4"},
            {"input": "0 1 0 3 2 3",          "expected_output": "4"},
            {"input": "7 7 7 7 7",             "expected_output": "1"},
            {"input": "1 2 3 4 5",             "expected_output": "5"},
            {"input": "5 4 3 2 1",             "expected_output": "1"},
        ],
    },
]


def seed_arena_problems(apps, schema_editor):
    Problem = apps.get_model("problems", "Problem")

    # Deactivate all existing problems — they use LeetCode-format inputs that
    # don't work with the arena's plain-stdin judge.
    Problem.objects.all().update(is_active=False)

    # Create or fully update the 3 arena-ready problems.
    for data in ARENA_PROBLEMS:
        Problem.objects.update_or_create(
            title=data["title"],
            defaults={
                "difficulty":    data["difficulty"],
                "description":   data["description"],
                "input_format":  data["input_format"],
                "output_format": data["output_format"],
                "constraints":   data["constraints"],
                "sample_input":  data["sample_input"],
                "sample_output": data["sample_output"],
                "test_cases":    data["test_cases"],
                "is_active":     True,
            },
        )


def unseed_arena_problems(apps, schema_editor):
    # Reverse: deactivate the 3 arena problems and reactivate everything else.
    Problem = apps.get_model("problems", "Problem")
    titles = {p["title"] for p in ARENA_PROBLEMS}
    Problem.objects.filter(title__in=titles).update(is_active=False)
    Problem.objects.exclude(title__in=titles).update(is_active=True)


class Migration(migrations.Migration):

    dependencies = [
        ("problems", "0003_seed_leetcode_problems"),
    ]

    operations = [
        migrations.RunPython(seed_arena_problems, unseed_arena_problems),
    ]
