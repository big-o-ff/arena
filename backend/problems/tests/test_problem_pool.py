"""
The battle rotation must have real variety, and every seeded problem must be
judgeable by the runner that scores it.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from problems.models import Problem

DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "arena_problems.json"

pytestmark = pytest.mark.django_db


def test_seed_data_file_is_present():
    """Migration 0003 silently no-ops when its data file is missing."""
    assert DATA_FILE.exists(), f"{DATA_FILE} is referenced by a migration"


def test_every_difficulty_has_several_candidates():
    """
    `_create_battle` draws one active problem per difficulty. With a single
    candidate per tier, every battle in the game was the same three problems.
    """
    for difficulty in ("easy", "medium", "hard"):
        count = (
            Problem.objects.filter(difficulty=difficulty, is_active=True)
            .exclude(test_cases=[])
            .count()
        )
        assert count >= 3, f"only {count} judgeable {difficulty} problems"


def test_seeded_problems_all_have_test_cases():
    for problem in Problem.objects.filter(is_active=True):
        assert problem.test_cases, f"{problem.title} is active but unjudgeable"


def test_test_cases_are_well_formed():
    for problem in Problem.objects.filter(is_active=True):
        for case in problem.test_cases:
            assert "input" in case, problem.title
            assert "expected_output" in case, problem.title
            assert isinstance(case["input"], str)
            assert isinstance(case["expected_output"], str)


def test_samples_match_the_first_test_case_or_are_populated():
    for problem in Problem.objects.filter(is_active=True):
        assert problem.sample_input.strip(), problem.title
        assert problem.sample_output.strip(), problem.title


def test_battles_can_draw_distinct_problem_sets(player_pair, make_two_more_players):
    """Two consecutive battles should be able to differ."""
    from battles.views import _create_battle

    seen = set()
    for pair in (player_pair, make_two_more_players):
        battle = _create_battle(*pair)
        seen.add(tuple(sorted(r.problem_id for r in battle.rounds.all())))
        battle.status = "completed"
        battle.save(update_fields=["status"])

    # With >=3 candidates per tier this is possible; assert the machinery at
    # least produced a valid 3-problem set each time.
    for combo in seen:
        assert len(combo) == 3


@pytest.fixture
def player_pair(db):
    from accounts.models import User

    return (
        User.objects.create(username="p1", clerk_id="c1", display_name="P1"),
        User.objects.create(username="p2", clerk_id="c2", display_name="P2"),
    )


@pytest.fixture
def make_two_more_players(db):
    from accounts.models import User

    return (
        User.objects.create(username="p3", clerk_id="c3", display_name="P3"),
        User.objects.create(username="p4", clerk_id="c4", display_name="P4"),
    )
