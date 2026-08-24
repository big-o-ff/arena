"""
Submission evaluation: run the hidden test cases, award the round, update HP.

Runs from the Celery `execution` queue (see battles.tasks.evaluate_submission).
The sandboxed run happens *outside* any transaction — it takes seconds — and
only the scoring decision is taken under a row lock.
"""
from __future__ import annotations

import logging
from typing import Any

from django.db import transaction

from .events import broadcast_battle_event
from .execution import run_batch
from .models import Battle, BattleReward, Submission

logger = logging.getLogger(__name__)

# HP removed from the opponent for being first to solve a problem.
ROUND_DAMAGE = 35


def _run_test_cases(submission: Submission, test_cases: list[dict]) -> tuple[int, int, str]:
    """Execute every case until one fails. Returns (passed, total_ms, first_error)."""
    inputs = [str(tc.get("input", "")) for tc in test_cases]
    results = run_batch(
        code=submission.code,
        stdins=inputs,
        language=submission.language,
        stop_on_failure=True,
    )

    passed = 0
    total_ms = 0
    first_error = ""

    for index, result in enumerate(results):
        total_ms += result.elapsed_ms
        expected = str(test_cases[index].get("expected_output", "")).strip()
        actual = (result.stdout or "").strip()

        if result.timed_out:
            first_error = f"Test {index + 1}: time limit exceeded"
            break
        if result.return_code != 0:
            first_error = result.stderr or f"Test {index + 1}: runtime error"
            break
        if actual != expected:
            first_error = f"Test {index + 1}: expected {expected!r}, got {actual!r}"
            break
        passed += 1

    return passed, total_ms, first_error


def evaluate_submission_sync(submission_id: int) -> dict[str, Any]:
    """Evaluate one submission and return a JSON-serialisable summary."""
    try:
        submission = Submission.objects.select_related(
            "battle", "problem", "player"
        ).get(id=submission_id)
    except Submission.DoesNotExist:
        return {"error": "submission_not_found"}

    battle = submission.battle
    problem = submission.problem
    test_cases = problem.test_cases or []
    total = len(test_cases)

    out: dict[str, Any] = {
        "submission_id": submission_id,
        "status": submission.status,
        "passed_cases": 0,
        "total_cases": total,
        "all_passed": False,
        "error": None,
        "round_won": False,
        "hp_damage": None,
        "player1_hp": battle.player1_hp,
        "player2_hp": battle.player2_hp,
        "opponent_new_hp": None,
        "reward_saved": False,
        "battle_ended": False,
        "execution_time_ms": 0,
        "current_round": battle.current_round,
    }

    if total == 0:
        logger.error("Problem %s has no test cases — cannot judge", problem.id)
        Submission.objects.filter(id=submission_id).update(
            status=Submission.Status.ERROR
        )
        out["status"] = Submission.Status.ERROR
        out["error"] = "Problem has no test cases"
        return out

    # --- Slow part: no locks held, no transaction open. ---
    passed, total_ms, first_error = _run_test_cases(submission, test_cases)
    all_passed = passed == total

    out.update(
        passed_cases=passed,
        total_cases=total,
        all_passed=all_passed,
        execution_time_ms=total_ms,
    )

    # --- Fast part: persist the verdict and decide the round under a lock. ---
    # The status write must happen inside the same lock that reads the opponent's
    # status. Writing it first (as this used to) let two near-simultaneous solves
    # each observe the other as "already passed", so neither was awarded a round.
    opponent_new_hp: int | None = None
    round_won = False

    with transaction.atomic():
        locked_battle = Battle.objects.select_for_update().get(id=battle.id)

        submission.passed_cases = passed
        submission.total_cases = total
        submission.execution_time_ms = total_ms
        submission.status = (
            Submission.Status.PASSED if all_passed else Submission.Status.FAILED
        )
        submission.save(
            update_fields=[
                "passed_cases",
                "total_cases",
                "execution_time_ms",
                "status",
            ]
        )
        out["status"] = submission.status

        if all_passed and locked_battle.status == Battle.Status.ACTIVE:
            already_solved = (
                Submission.objects.filter(
                    battle_id=locked_battle.id,
                    problem_id=problem.id,
                    status=Submission.Status.PASSED,
                )
                .exclude(id=submission.id)
                .exclude(player_id=submission.player_id)
                .exists()
            )
            # A player re-solving their own problem must not deal damage twice.
            self_already_rewarded = BattleReward.objects.filter(
                battle_id=locked_battle.id,
                user_id=submission.player_id,
                problem_id=problem.id,
            ).exists()

            if not already_solved and not self_already_rewarded:
                if submission.player_id == locked_battle.player1_id:
                    locked_battle.player2_hp = max(
                        0, locked_battle.player2_hp - ROUND_DAMAGE
                    )
                    opponent_new_hp = locked_battle.player2_hp
                else:
                    locked_battle.player1_hp = max(
                        0, locked_battle.player1_hp - ROUND_DAMAGE
                    )
                    opponent_new_hp = locked_battle.player1_hp

                # Advance the match clock. `current_round` is how many problems
                # have been claimed, +1 — it is display state and the fallback
                # used when a submission arrives without an explicit problem_id.
                # Capped at the number of rounds so the last solve does not point
                # past the end of the pool.
                round_count = locked_battle.rounds.count()
                if locked_battle.current_round < round_count:
                    locked_battle.current_round += 1

                locked_battle.save(
                    update_fields=["player1_hp", "player2_hp", "current_round"]
                )
                BattleReward.objects.create(
                    user_id=submission.player_id,
                    battle=locked_battle,
                    problem=problem,
                    reward_type=BattleReward.RewardType.ROUND_FIRST_SOLVE,
                    hp_damage_dealt=ROUND_DAMAGE,
                )
                round_won = True

        out["player1_hp"] = locked_battle.player1_hp
        out["player2_hp"] = locked_battle.player2_hp
        out["current_round"] = locked_battle.current_round

    # --- Broadcasts happen after commit so clients never read stale rows. ---
    if not all_passed:
        out["error"] = first_error[:500]
        broadcast_battle_event(
            battle.id,
            "SUBMISSION_FAILED",
            {
                "player_id": submission.player_id,
                "problem_id": problem.id,
                "passed": passed,
                "total": total,
                "error": first_error[:200],
            },
        )
        return out

    broadcast_battle_event(
        battle.id,
        "SUBMISSION_PASSED",
        {
            "player_id": submission.player_id,
            "problem_id": problem.id,
            "passed": passed,
            "total": total,
        },
    )

    if not round_won:
        return out

    out.update(
        round_won=True,
        reward_saved=True,
        hp_damage=ROUND_DAMAGE,
        opponent_new_hp=opponent_new_hp,
    )

    broadcast_battle_event(
        battle.id,
        "ROUND_RESULT",
        {
            "winner_id": submission.player_id,
            "problem_id": problem.id,
            "problem_difficulty": problem.difficulty,
            "hp_change": -ROUND_DAMAGE,
            "opponent_new_hp": opponent_new_hp,
            "current_round": out["current_round"],
        },
    )
    broadcast_battle_event(
        battle.id,
        "HP_UPDATE",
        {
            "battle_id": battle.id,
            "player1_hp": out["player1_hp"],
            "player2_hp": out["player2_hp"],
        },
    )

    if opponent_new_hp is not None and opponent_new_hp <= 0:
        out["battle_ended"] = True
        from .tasks import finalize_battle_if_active

        # Called inline rather than queued: the battle must be settled before the
        # clients that just received HP_UPDATE re-fetch state, and this path has
        # to work whether or not a Celery worker is running.
        finalize_battle_if_active(battle.id)

    return out
