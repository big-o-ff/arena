"""
Synchronous submission evaluation (all test cases, HP, rewards).

Used by SubmitSolutionView for immediate feedback; Celery task delegates here too.
"""
from __future__ import annotations

import logging
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction
from .execution import run_code_safe
from .models import Battle, BattleReward, Submission

logger = logging.getLogger(__name__)


def _broadcast(battle_id: int, event: str, payload: dict) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("No channel layer — skipping broadcast")
        return
    async_to_sync(channel_layer.group_send)(
        f"battle_{battle_id}",
        {
            "type": "broadcast.event",
            "event": event,
            "payload": payload,
        },
    )


def evaluate_submission_sync(submission_id: int) -> dict[str, Any]:
    """
    Run all test cases, update submission, apply round rewards, persist BattleReward.

    Returns a JSON-serializable summary for the HTTP response.
    """
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
    }

    if total == 0:
        logger.warning("Problem %s has no test cases", problem.id)
        submission.status = Submission.Status.ERROR
        submission.save(update_fields=["status"])
        out["status"] = submission.status
        out["error"] = "Problem has no test cases"
        return out

    passed = 0
    total_execution_ms = 0
    first_error = ""

    for tc in test_cases:
        tc_input = str(tc.get("input", ""))
        tc_expected = str(tc.get("expected_output", "")).strip()

        result = run_code_safe(
            code=submission.code,
            stdin_str=tc_input,
            language=submission.language,
            timeout=5,
        )

        total_execution_ms += result.elapsed_ms

        actual = result.stdout.strip() if result.stdout else ""

        if result.return_code != 0:
            first_error = result.stderr or "Runtime error"
            break
        if actual != tc_expected:
            first_error = f"Expected: {tc_expected!r}, Got: {actual!r}"
            break
        passed += 1

    submission.passed_cases = passed
    submission.total_cases = total
    submission.execution_time_ms = total_execution_ms

    all_passed = passed == total

    if all_passed:
        submission.status = Submission.Status.PASSED
    else:
        submission.status = Submission.Status.FAILED

    submission.save(
        update_fields=[
            "passed_cases",
            "total_cases",
            "execution_time_ms",
            "status",
        ]
    )

    out["passed_cases"] = passed
    out["total_cases"] = total
    out["status"] = submission.status
    out["all_passed"] = all_passed
    out["execution_time_ms"] = total_execution_ms

    if not all_passed:
        out["error"] = first_error[:500]
        _broadcast(battle.id, "SUBMISSION_FAILED", {
            "player_id": submission.player_id,
            "problem_id": problem.id,
            "passed": passed,
            "total": total,
            "error": first_error[:200],
        })
        return out

    # --- All tests passed: round win logic ---
    hp_change = 35
    opponent_new_hp: int | None = None

    with transaction.atomic():
        battle = Battle.objects.select_for_update().get(id=battle.id)

        if battle.status != Battle.Status.ACTIVE:
            out["error"] = "battle_not_active"
            _broadcast(battle.id, "SUBMISSION_PASSED", {
                "player_id": submission.player_id,
                "problem_id": problem.id,
                "passed": passed,
                "total": total,
            })
            return out

        opponent_solved = Submission.objects.filter(
            battle=battle,
            problem=problem,
            status=Submission.Status.PASSED,
        ).exclude(player=submission.player).exists()

        if opponent_solved:
            _broadcast(battle.id, "SUBMISSION_PASSED", {
                "player_id": submission.player_id,
                "problem_id": problem.id,
                "passed": passed,
                "total": total,
            })
            out["player1_hp"] = battle.player1_hp
            out["player2_hp"] = battle.player2_hp
            return out

        is_player1 = submission.player_id == battle.player1_id

        if is_player1:
            battle.player2_hp = max(0, battle.player2_hp - hp_change)
            opponent_new_hp = battle.player2_hp
        else:
            battle.player1_hp = max(0, battle.player1_hp - hp_change)
            opponent_new_hp = battle.player1_hp

        battle.save(update_fields=["player1_hp", "player2_hp"])

        BattleReward.objects.create(
            user=submission.player,
            battle=battle,
            problem=problem,
            reward_type=BattleReward.RewardType.ROUND_FIRST_SOLVE,
            hp_damage_dealt=hp_change,
        )
        out["reward_saved"] = True
        out["round_won"] = True
        out["hp_damage"] = hp_change
        out["opponent_new_hp"] = opponent_new_hp
        out["player1_hp"] = battle.player1_hp
        out["player2_hp"] = battle.player2_hp

    _broadcast(battle.id, "ROUND_RESULT", {
        "winner_id": submission.player_id,
        "problem_id": problem.id,
        "problem_difficulty": problem.difficulty,
        "hp_change": -hp_change,
        "opponent_new_hp": opponent_new_hp,
    })

    _broadcast(battle.id, "HP_UPDATE", {
        "battle_id": battle.id,
        "player1_hp": battle.player1_hp,
        "player2_hp": battle.player2_hp,
    })

    battle_ended = False
    if opponent_new_hp is not None and opponent_new_hp <= 0:
        battle_ended = True
        from .tasks import process_battle_end

        process_battle_end.apply_async((battle.id,), queue="events")

    out["battle_ended"] = battle_ended

    from .tasks import complexity_analysis

    complexity_analysis.apply_async((submission.id,), queue="execution")

    return out
