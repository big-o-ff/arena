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
from .evaluation import evaluate_submission_sync

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
    """Async wrapper — same logic as synchronous HTTP submit path."""
    evaluate_submission_sync(submission_id)


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

BATTLE_DURATION_MINUTES = 30


def finalize_battle_if_active(
    battle_id: int,
    *,
    end_reason: str | None = None,
    resigned_user_id: int | None = None,
) -> None:
    """
    Finalise a battle: determine winner, calculate ELO, create BattleResult,
    broadcast BATTLE_END.

    IDEMPOTENT: uses filter().update() so it's safe to call multiple times.
    Callable synchronously from HTTP handlers (no Celery worker required).

    end_reason: if set (e.g. \"resign\"), used as BATTLE_END payload reason instead
    of inferring hp_zero vs timeout. resigned_user_id is included when provided.
    """
    from .models import Battle, BattleResult, Submission
    from .utils import calculate_elo_deltas

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

    hp_reason = battle.player1_hp == 0 or battle.player2_hp == 0
    if end_reason:
        reason_str = end_reason
    elif hp_reason:
        reason_str = "hp_zero"
    else:
        reason_str = "timeout"

    battle.winner_id = winner_id
    battle.ended_reason = reason_str
    if resigned_user_id is not None:
        battle.resigned_by_id = resigned_user_id
    battle.save(update_fields=["winner", "ended_reason", "resigned_by"])

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

    end_payload = {
        "battle_id": battle.id,
        "winner_id": winner_id,
        "reason": reason_str,
        "player1_final_hp": battle.player1_hp,
        "player2_final_hp": battle.player2_hp,
    }
    if resigned_user_id is not None:
        end_payload["resigned_user_id"] = resigned_user_id
    _broadcast(battle.id, "BATTLE_END", end_payload)
    logger.info("Battle %s ended. Winner: %s (P1: %+d, P2: %+d)", battle_id, winner_id, delta1, delta2)


def maybe_finalize_expired_battle(battle_id: int) -> bool:
    """
    If the battle is ACTIVE and wall-clock is past ends_at (or legacy: created_at + 30m),
    complete it. Used from API views so matches end even when Celery is not running.

    Returns True if a battle was finalized.
    """
    from datetime import timedelta

    from django.utils import timezone

    from .models import Battle

    try:
        battle = Battle.objects.get(pk=battle_id)
    except Battle.DoesNotExist:
        return False
    if battle.status != Battle.Status.ACTIVE:
        return False
    now = timezone.now()
    if battle.ends_at is not None:
        if now < battle.ends_at:
            return False
    else:
        deadline = battle.created_at + timedelta(minutes=BATTLE_DURATION_MINUTES)
        if now < deadline:
            return False

    finalize_battle_if_active(battle_id)
    return True


@shared_task(queue="events", name="battles.process_battle_end")
def process_battle_end(battle_id: int) -> None:
    """Celery entrypoint — same as finalize_battle_if_active (scheduled at match start)."""
    finalize_battle_if_active(battle_id)

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
