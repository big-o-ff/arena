"""
Username backfill and profile lookup.

A Clerk session JWT normally carries only `sub`, so first-sight users were
created with `slugify_username(clerk_id)` — e.g. "user3ezl8ghujxekce5o00c404u4qzv".
`/api/auth/me/` is supposed to replace that with a readable name once the client
posts the profile, but its placeholder test compared against the *raw* clerk_id,
which the slug never equals. Every OAuth account therefore kept the unreadable
name permanently: the leaderboard showed a display name that could not be typed
into the challenge box, and the challenge box demanded a name shown nowhere.
"""
from __future__ import annotations

import pytest
from rest_framework.test import APIClient

from accounts.models import User


@pytest.fixture
def api_client():
    return APIClient()


@pytest.fixture
def make_user(db):
    counter = {"n": 0}

    def _make(**kwargs):
        counter["n"] += 1
        n = counter["n"]
        defaults = {
            "username": f"player{n}",
            "clerk_id": f"user_{n}",
            "display_name": f"Player {n}",
            "role": User.Role.PLAYER,
        }
        defaults.update(kwargs)
        return User.objects.create(**defaults)

    return _make


@pytest.fixture
def clerk_user(db):
    """A user as `resolve_user_from_clerk_claims` creates one from a bare JWT."""
    clerk_id = "user_3EZl8ghUJXEKcE5O00c404u4qzv"
    return User.objects.create(
        clerk_id=clerk_id,
        username="user3ezl8ghujxekce5o00c404u4qzv",  # slugify_username(clerk_id)
        display_name="Player_user_3EZ",
        role=User.Role.PLAYER,
    )


@pytest.mark.django_db
class TestUsernameBackfill:
    def test_slugified_clerk_id_is_replaced_with_a_readable_name(
        self, api_client, clerk_user
    ):
        api_client.force_authenticate(user=clerk_user)
        response = api_client.post(
            "/api/auth/me/",
            {"email": "tejaansh@example.com", "first_name": "Tejaansh", "last_name": "Sara"},
            format="json",
        )
        assert response.status_code == 200
        assert response.data["username"] == "tejaanshsara"
        assert response.data["display_name"] == "Tejaansh Sara"

    def test_a_real_username_is_never_overwritten(self, api_client, make_user):
        chosen = make_user(username="zerocool", clerk_id="user_zc", display_name="Zero Cool")
        api_client.force_authenticate(user=chosen)
        response = api_client.post(
            "/api/auth/me/",
            {"email": "z@example.com", "first_name": "Dade", "last_name": "Murphy"},
            format="json",
        )
        assert response.status_code == 200
        assert response.data["username"] == "zerocool"

    def test_backfill_does_not_steal_a_taken_username(
        self, api_client, clerk_user, make_user
    ):
        make_user(username="tejaanshsara", clerk_id="user_other")
        api_client.force_authenticate(user=clerk_user)
        response = api_client.post(
            "/api/auth/me/",
            {"email": "t@example.com", "first_name": "Tejaansh", "last_name": "Sara"},
            format="json",
        )
        assert response.status_code == 200
        assert response.data["username"] == "tejaanshsara1"


@pytest.mark.django_db
class TestProfileLookup:
    def test_lookup_is_case_insensitive(self, api_client, make_user):
        """The leaderboard renders display names; players type what they see."""
        user = make_user(username="tejaanshsara", display_name="Tejaansh Sara")
        api_client.force_authenticate(user=user)
        response = api_client.get("/api/profile/TejaanshSara/")
        assert response.status_code == 200
        assert response.data["username"] == "tejaanshsara"

    def test_unknown_user_404s_without_leaking_orm_phrasing(
        self, api_client, make_user
    ):
        user = make_user()
        api_client.force_authenticate(user=user)
        response = api_client.get("/api/profile/nobodyhere/")
        assert response.status_code == 404
        assert "matches the given query" not in str(response.data).lower()
