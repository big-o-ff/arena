from urllib.parse import parse_qs

import jwt
from django.contrib.auth.models import AnonymousUser
from channels.db import database_sync_to_async

from accounts.authentication import resolve_user_from_clerk_jwt_payload


@database_sync_to_async
def get_user_from_token(token):
    """Match REST ClerkAuthentication — create user on first WS connect if needed."""
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        user = resolve_user_from_clerk_jwt_payload(payload)
        return user if user is not None else AnonymousUser()
    except Exception:
        return AnonymousUser()

class JWTAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        query_string = parse_qs(scope['query_string'].decode())
        token_list = query_string.get('token', [None])
        token = token_list[0] if token_list else None
        if token:
            scope['user'] = await get_user_from_token(token)
        else:
            scope['user'] = AnonymousUser()
        return await self.app(scope, receive, send)

def JWTAuthMiddlewareStack(inner):
    return JWTAuthMiddleware(inner)