"""Scoring: first-solve damage, retries, and idempotent settlement."""
from __future__ import annotations

import pytest

from battles.evaluation import ROUND_DAMAGE, evaluate_submission_sync
from battles.models import Battle, BattleReward, BattleResult, Submission
from battles.tasks import finalize_battle_if_active
from battles.tests.conftest import ECHO_SOLUTION, WRONG_SOLUTION

pytestmark = pytest.mark.django_db


def _submit(battle, player, code=ECHO_SOLUTION, language="python"):
    return Submission.objects.create(
        battle=battle,
        player=player,
        problem=battle.rounds.first().problem,
        code=code,
        language=language,
        total_cases=len(battle.rounds.first().problem.test_cases),
    )


class TestFirstSolve:
    def test_passing_all_cases_damages_the_opponent(self, battle, player1):
        out = evaluate_submission_sync(_submit(battle, player1).id)

        assert out["all_passed"] is True
        assert out["round_won"] is True
        assert out["hp_damage"] == ROUND_DAMAGE

        battle.refresh_from_db()
        assert battle.player2_hp == 100 - ROUND_DAMAGE
        assert battle.player1_hp == 100

    def test_second_solver_gets_no_damage(self, battle, player1, player2):
        evaluate_submission_sync(_submit(battle, player1).id)
        out = evaluate_submission_sync(_submit(battle, player2).id)

        assert out["all_passed"] is True
        assert out["round_won"] is False

        battle.refresh_from_db()
        assert battle.player1_hp == 100  # untouched by the late solve
        assert battle.player2_hp == 100 - ROUND_DAMAGE

    def test_exactly_one_reward_per_problem(self, battle, player1, player2):
        evaluate_submission_sync(_submit(battle, player1).id)
        evaluate_submission_sync(_submit(battle, player2).id)
        assert BattleReward.objects.count() == 1

    def test_status_is_written_under_the_battle_lock(self, battle, player1, player2):
        """
        Regression: the verdict used to be persisted *before* taking the battle
        lock, so two near-simultaneous solves each saw the other already marked
        PASSED, both took the "opponent already solved" branch, and neither was
        awarded the round.
        """
        evaluate_submission_sync(_submit(battle, player1).id)
        evaluate_submission_sync(_submit(battle, player2).id)

        assert BattleReward.objects.count() == 1
        battle.refresh_from_db()
        # Damage was applied exactly once, not zero times.
        assert {battle.player1_hp, battle.player2_hp} == {100, 100 - ROUND_DAMAGE}

    def test_failing_submission_deals_no_damage(self, battle, player1):
        out = evaluate_submission_sync(_submit(battle, player1, WRONG_SOLUTION).id)

        assert out["all_passed"] is False
        assert out["round_won"] is False
        assert out["error"]

        battle.refresh_from_db()
        assert battle.player1_hp == 100
        assert battle.player2_hp == 100

    def test_no_damage_once_the_battle_is_over(self, battle, player1):
        Battle.objects.filter(pk=battle.pk).update(status=Battle.Status.COMPLETED)
        out = evaluate_submission_sync(_submit(battle, player1).id)

        assert out["all_passed"] is True
        assert out["round_won"] is False
        battle.refresh_from_db()
        assert battle.player2_hp == 100

    def test_resolving_twice_does_not_double_damage(self, battle, player1):
        """A retry after an accepted solve must not deal damage again."""
        evaluate_submission_sync(_submit(battle, player1).id)
        evaluate_submission_sync(_submit(battle, player1).id)

        assert BattleReward.objects.count() == 1
        battle.refresh_from_db()
        assert battle.player2_hp == 100 - ROUND_DAMAGE

    def test_problem_without_test_cases_errors_rather_than_passing(
        self, battle, player1, make_problem
    ):
        problem = battle.rounds.first().problem
        problem.test_cases = []
        problem.save(update_fields=["test_cases"])

        out = evaluate_submission_sync(_submit(battle, player1).id)
        assert out["status"] == Submission.Status.ERROR
        assert out["all_passed"] is False


class TestBattleEnd:
    def test_hp_reaching_zero_ends_the_battle(self, battle, player1, make_problem):
        Battle.objects.filter(pk=battle.pk).update(player2_hp=ROUND_DAMAGE)
        out = evaluate_submission_sync(_submit(battle, player1).id)

        assert out["battle_ended"] is True
        battle.refresh_from_db()
        assert battle.status == Battle.Status.COMPLETED
        assert battle.winner_id == player1.id
        assert battle.ended_reason == "hp_zero"

    def test_finalisation_is_idempotent(self, battle, player1, player2):
        Battle.objects.filter(pk=battle.pk).update(player2_hp=0)

        finalize_battle_if_active(battle.id)
        finalize_battle_if_active(battle.id)
        finalize_battle_if_active(battle.id)

        assert BattleResult.objects.filter(battle=battle).count() == 1
        player1.refresh_from_db()
        # Rating must be applied once, not three times.
        assert player1.total_wins == 1

    def test_equal_hp_is_a_draw(self, battle, player1, player2):
        finalize_battle_if_active(battle.id)

        battle.refresh_from_db()
        assert battle.winner_id is None
        assert battle.ended_reason == "timeout"

        player1.refresh_from_db()
        player2.refresh_from_db()
        assert player1.total_wins == 0
        assert player2.total_wins == 0

    def test_result_row_accompanies_the_rating_change(self, battle, player1):
        """Settlement is one transaction — ratings never land without a result."""
        Battle.objects.filter(pk=battle.pk).update(player2_hp=0)
        finalize_battle_if_active(battle.id)

        result = BattleResult.objects.get(battle=battle)
        player1.refresh_from_db()
        assert player1.rating == 800 + result.player1_rating_change
        assert result.player1_rating_change > 0
