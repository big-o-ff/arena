from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from accounts.models import User
from .models import Battle


class BattleConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.battle_id = self.scope["url_route"]["kwargs"]["battle_id"]
        self.group_name = f"battle_{self.battle_id}"

        # Store the authenticated user id for later use in code_update routing
        user = self.scope.get("user")
        self.user_id = user.id if user and user.is_authenticated else None

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "broadcast.event",
                "event": "PLAYER_JOINED",
                "payload": {"channel": self.channel_name},
            },
        )

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "broadcast.event",
                "event": "PLAYER_DISCONNECTED",
                "payload": {"channel": self.channel_name},
            },
        )

    async def receive_json(self, content, **kwargs):
        event_type = content.get("type") or content.get("event")
        payload = content.get("payload", {})

        if event_type == "PING":
            await self.send_json({"event": "PONG", "payload": {}})
            return

        # ------------------------------------------------------------------
        # CODE_UPDATE — debounced keystrokes from the editor
        # Broadcast to the group as OPPONENT_CODE so the other player's
        # blurred feed updates in real-time.
        # ------------------------------------------------------------------
        if event_type == "code_update":
            code = content.get("code", "")
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "opponent.code",      # → self.opponent_code()
                    "player_id": self.user_id,
                    "code": code,
                },
            )
            return

        if event_type in {
            "CODE_SUBMITTED",
            "CHAT_MESSAGE",
        }:
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": event_type,
                    "payload": payload,
                },
            )

    # ------------------------------------------------------------------
    # Generic broadcast handler — used by all server→client events
    # ------------------------------------------------------------------
    async def broadcast_event(self, event):
        await self.send_json(
            {
                "event": event["event"],
                "payload": event.get("payload", {}),
            }
        )

    # ------------------------------------------------------------------
    # opponent_code — relays editor keystrokes to the opponent
    # Each client receives this; in the frontend, if player_id !== me
    # the blurred opponent panel re-renders.
    # ------------------------------------------------------------------
    async def opponent_code(self, event):
        await self.send_json(
            {
                "event": "OPPONENT_CODE",
                "payload": {
                    "player_id": event["player_id"],
                    "code": event["code"],
                },
            }
        )

    # ------------------------------------------------------------------
    # Targeted event handlers (Celery tasks send these via channel_layer)
    # ------------------------------------------------------------------
    # These all delegate to broadcast_event. We define them explicitly
    # so Django Channels can route "type": "fog_start" → self.fog_start(), etc.

    async def fog_start(self, event):
        """Fog of War start — all participants see overlay."""
        await self.send_json({
            "event": "FOG_START",
            "payload": {"battle_id": self.battle_id},
        })

    async def fog_end(self, event):
        """Fog of War end — remove overlay."""
        await self.send_json({
            "event": "FOG_END",
            "payload": {"battle_id": self.battle_id},
        })

    async def gc_start(self, event):
        """Garbage Collection start — targeted at one player."""
        await self.send_json({
            "event": "GC_START",
            "payload": {
                "attacker_id": event.get("attacker_id"),
                "target_user_id": event.get("target_user_id"),
            },
        })

    async def gc_end(self, event):
        """Garbage Collection end."""
        await self.send_json({
            "event": "GC_END",
            "payload": {
                "target_user_id": event.get("target_user_id"),
            },
        })
