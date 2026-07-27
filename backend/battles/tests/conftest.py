from __future__ import annotations

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import User
from battles.models import Battle, Round
from problems.models import Problem

ECHO_SOLUTION = "import sys\nprint(sys.stdin.read().strip())"
WRONG_SOLUTION = "print('definitely wrong')"


@pytest.fixture
def make_user(db):
    counter = {"n": 0}

    def _make(**kwargs):
        counter["n"] += 1
        n = counter["n"]
        defaults = {
            "username": f"player{n}",
            "clerk_id": f"user_{n}",
            "display_name": f"Player {n}",
            "role": User.Role.PLAYER,
            "rating": 800,
        }
        defaults.update(kwargs)
        return User.objects.create(**defaults)

    return _make


@pytest.fixture
def player1(make_user):
    return make_user(username="alice", clerk_id="user_alice", display_name="Alice")


@pytest.fixture
def player2(make_user):
    return make_user(username="bob", clerk_id="user_bob", display_name="Bob")


@pytest.fixture
def outsider(make_user):
    return make_user(username="eve", clerk_id="user_eve", display_name="Eve")


@pytest.fixture
def make_problem(db):
    counter = {"n": 0}

    def _make(difficulty="easy", **kwargs):
        counter["n"] += 1
        n = counter["n"]
        defaults = {
            "title": f"Echo {n}",
            "description": "Echo the input.",
            "difficulty": difficulty,
            "input_format": "one line",
            "output_format": "the same line",
            "constraints": "none",
            "sample_input": "hello",
            "sample_output": "hello",
            "test_cases": [
                {"input": "hello", "expected_output": "hello"},
                {"input": "world", "expected_output": "world"},
            ],
            "is_active": True,
        }
        defaults.update(kwargs)
        return Problem.objects.create(**defaults)

    return _make


@pytest.fixture
def problem(make_problem):
    return make_problem()


@pytest.fixture
def battle(db, player1, player2, problem):
    battle = Battle.objects.create(
        player1=player1,
        player2=player2,
        status=Battle.Status.ACTIVE,
        ends_at=timezone.now() + timezone.timedelta(minutes=30),
    )
    Round.objects.create(battle=battle, problem=problem, round_number=1)
    return battle


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def as_player1(api_client, player1):
    api_client.force_authenticate(user=player1)
    return api_client


@pytest.fixture
def as_player2(api_client, player2):
    api_client.force_authenticate(user=player2)
    return api_client
