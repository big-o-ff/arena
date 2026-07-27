from __future__ import annotations

import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .events import code_activity, player_group, spectator_group

logger = logging.getLogger(__name__)

# Guard against a client streaming an unbounded buffer into the channel layer.
MAX_CODE_CHARS = 200 * 1024
MAX_CHAT_CHARS = 500


@database_sync_to_async
def _battle_role(battle_id: str, user_id: int) -> str | None:
    """Return 'player1'/'player2' if this user is in the battle, else None."""
    from .models import Battle

    battle = Battle.objects.filter(pk=battle_id).only(
        "id", "player1_id", "player2_id"
    ).first()
    if battle is None:
        return None
    if battle.player1_id == user_id:
        return "player1"
    if battle.player2_id == user_id:
        return "player2"
    return None


class BattleConsumer(AsyncJsonWebsocketConsumer):
    """
    The in-match socket. Players only.

    It used to accept any connection to any battle id, which meant an outsider
    could join the group, receive both players' code, and inject events.
    """

    async def connect(self):
        self.battle_id = self.scope["url_route"]["kwargs"]["battle_id"]
        self.group_name = player_group(self.battle_id)

        user = self.scope.get("user")
        if user is None or not user.is_authenticated:
            await self.close(code=4401)  # unauthenticated
            return

        self.user_id = user.id
        self.role = await _battle_role(self.battle_id, user.id)
        if self.role is None:
            await self.close(code=4403)  # not a participant
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "broadcast.event",
                "event": "PLAYER_JOINED",
                "payload": {"player_id": self.user_id},
            },
        )

    async def disconnect(self, code):
        if not getattr(self, "group_name", None) or getattr(self, "role", None) is None:
            return
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "broadcast.event",
                "event": "PLAYER_DISCONNECTED",
                "payload": {"player_id": self.user_id},
            },
        )

    async def receive_json(self, content, **kwargs):
        event_type = content.get("type") or content.get("event")

        if event_type == "PING":
            await self.send_json({"event": "PONG", "payload": {}})
            return

        if event_type == "code_update":
            code = content.get("code")
            if not isinstance(code, str) or len(code) > MAX_CODE_CHARS:
                return

            # Opponent gets stats only — never the buffer itself.
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": "OPPONENT_ACTIVITY",
                    "payload": {"player_id": self.user_id, **code_activity(code)},
                },
            )
            # Spectators get the real thing.
            await self.channel_layer.group_send(
                spectator_group(self.battle_id),
                {
                    "type": "broadcast.event",
                    "event": "OPPONENT_CODE",
                    "payload": {"player_id": self.user_id, "code": code},
                },
            )
            return

        if event_type == "CHAT_MESSAGE":
            message = (content.get("payload") or {}).get("message")
            if not isinstance(message, str) or not message.strip():
                return
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": "CHAT_MESSAGE",
                    "payload": {
                        "player_id": self.user_id,
                        "message": message[:MAX_CHAT_CHARS],
                    },
                },
            )

    async def broadcast_event(self, event):
        """Single server→client delivery path for every battle event."""
        await self.send_json(
            {"event": event["event"], "payload": event.get("payload", {})}
        )
