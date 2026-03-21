from urllib.parse import parse_qs
import jwt
from django.contrib.auth.models import AnonymousUser
from channels.db import database_sync_to_async
from accounts.models import User

@database_sync_to_async
def get_user_from_token(token):
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        clerk_id = payload.get('sub')
        if not clerk_id:
            return AnonymousUser()
        return User.objects.get(clerk_id=clerk_id)
    except User.DoesNotExist:
        return AnonymousUser()
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