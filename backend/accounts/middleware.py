"""Channels middleware that authenticates WebSocket connections with a Clerk JWT."""
from __future__ import annotations

import logging
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser

from accounts.clerk import ClerkConfigurationError, ClerkTokenError, verify_clerk_token
from accounts.authentication import resolve_user_from_clerk_claims

logger = logging.getLogger(__name__)


@database_sync_to_async
def _resolve(token: str):
    """Verify the token and return the matching user, or AnonymousUser."""
    try:
        payload = verify_clerk_token(token)
    except ClerkTokenError as exc:
        logger.debug("Rejected WebSocket token: %s", exc)
        return AnonymousUser()
    except ClerkConfigurationError:
        logger.exception("Clerk verification is not configured — refusing WS auth")
        return AnonymousUser()

    user = resolve_user_from_clerk_claims(payload)
    if user is None or not user.is_active:
        return AnonymousUser()
    return user


class JWTAuthMiddleware:
    """Populates `scope["user"]` from the `?token=` query parameter."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        token = None
        if scope.get("type") == "websocket":
            query = parse_qs(scope.get("query_string", b"").decode())
            values = query.get("token") or []
            token = values[0] if values else None

        scope["user"] = await _resolve(token) if token else AnonymousUser()
        return await self.app(scope, receive, send)
