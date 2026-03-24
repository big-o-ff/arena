from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.db.models import F


@database_sync_to_async
def _increment_spectator_likes(battle_id: int) -> int:
    from battles.models import Battle

    Battle.objects.filter(id=battle_id).update(
        spectator_likes=F("spectator_likes") + 1
    )
    return Battle.objects.get(id=battle_id).spectator_likes


class SpectatorConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.battle_id = self.scope["url_route"]["kwargs"]["battle_id"]
        self.group_name = f"battle_{self.battle_id}"

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        event_type = content.get("event")
        payload = content.get("payload", {})

        if event_type == "SPECTATOR_EMOTE":
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "broadcast.event",
                    "event": "SPECTATOR_EMOTE",
                    "payload": payload,
                },
            )
        elif event_type == "SPECTATOR_LIKE":
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
            {
                "event": event["event"],
                "payload": event.get("payload", {}),
            }
        )

