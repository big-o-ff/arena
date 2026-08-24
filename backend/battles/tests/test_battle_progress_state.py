"""
Battle state must carry the caller's own progress.

The battle screen used to learn which problems it had solved only from the live
ROUND_RESULT socket event. That event fires while the player is being redirected
to the review page, so the screen was unmounted when it arrived and remounted
with an empty set — solved problems rendered as unsolved and the single-use
sabotage button came back available. Nothing seeded that state from the server,
so even a full reload did not repair it.
"""
from __future__ import annotations

import pytest

from battles.models import Submission
from sabotage.models import SabotageMove


@pytest.mark.django_db
class TestBattleStateProgress:
    def _state(self, client, battle):
        response = client.get(f"/api/battles/{battle.id}/state/")
        assert response.status_code == 200
        return response.data

    def test_progress_starts_empty(self, as_player1, battle):
        data = self._state(as_player1, battle)
        assert data["my_solved_problem_ids"] == []
        assert data["my_submitted_problem_ids"] == []
        assert data["my_sabotage_used"] is False

    def test_a_passed_submission_is_reported_as_solved(
        self, as_player1, battle, player1, problem
    ):
        Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code="print(1)",
            language="python",
            status=Submission.Status.PASSED,
        )
        data = self._state(as_player1, battle)
        assert data["my_solved_problem_ids"] == [problem.id]
        assert data["my_submitted_problem_ids"] == [problem.id]

    def test_a_failed_submission_is_submitted_but_not_solved(
        self, as_player1, battle, player1, problem
    ):
        Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code="print(0)",
            language="python",
            status=Submission.Status.FAILED,
        )
        data = self._state(as_player1, battle)
        assert data["my_solved_problem_ids"] == []
        assert data["my_submitted_problem_ids"] == [problem.id]

    def test_progress_is_per_caller(
        self, as_player2, battle, player1, problem
    ):
        """player1 solving it must not tick the box on player2's screen."""
        Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code="print(1)",
            language="python",
            status=Submission.Status.PASSED,
        )
        data = self._state(as_player2, battle)
        assert data["my_solved_problem_ids"] == []
        assert data["my_submitted_problem_ids"] == []

    def test_sabotage_use_survives_a_reload(
        self, as_player1, battle, player1
    ):
        SabotageMove.objects.create(
            battle=battle,
            attacker=player1,
            move_type=SabotageMove.MoveType.GARBAGE_COLLECTION,
        )
        data = self._state(as_player1, battle)
        assert data["my_sabotage_used"] is True

    def test_sabotage_flag_is_per_caller(self, as_player2, battle, player1):
        SabotageMove.objects.create(
            battle=battle,
            attacker=player1,
            move_type=SabotageMove.MoveType.GARBAGE_COLLECTION,
        )
        data = self._state(as_player2, battle)
        assert data["my_sabotage_used"] is False
