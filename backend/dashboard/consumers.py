from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer


class LobbyConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        import jwt
        from channels.db import database_sync_to_async
        from accounts.models import User

        query_string = self.scope.get('query_string', b'').decode()
        token = None
        for param in query_string.split('&'):
            if param.startswith('token='):
                token = param.split('=')[1]
                break

        if not token:
            await self.close()
            return

        try:
            payload = jwt.decode(token, options={"verify_signature": False})
            clerk_id = payload.get('sub')
            if not clerk_id:
                await self.close()
                return
            
            user = await self.get_user(clerk_id)
            if not user:
                await self.close()
                return
                
            self.scope['user'] = user
        except Exception:
            await self.close()
            return

        print(f"LobbyConsumer connected user: {self.scope['user'].username}")
            
        self.user_group = f"user_{self.scope['user'].id}"
        self.admin_group = "admin_monitor"
        
        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.channel_layer.group_add(self.admin_group, self.channel_name)
        await self.accept()

    @database_sync_to_async
    def get_user(self, clerk_id):
        from accounts.models import User
        try:
            res = User.objects.filter(clerk_id=clerk_id).first()
            if res:
                return res
            # Backward fallback if clerk_id is empty but username matches
            return User.objects.get(username=clerk_id)
        except User.DoesNotExist:
            return None

    async def disconnect(self, code):
        if hasattr(self, 'user_group'):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
            await self.channel_layer.group_discard(self.admin_group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        event_type = content.get("event")
        payload = content.get("payload", {})

        await self.channel_layer.group_send(
            self.admin_group,
            {
                "type": "broadcast.event",
                "event": event_type or "ADMIN_MONITOR_UPDATE",
                "payload": payload,
            },
        )

    async def broadcast_event(self, event):
        await self.send_json(
            {
                "event": event["event"],
                "payload": event.get("payload", {}),
            }
        )

    # ------------------------------------------------------------------
    # Invite System Event Handlers
    # ------------------------------------------------------------------
    async def battle_invite(self, event):
        await self.send_json(event)

    async def invite_declined(self, event):
        await self.send_json(event)

    async def battle_starting(self, event):
        await self.send_json(event)

    async def invite_expired(self, event):
        await self.send_json(event)

