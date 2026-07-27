from __future__ import annotations

import logging
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.db.models import F

from battles.events import spectator_group

logger = logging.getLogger(__name__)

MAX_EMOTE_CHARS = 32
# Likes and emotes are unauthenticated-ish input on a hot path; without a cap a
# single socket can drive unbounded UPDATEs and group sends.
LIKE_MIN_INTERVAL_SECONDS = 1.0
EMOTE_MIN_INTERVAL_SECONDS = 0.5


@database_sync_to_async
def _increment_spectator_likes(battle_id: int) -> int:
    from battles.models import Battle

    Battle.objects.filter(id=battle_id).update(
        spectator_likes=F("spectator_likes") + 1
    )
    return (
        Battle.objects.filter(id=battle_id)
        .values_list("spectator_likes", flat=True)
        .first()
        or 0
    )


@database_sync_to_async
def _is_participant(battle_id: str, user_id: int) -> bool:
    from battles.models import Battle

    return Battle.objects.filter(pk=battle_id).filter(
        **{"player1_id": user_id}
    ).exists() or Battle.objects.filter(pk=battle_id).filter(
        **{"player2_id": user_id}
    ).exists()


@database_sync_to_async
def _battle_is_watchable(battle_id: str) -> bool:
    from battles.models import Battle

    return Battle.objects.filter(
        pk=battle_id, status__in=[Battle.Status.ACTIVE, Battle.Status.COMPLETED]
    ).exists()


class SpectatorConsumer(AsyncJsonWebsocketConsumer):
    """
    Public watch stream for a battle.

    Requires a signed-in user who is NOT one of the two players. That
    restriction is the whole point: this stream carries both players' live
    editor buffers, so letting a participant subscribe to their own match — which
    the previous unauthenticated version did — handed them their opponent's
    solution keystroke by keystroke.

    Residual risk: a determined player can still watch from a second account.
    Closing that properly means putting the spectator stream on a broadcast
    delay; this only removes the one-click version.
    """

    async def connect(self):
        self.battle_id = self.scope["url_route"]["kwargs"]["battle_id"]
        self.group_name = spectator_group(self.battle_id)
        self._last_like = 0.0
        self._last_emote = 0.0

        user = self.scope.get("user")
        if user is None or not user.is_authenticated:
            await self.close(code=4401)
            return

        if not await _battle_is_watchable(self.battle_id):
            await self.close(code=4404)
            return

        if await _is_participant(self.battle_id, user.id):
            await self.close(code=4403)
            return

        self.username = user.display_name or user.username
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if getattr(self, "group_name", None):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        event_type = content.get("event") or content.get("type")
        now = time.monotonic()

        if event_type == "PING":
            await self.send_json({"event": "PONG", "payload": {}})
            return

        if event_type == "SPECTATOR_EMOTE":
            if now - self._last_emote < EMOTE_MIN_INTERVAL_SECONDS:
                return
            self._last_emote = now
            emote = (content.get("payload") or {}).get("emote")
            if not isinstance(emote, str) or not emote.strip():
                return
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": "SPECTATOR_EMOTE",
                    "payload": {
                        # Server-supplied so a client cannot impersonate someone.
                        "username": self.username,
                        "emote": emote[:MAX_EMOTE_CHARS],
                    },
                },
            )
            return

        if event_type == "SPECTATOR_LIKE":
            if now - self._last_like < LIKE_MIN_INTERVAL_SECONDS:
                return
            self._last_like = now
            count = await _increment_spectator_likes(int(self.battle_id))
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": "SPECTATOR_LIKE_COUNT",
                    "payload": {"count": count, "battle_id": int(self.battle_id)},
                },
            )

    async def broadcast_event(self, event):
        await self.send_json(
            {"event": event["event"], "payload": event.get("payload", {})}
        )
