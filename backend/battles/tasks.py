"""
Celery tasks for battle code execution and game events.

Queue routing:
  - 'execution' queue: evaluate_submission, complexity_analysis
  - 'events'    queue: fog, gc, battle timeout, battle end
"""
from __future__ import annotations

import logging

from asgiref.sync import async_to_sync
from celery import shared_task
from channels.layers import get_channel_layer
from django.db import transaction

from .execution import run_code_safe

logger = logging.getLogger(__name__)


def _broadcast(battle_id: int, event: str, payload: dict) -> None:
    """Helper: send a WS event to everyone in a battle room."""
    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("No channel layer available — skipping broadcast")
        return
    async_to_sync(channel_layer.group_send)(
        f"battle_{battle_id}",
        {
            "type": "broadcast.event",
            "event": event,
            "payload": payload,
        },
    )


# ---------------------------------------------------------------------------
# Phase 1: Code execution
# ---------------------------------------------------------------------------

@shared_task(queue="execution", name="battles.evaluate_submission")
def evaluate_submission(submission_id: int) -> None:
    """
    Evaluate a submission against all test cases for its problem.

    Flow:
      1. Fetch Submission, Battle, Problem
      2. Run code against each test case using run_code_safe()
      3. Update Submission with results
      4. If all pass and first to solve → award round win (-35 HP)
      5. If any fail → broadcast SUBMISSION_FAILED
    """
    from .models import Battle, Submission  # deferred to avoid circular imports

    try:
        submission = Submission.objects.select_related(
            "battle", "problem", "player"
        ).get(id=submission_id)
    except Submission.DoesNotExist:
        logger.error("Submission %s not found", submission_id)
        return

    battle = submission.battle
    problem = submission.problem
    test_cases = problem.test_cases or []  # JSONField: list of {input, expected_output}
    total = len(test_cases)

    if total == 0:
        logger.warning("Problem %s has no test cases", problem.id)
        submission.status = Submission.Status.ERROR
        submission.save(update_fields=["status"])
        return

    # ------------------------------------------------------------------
    # Run against test cases
    # ------------------------------------------------------------------
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

        if result.return_code != 0:
            first_error = result.stderr or "Runtime error"
            break
        elif result.stdout != tc_expected:
            first_error = (
                f"Expected: {tc_expected!r}, Got: {result.stdout!r}"
            )
            break
        else:
            passed += 1

    # ------------------------------------------------------------------
    # Update Submission
    # ------------------------------------------------------------------
    submission.passed_cases = passed
    submission.total_cases = total
    submission.execution_time_ms = total_execution_ms

    all_passed = passed == total

    if all_passed:
        submission.status = Submission.Status.PASSED
    else:
        submission.status = Submission.Status.FAILED

    submission.save(update_fields=[
        "passed_cases", "total_cases", "execution_time_ms", "status",
    ])

    # ------------------------------------------------------------------
    # Broadcast result
    # ------------------------------------------------------------------
    if not all_passed:
        _broadcast(battle.id, "SUBMISSION_FAILED", {
            "player_id": submission.player_id,
            "problem_id": problem.id,
            "passed": passed,
            "total": total,
            "error": first_error[:200],  # truncate for safety
        })
        return

    # ------------------------------------------------------------------
    # All test cases passed — check if this player wins the round
    # ------------------------------------------------------------------
    with transaction.atomic():
        battle = Battle.objects.select_for_update().get(id=battle.id)

        if battle.status != Battle.Status.ACTIVE:
            return  # battle already over

        # Has the opponent already solved this problem?
        opponent_solved = Submission.objects.filter(
            battle=battle,
            problem=problem,
            status=Submission.Status.PASSED,
        ).exclude(player=submission.player).exists()

        if opponent_solved:
            # Both solved — no round winner (opponent was first)
            _broadcast(battle.id, "SUBMISSION_PASSED", {
                "player_id": submission.player_id,
                "problem_id": problem.id,
                "passed": passed,
                "total": total,
            })
            return

        # This player is FIRST to solve → round win! Deduct 35 HP.
        hp_change = 35
        is_player1 = submission.player_id == battle.player1_id

        if is_player1:
            battle.player2_hp = battle.player2_hp - hp_change
            opponent_new_hp = battle.player2_hp
        else:
            battle.player1_hp = battle.player1_hp - hp_change
            opponent_new_hp = battle.player1_hp

        battle.save(update_fields=["player1_hp", "player2_hp"])

    # Broadcast ROUND_RESULT
    _broadcast(battle.id, "ROUND_RESULT", {
        "winner_id": submission.player_id,
        "problem_id": problem.id,
        "problem_difficulty": problem.difficulty,
        "hp_change": -hp_change,
        "opponent_new_hp": opponent_new_hp,
    })

    # Broadcast HP_UPDATE
    _broadcast(battle.id, "HP_UPDATE", {
        "battle_id": battle.id,
        "player1_hp": battle.player1_hp,
        "player2_hp": battle.player2_hp,
    })

    # Check if battle should end (opponent HP <= 0)
    if opponent_new_hp <= 0:
        process_battle_end.apply_async(
            (battle.id,), queue="events"
        )

    # Kick off complexity analysis (non-blocking, separate task)
    complexity_analysis.apply_async(
        (submission.id,), queue="execution"
    )


# ---------------------------------------------------------------------------
# Phase 5 stub: Complexity analysis
# ---------------------------------------------------------------------------

@shared_task(queue="execution", name="battles.complexity_analysis")
def complexity_analysis(submission_id: int) -> None:
    """
    Classify the Big-O complexity of a submission by running it at
    increasing input sizes and comparing runtime ratios.

    Placeholder — will be fully implemented in Phase 5.
    """
    logger.info("complexity_analysis for submission %s — not yet implemented", submission_id)

# ---------------------------------------------------------------------------
# Phase 3: Sabotage (Garbage Collection)
# ---------------------------------------------------------------------------

@shared_task(queue="events", name="battles.send_gc_end")
def send_gc_end(battle_id: int, target_user_id: int) -> None:
    """Broadcasts GC_END to remove the garbage collection blank screen."""
    _broadcast(battle_id, "GC_END", {"target_user_id": target_user_id})

# ---------------------------------------------------------------------------
# Phase 4: Fog of War
# ---------------------------------------------------------------------------

@shared_task(queue="events", name="battles.schedule_fog")
def schedule_fog(battle_id: int) -> None:
    """
    Trigger Fog of War, wait 10s, then end fog. Reschedules itself for 90s later.
    """
    from .models import Battle
    
    try:
        battle = Battle.objects.get(id=battle_id)
    except Battle.DoesNotExist:
        return
        
    if battle.status != Battle.Status.ACTIVE:
        return
        
    _broadcast(battle.id, "FOG_START", {"battle_id": battle.id})
    
    # Queue fog end after 10s
    end_fog.apply_async((battle.id,), countdown=10, queue="events")
    
    # Re-queue next fog after 90s
    schedule_fog.apply_async((battle.id,), countdown=90, queue="events")

@shared_task(queue="events", name="battles.end_fog")
def end_fog(battle_id: int) -> None:
    """Ends the Fog of War."""
    _broadcast(battle_id, "FOG_END", {"battle_id": battle_id})


# ---------------------------------------------------------------------------
# Phase 6 stub: Battle end processing
# ---------------------------------------------------------------------------

@shared_task(queue="events", name="battles.process_battle_end")
def process_battle_end(battle_id: int) -> None:
    """
    Finalise a battle: determine winner, calculate ELO, create BattleResult,
    broadcast BATTLE_END.

    IDEMPOTENT: uses filter().update() so it's safe to call multiple times.
    """
    from .models import Battle, BattleResult, Submission
    from .utils import calculate_elo_deltas
    from accounts.models import User

    updated = Battle.objects.filter(
        id=battle_id, status=Battle.Status.ACTIVE,
    ).update(status=Battle.Status.COMPLETED)

    if updated == 0:
        return  # Already ended by another trigger — exit.

    battle = Battle.objects.select_related("player1", "player2").get(id=battle_id)

    # Determine winner by HP
    if battle.player1_hp > battle.player2_hp:
        winner_id = battle.player1_id
    elif battle.player2_hp > battle.player1_hp:
        winner_id = battle.player2_id
    else:
        winner_id = None  # draw

    battle.winner_id = winner_id
    battle.save(update_fields=["winner"])

    player1 = battle.player1
    player2 = battle.player2

    # Calculate ELO deltas
    delta1, delta2 = calculate_elo_deltas(
        player1.rating, player2.rating, winner_id, player1.id, player2.id
    )

    # Update Users
    player1.rating += delta1
    player2.rating += delta2
    if winner_id == player1.id:
        player1.total_wins += 1
        player2.total_losses += 1
    elif winner_id == player2.id:
        player2.total_wins += 1
        player1.total_losses += 1

    player1.save(update_fields=["rating", "total_wins", "total_losses"])
    player2.save(update_fields=["rating", "total_wins", "total_losses"])

    # Aggregate stats for Result object
    problems_solved = Submission.objects.filter(
        battle=battle, status=Submission.Status.PASSED
    ).values("problem").distinct().count()

    fastest_submission = Submission.objects.filter(
        battle=battle, status=Submission.Status.PASSED, execution_time_ms__isnull=False
    ).order_by("execution_time_ms").first()
    fastest_solve_time = fastest_submission.execution_time_ms if fastest_submission else None

    # Create BattleResult
    result = BattleResult.objects.create(
        battle=battle,
        player1_rating_change=delta1,
        player2_rating_change=delta2,
        fastest_solve_time_ms=fastest_solve_time,
        problems_solved=problems_solved,
    )

    # Broadcast
    _broadcast(battle.id, "BATTLE_END", {
        "battle_id": battle.id,
        "winner_id": winner_id,
        "reason": "hp_zero" if (battle.player1_hp == 0 or battle.player2_hp == 0) else "timeout",
        "player1_final_hp": battle.player1_hp,
        "player2_final_hp": battle.player2_hp,
        "share_url": f"/api/public/battles/share/{result.share_uuid}",
    })
    logger.info("Battle %s ended. Winner: %s (P1: %+d, P2: %+d)", battle_id, winner_id, delta1, delta2)

@shared_task(queue="events", name="battles.expire_battle_request")
def expire_battle_request(battle_request_id: int) -> None:
    from .models import BattleRequest
    
    updated = BattleRequest.objects.filter(
        id=battle_request_id, status=BattleRequest.Status.PENDING
    ).update(status=BattleRequest.Status.EXPIRED)
    
    if int(updated) > 0:
        try:
            req = BattleRequest.objects.get(id=battle_request_id)
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f"user_{req.from_user_id}",
                    {
                        "type": "invite_expired",
                        "battle_request_id": battle_request_id,
                    },
                )
        except Exception:
            pass
