"""
Account endpoints.

Identity is owned entirely by Clerk. The password-based register/login/token
views that used to live here were unreachable from the UI and provided a second,
weaker way into the same username namespace, so they have been removed.
"""
from __future__ import annotations

import logging
import re

import svix
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .authentication import slugify_username
from .models import User
from .serializers import UserProfileSerializer

logger = logging.getLogger(__name__)


class ProfileView(generics.RetrieveAPIView):
    queryset = User.objects.filter(is_active=True)
    serializer_class = UserProfileSerializer
    lookup_field = "username"
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        # Usernames are stored slugified-lowercase, so an exact-match lookup made
        # the challenge box reject the very name the leaderboard displays the
        # moment a player typed it with its original capitalisation.
        return generics.get_object_or_404(
            self.get_queryset(), username__iexact=self.kwargs["username"]
        )


class LeaderboardView(generics.ListAPIView):
    queryset = (
        User.objects.filter(is_active=True, role__in=["player", "spectator"])
        .order_by("-total_wins", "total_losses", "id")
    )
    serializer_class = UserProfileSerializer
    permission_classes = [permissions.AllowAny]


def _user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "rating": user.rating,
        "rank_name": user.rank_name,
        "clerk_id": user.clerk_id,
        "role": user.role,
        "total_wins": user.total_wins,
        "total_losses": user.total_losses,
    }


class AuthMeView(APIView):
    """
    GET  — the caller's profile.
    POST — backfill profile fields Clerk holds but the session JWT may omit.

    POST only ever fills in placeholders: it will not rename a user who already
    has a real username, and it cannot be used to take someone else's.
    """

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        return Response(_user_payload(request.user))

    def post(self, request, *args, **kwargs):
        user = request.user

        email = (request.data.get("email") or "").strip()
        first_name = (request.data.get("first_name") or "").strip()
        last_name = (request.data.get("last_name") or "").strip()

        real_display = f"{first_name} {last_name}".strip() or (
            email.split("@")[0] if email else ""
        )
        name_slug = re.sub(r"[^a-z0-9]", "", real_display.lower())
        if not name_slug and email:
            name_slug = re.sub(r"[^a-z0-9]", "", email.split("@")[0].lower())

        # A first-sight user gets `slugify_username(clerk_id)` when the session
        # JWT carries no name/email claims — which is the default for Clerk OAuth
        # sessions. Comparing against the raw clerk_id alone never matched that,
        # so every such account kept "user3ezl8ghujxekce5o00c404u4qzv" forever:
        # unreadable on the leaderboard and impossible for an opponent to type
        # into the challenge box.
        username_is_placeholder = user.username in (
            user.clerk_id,
            slugify_username(user.clerk_id),
        )
        display_is_placeholder = (
            not user.display_name
            or str(user.display_name).startswith("Player_")
            or user.display_name == user.clerk_id
        )

        updates: list[str] = []
        try:
            with transaction.atomic():
                if username_is_placeholder and name_slug:
                    candidate = name_slug
                    suffix = 1
                    while (
                        User.objects.exclude(pk=user.pk)
                        .filter(username=candidate)
                        .exists()
                    ):
                        candidate = f"{name_slug}{suffix}"
                        suffix += 1
                    user.username = candidate
                    updates.append("username")

                if display_is_placeholder and real_display:
                    user.display_name = real_display
                    updates.append("display_name")

                if email and user.email != email:
                    user.email = email
                    updates.append("email")
                if first_name and user.first_name != first_name:
                    user.first_name = first_name
                    updates.append("first_name")
                if last_name and user.last_name != last_name:
                    user.last_name = last_name
                    updates.append("last_name")

                if updates:
                    user.save(update_fields=updates)
        except IntegrityError:
            logger.warning("Profile backfill collided for user %s", user.pk)
            user.refresh_from_db()

        return Response(_user_payload(user))


@method_decorator(csrf_exempt, name="dispatch")
class ClerkWebhookView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def post(self, request, *args, **kwargs):
        secret = getattr(settings, "CLERK_WEBHOOK_SECRET", "")
        if not secret:
            # Returning 200 stops Clerk retrying; profile sync still happens via
            # the verified JWT + /api/auth/me/.
            return Response({"detail": "webhook_disabled"}, status=status.HTTP_200_OK)

        try:
            evt = svix.Webhook(secret).verify(request.body, request.headers)
        except Exception as exc:
            logger.warning("Rejected Clerk webhook: %s", exc)
            return Response(
                {"detail": "invalid signature"}, status=status.HTTP_400_BAD_REQUEST
            )

        evt_type = evt.get("type")
        data = evt.get("data", {})
        clerk_id = data.get("id")
        if not clerk_id:
            return Response(
                {"detail": "missing id"}, status=status.HTTP_400_BAD_REQUEST
            )

        email = ""
        if data.get("email_addresses"):
            email = data["email_addresses"][0].get("email_address", "") or ""
        clerk_username = (data.get("username") or "").strip()
        first_name = data.get("first_name") or ""
        last_name = data.get("last_name") or ""
        display = (
            clerk_username
            or f"{first_name} {last_name}".strip()
            or (email.split("@")[0] if email else "")
        )

        if evt_type == "user.created":
            User.objects.update_or_create(
                clerk_id=clerk_id,
                defaults={
                    "username": clerk_username or clerk_id,
                    "email": email,
                    "first_name": first_name,
                    "last_name": last_name,
                    "display_name": display or clerk_id,
                },
            )

        elif evt_type == "user.updated":
            user = User.objects.filter(clerk_id=clerk_id).first()
            if user is None:
                return Response(status=status.HTTP_200_OK)

            changed: list[str] = []
            # Only adopt a username Clerk actually has. Writing `username or
            # clerk_id` here reset every OAuth user's readable name back to their
            # raw Clerk ID on each update event.
            if clerk_username and clerk_username != user.username:
                if not User.objects.exclude(pk=user.pk).filter(
                    username=clerk_username
                ).exists():
                    user.username = clerk_username
                    changed.append("username")
            if email and user.email != email:
                user.email = email
                changed.append("email")
            if first_name and user.first_name != first_name:
                user.first_name = first_name
                changed.append("first_name")
            if last_name and user.last_name != last_name:
                user.last_name = last_name
                changed.append("last_name")
            if display and (
                not user.display_name or user.display_name == user.clerk_id
            ):
                user.display_name = display
                changed.append("display_name")

            if changed:
                try:
                    user.save(update_fields=changed)
                except IntegrityError:
                    logger.warning("Clerk update collided for %s", clerk_id)

        elif evt_type == "user.deleted":
            User.objects.filter(clerk_id=clerk_id).update(is_active=False)

        return Response(status=status.HTTP_200_OK)
