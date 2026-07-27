"""
Channel-layer fan-out for a battle.

Two groups per battle, deliberately:

    battle_<id>        the two players
    battle_<id>_watch  spectators

They are separate because the players' live editor buffers are broadcast to
spectators but must never reach the opposing player. When both audiences shared
one group, a player could open the public spectate page for their own match in a
second tab and read their opponent's solution as it was typed — the blur applied
by the battle UI was cosmetic and did not exist on the spectate page at all.

Game state (HP, rounds, fog, battle end) goes to both groups; code goes only to
the watch group, and the opponent receives derived activity stats instead.
"""
from __future__ import annotations

import logging

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

logger = logging.getLogger(__name__)


def player_group(battle_id: int | str) -> str:
    return f"battle_{battle_id}"


def spectator_group(battle_id: int | str) -> str:
    return f"battle_{battle_id}_watch"


def code_activity(code: str) -> dict:
    """
    A non-reversible summary of an editor buffer.

    This is what the opposing player sees instead of the code: enough to render
    "they're typing / they've written a lot" without leaking the solution.
    """
    lines = code.count("\n") + 1 if code else 0
    return {
        "chars": len(code),
        "lines": lines,
        "non_empty_lines": sum(1 for line in code.splitlines() if line.strip()),
    }


def _group_send(group: str, message: dict, *, context: str) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.warning("No channel layer configured — dropping %s", context)
        return
    try:
        async_to_sync(channel_layer.group_send)(group, message)
    except Exception:
        logger.exception("Channel layer send failed (%s)", context)


def broadcast_battle_event(
    battle_id: int,
    event: str,
    payload: dict,
    *,
    include_spectators: bool = True,
) -> None:
    """Send a `broadcast.event` envelope to the players and (usually) spectators."""
    message = {"type": "broadcast.event", "event": event, "payload": payload}
    context = f"{event} for battle {battle_id}"

    _group_send(player_group(battle_id), message, context=context)
    if include_spectators:
        _group_send(spectator_group(battle_id), message, context=f"{context} (watch)")
