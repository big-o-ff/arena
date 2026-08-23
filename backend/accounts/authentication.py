"""
Clerk-backed authentication for DRF.

Token signatures are verified in `accounts.clerk`; this module only maps a set of
verified claims onto a Django user. Nothing here may accept an unverified token.
"""
from __future__ import annotations

import logging
import re

from django.db import IntegrityError, transaction
from rest_framework import authentication, exceptions

from accounts.clerk import (
    ClerkConfigurationError,
    ClerkTokenError,
    verify_clerk_token,
)
from accounts.models import User

logger = logging.getLogger(__name__)

USERNAME_RE = re.compile(r"[^a-z0-9]")


def _slugify_username(value: str) -> str:
    return USERNAME_RE.sub("", (value or "").lower())


def _preferred_username(payload: dict, display_name: str, clerk_id: str) -> str:
    """Best human-readable username available from the claims, before uniquing."""
    for candidate in (payload.get("username"), payload.get("preferred_username")):
        slug = _slugify_username(candidate or "")
        if slug:
            return slug

    slug = _slugify_username(display_name)
    if slug:
        return slug

    email = payload.get("email") or ""
    slug = _slugify_username(email.split("@")[0]) if email else ""
    return slug or _slugify_username(clerk_id) or "player"


def _unique_username(base: str) -> str:
    """Append a numeric suffix until the username is free."""
    candidate = base[:150] or "player"
    suffix = 1
    while User.objects.filter(username=candidate).exists():
        tail = str(suffix)
        candidate = f"{base[: 150 - len(tail)]}{tail}"
        suffix += 1
    return candidate


def resolve_user_from_clerk_claims(payload: dict) -> User | None:
    """
    Return the Django user for a set of *already verified* Clerk claims,
    creating one on first sight. Returns None if the claims carry no subject.
    """
    clerk_id = payload.get("sub")
    if not clerk_id:
        return None

    existing = User.objects.filter(clerk_id=clerk_id).first()
    if existing is not None:
        return existing

    first_name = (payload.get("first_name") or payload.get("given_name") or "").strip()
    last_name = (payload.get("last_name") or payload.get("family_name") or "").strip()
    display_name = f"{first_name} {last_name}".strip()

    base_username = _preferred_username(payload, display_name, clerk_id)
    defaults = {
        "display_name": display_name or f"Player_{clerk_id[:8]}",
        "email": payload.get("email") or "",
        "first_name": first_name,
        "last_name": last_name,
        "role": User.Role.PLAYER,
    }

    # Two concurrent first-requests for the same user can race here, as can two
    # different users landing on the same base username. Retry on either.
    for _ in range(5):
        try:
            with transaction.atomic():
                return User.objects.create(
                    clerk_id=clerk_id,
                    username=_unique_username(base_username),
                    **defaults,
                )
        except IntegrityError:
            existing = User.objects.filter(clerk_id=clerk_id).first()
            if existing is not None:
                return existing  # lost the race on clerk_id — the other side won

    logger.error("Could not allocate a username for Clerk user %s", clerk_id)
    return None


class ClerkAuthentication(authentication.BaseAuthentication):
    """DRF authentication class for `Authorization: Bearer <clerk session jwt>`."""

    keyword = "Bearer"

    def authenticate(self, request):
        auth_header = request.headers.get("Authorization") or ""
        if not auth_header.startswith(f"{self.keyword} "):
            return None  # let the next authenticator try

        token = auth_header[len(self.keyword) + 1 :].strip()

        try:
            payload = verify_clerk_token(token)
        except ClerkTokenError as exc:
            raise exceptions.AuthenticationFailed(str(exc))
        except ClerkConfigurationError:
            logger.exception("Clerk verification is not configured")
            raise  # 500, not 401 — this is our misconfiguration, not their token

        user = resolve_user_from_clerk_claims(payload)
        if user is None:
            raise exceptions.AuthenticationFailed("Token has no usable subject")
        if not user.is_active:
            raise exceptions.AuthenticationFailed("User account is disabled")

        return (user, token)

    def authenticate_header(self, request):
        return self.keyword
