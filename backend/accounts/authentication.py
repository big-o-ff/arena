import jwt
from rest_framework import authentication, exceptions

from accounts.models import User


def resolve_user_from_clerk_jwt_payload(payload: dict) -> User | None:
    """
    Create or update the Django user from Clerk JWT claims.
    Same rules as ClerkAuthentication — used by REST and WebSocket auth.
    """
    import re as _re

    clerk_id = payload.get("sub")
    if not clerk_id:
        return None

    # Prefer a human-readable username over the Clerk ID.
    first_name = (payload.get("first_name") or payload.get("given_name") or "").strip()
    last_name = (payload.get("last_name") or payload.get("family_name") or "").strip()
    display_name = f"{first_name} {last_name}".strip()

    name_slug = _re.sub(r"[^a-z0-9]", "", display_name.lower().replace(" ", ""))
    username = (
        payload.get("username")
        or payload.get("preferred_username")
        or name_slug
        or clerk_id
    )

    from django.db import IntegrityError

    try:
        user, created = User.objects.get_or_create(
            clerk_id=clerk_id,
            defaults={
                "username": username,
                "display_name": display_name or f"Player_{clerk_id[:8]}",
                "role": "player",
            },
        )
        return user
    except IntegrityError:
        user, created = User.objects.get_or_create(
            clerk_id=clerk_id,
            defaults={
                "username": f"{username}_{clerk_id[-4:]}",
                "display_name": display_name or f"Player_{clerk_id[:8]}",
                "role": "player",
            },
        )
        return user


class ClerkAuthentication(authentication.BaseAuthentication):
    def authenticate(self, request):
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return None

        token = auth_header.split(" ")[1]
        try:
            payload = jwt.decode(token, options={"verify_signature": False})
            user = resolve_user_from_clerk_jwt_payload(payload)
            if not user:
                raise exceptions.AuthenticationFailed("Invalid token payload")

            return (user, token)

        except jwt.InvalidTokenError:
            raise exceptions.AuthenticationFailed("Invalid Clerk token")
        except Exception as e:
            raise exceptions.AuthenticationFailed(str(e))