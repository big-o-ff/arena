from __future__ import annotations

import logging

from channels.generic.websocket import AsyncJsonWebsocketConsumer

logger = logging.getLogger(__name__)

ADMIN_ROLES = ("admin", "superadmin")


class LobbyConsumer(AsyncJsonWebsocketConsumer):
    """
    Per-user lobby socket: battle invites, accept/decline, and expiry.

    Authentication is handled once by `accounts.middleware.JWTAuthMiddleware`,
    which verifies the Clerk signature and populates `scope["user"]`.
    """

    async def connect(self):
        user = self.scope.get("user")
        if user is None or not user.is_authenticated:
            await self.close(code=4401)
            return

        self.user_group = f"user_{user.id}"
        await self.channel_layer.group_add(self.user_group, self.channel_name)

        # Only staff join the monitor group. It used to be joined by everyone,
        # which turned it into an open broadcast channel to every logged-in user.
        self.admin_group = (
            "admin_monitor" if getattr(user, "role", "") in ADMIN_ROLES else None
        )
        if self.admin_group:
            await self.channel_layer.group_add(self.admin_group, self.channel_name)

        await self.accept()

    async def disconnect(self, code):
        if getattr(self, "user_group", None):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
        if getattr(self, "admin_group", None):
            await self.channel_layer.group_discard(self.admin_group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        # Clients are listeners here. Relaying arbitrary client payloads into a
        # group is how the old implementation let any user broadcast to everyone;
        # admin monitor updates must originate server-side.
        if content.get("event") == "PING" or content.get("type") == "PING":
            await self.send_json({"event": "PONG", "payload": {}})

    async def broadcast_event(self, event):
        await self.send_json(
            {
                "event": event["event"],
                "payload": event.get("payload", {}),
            }
        )

    # ------------------------------------------------------------------
    # Invite lifecycle events (sent to `user_<id>` groups from views/tasks)
    # ------------------------------------------------------------------
    async def battle_invite(self, event):
        await self.send_json(event)

    async def invite_declined(self, event):
        await self.send_json(event)

    async def battle_starting(self, event):
        await self.send_json(event)

    async def invite_expired(self, event):
        await self.send_json(event)
