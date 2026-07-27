"""
Clerk token verification.

The single most important property in this codebase: a token this server did not
receive from Clerk must never authenticate anyone. The original implementation
called `jwt.decode(..., options={"verify_signature": False})`, so any attacker
who knew (or guessed) a `sub` could impersonate that user — including an admin.
"""
from __future__ import annotations

import datetime as dt
import json

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from accounts import clerk
from accounts.authentication import (
    ClerkAuthentication,
    resolve_user_from_clerk_claims,
)
from accounts.models import User

ISSUER = "https://test-app.clerk.accounts.dev"


def _keypair():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks_for(private_key, kid="test-key-1"):
    public_numbers = private_key.public_key().public_numbers()

    def b64(value: int) -> str:
        import base64

        length = (value.bit_length() + 7) // 8
        return (
            base64.urlsafe_b64encode(value.to_bytes(length, "big"))
            .decode()
            .rstrip("=")
        )

    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": kid,
                "use": "sig",
                "alg": "RS256",
                "n": b64(public_numbers.n),
                "e": b64(public_numbers.e),
            }
        ]
    }


def _make_token(private_key, *, kid="test-key-1", issuer=ISSUER, sub="user_abc", **extra):
    now = dt.datetime.now(dt.timezone.utc)
    claims = {
        "sub": sub,
        "iss": issuer,
        "iat": now,
        "exp": now + dt.timedelta(minutes=5),
    }
    claims.update(extra)
    return jwt.encode(claims, private_key, algorithm="RS256", headers={"kid": kid})


@pytest.fixture
def signing_key():
    return _keypair()


@pytest.fixture(autouse=True)
def _reset_jwks_cache():
    clerk.reset_jwk_client_cache()
    yield
    clerk.reset_jwk_client_cache()


@pytest.fixture
def stub_jwks(monkeypatch, signing_key):
    """Serve our own JWKS instead of reaching out to Clerk."""
    payload = json.dumps(_jwks_for(signing_key)).encode()

    class _Response:
        def read(self):
            return payload

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    monkeypatch.setattr(
        "jwt.jwks_client.urllib.request.urlopen", lambda *a, **k: _Response()
    )
    return signing_key


class TestVerifyClerkToken:
    def test_accepts_a_properly_signed_token(self, stub_jwks, signing_key):
        token = _make_token(signing_key, sub="user_valid")
        claims = clerk.verify_clerk_token(token)
        assert claims["sub"] == "user_valid"

    def test_rejects_a_token_signed_by_someone_else(self, stub_jwks):
        """The core regression: a self-signed token must not authenticate."""
        attacker_key = _keypair()
        forged = _make_token(attacker_key, sub="user_admin")
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(forged)

    def test_rejects_an_unsigned_token(self, stub_jwks):
        forged = jwt.encode({"sub": "user_admin"}, key="", algorithm="none")
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(forged)

    def test_rejects_a_symmetric_algorithm_swap(self, stub_jwks):
        """HS256 signed with the public key must not be accepted as valid."""
        forged = jwt.encode(
            {"sub": "user_admin", "iss": ISSUER, "exp": 9999999999, "iat": 1},
            "secret",
            algorithm="HS256",
            headers={"kid": "test-key-1"},
        )
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(forged)

    def test_rejects_an_expired_token(self, stub_jwks, signing_key):
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        token = jwt.encode(
            {"sub": "user_x", "iss": ISSUER, "iat": past, "exp": past},
            signing_key,
            algorithm="RS256",
            headers={"kid": "test-key-1"},
        )
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(token)

    def test_rejects_a_foreign_issuer(self, stub_jwks, signing_key):
        token = _make_token(signing_key, issuer="https://evil.example.com")
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(token)

    def test_rejects_an_unknown_key_id(self, stub_jwks, signing_key):
        token = _make_token(signing_key, kid="some-other-key")
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token(token)

    def test_rejects_empty_token(self, stub_jwks):
        with pytest.raises(clerk.ClerkTokenError):
            clerk.verify_clerk_token("")


def test_missing_issuer_is_a_configuration_error_not_an_auth_success(settings):
    """An unconfigured server must fail closed, never fall back to trusting."""
    settings.CLERK_ISSUER = ""
    clerk.reset_jwk_client_cache()
    with pytest.raises(clerk.ClerkConfigurationError):
        clerk.verify_clerk_token("anything")


@pytest.mark.django_db
class TestUserResolution:
    def test_creates_a_user_on_first_sight(self):
        user = resolve_user_from_clerk_claims(
            {"sub": "user_1", "first_name": "Ada", "last_name": "Lovelace"}
        )
        assert user.clerk_id == "user_1"
        assert user.username == "adalovelace"
        assert user.display_name == "Ada Lovelace"
        assert user.role == User.Role.PLAYER

    def test_returns_the_same_user_on_later_calls(self):
        first = resolve_user_from_clerk_claims({"sub": "user_1", "username": "ada"})
        second = resolve_user_from_clerk_claims({"sub": "user_1", "username": "ada"})
        assert first.pk == second.pk
        assert User.objects.filter(clerk_id="user_1").count() == 1

    def test_does_not_escalate_an_existing_user_role(self):
        User.objects.create(
            clerk_id="user_admin",
            username="root",
            display_name="Root",
            role=User.Role.ADMIN,
        )
        user = resolve_user_from_clerk_claims({"sub": "user_admin"})
        assert user.role == User.Role.ADMIN
        assert user.username == "root"  # claims must not rename an existing user

    def test_deduplicates_colliding_usernames(self):
        a = resolve_user_from_clerk_claims({"sub": "user_a", "username": "sam"})
        b = resolve_user_from_clerk_claims({"sub": "user_b", "username": "sam"})
        assert a.username == "sam"
        assert b.username == "sam1"

    def test_returns_none_without_a_subject(self):
        assert resolve_user_from_clerk_claims({"first_name": "No Sub"}) is None


@pytest.mark.django_db
class TestClerkAuthentication:
    def _request(self, rf, header):
        request = rf.get("/api/auth/me/")
        if header is not None:
            request.META["HTTP_AUTHORIZATION"] = header
        return request

    def test_no_header_defers_to_the_next_authenticator(self, rf):
        assert ClerkAuthentication().authenticate(self._request(rf, None)) is None

    def test_non_bearer_header_is_ignored(self, rf):
        request = self._request(rf, "Token abc123")
        assert ClerkAuthentication().authenticate(request) is None

    def test_forged_bearer_token_is_rejected(self, rf, stub_jwks):
        from rest_framework import exceptions

        forged = _make_token(_keypair(), sub="user_admin")
        request = self._request(rf, f"Bearer {forged}")
        with pytest.raises(exceptions.AuthenticationFailed):
            ClerkAuthentication().authenticate(request)

    def test_valid_token_authenticates(self, rf, stub_jwks, signing_key):
        token = _make_token(signing_key, sub="user_ok", username="okuser")
        request = self._request(rf, f"Bearer {token}")
        user, returned = ClerkAuthentication().authenticate(request)
        assert user.clerk_id == "user_ok"
        assert returned == token

    def test_deactivated_user_is_rejected(self, rf, stub_jwks, signing_key):
        from rest_framework import exceptions

        User.objects.create(
            clerk_id="user_gone",
            username="gone",
            display_name="Gone",
            is_active=False,
        )
        token = _make_token(signing_key, sub="user_gone")
        request = self._request(rf, f"Bearer {token}")
        with pytest.raises(exceptions.AuthenticationFailed):
            ClerkAuthentication().authenticate(request)
