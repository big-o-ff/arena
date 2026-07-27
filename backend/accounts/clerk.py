"""
Clerk session-token verification.

Every entry point that turns a Clerk JWT into a Django user MUST go through
`verify_clerk_token`. It validates the RS256 signature against Clerk's published
JWKS, plus `iss`/`exp`/`nbf`, so a self-signed token cannot impersonate a user.

Configuration (backend/.env):
    CLERK_ISSUER    required. Your Clerk Frontend API origin, e.g.
                    https://your-app.clerk.accounts.dev  (this is the `iss`
                    claim of the tokens Clerk mints for you).
    CLERK_AUDIENCE  optional. Only set it if you configured an `aud` claim in
                    your Clerk JWT template.

The issuer is pinned from settings rather than read off the token, because
trusting the token's own `iss` to locate the signing keys would let an attacker
point verification at a JWKS they control.
"""
from __future__ import annotations

import logging
import threading

import jwt
from django.conf import settings
from jwt import PyJWKClient, PyJWKClientError

logger = logging.getLogger(__name__)

# Clerk rotates signing keys rarely; an hour of caching keeps the hot auth path
# off the network without meaningfully delaying a rotation.
JWKS_CACHE_SECONDS = 3600

# Tolerance for clock skew between this host and Clerk.
LEEWAY_SECONDS = 30


class ClerkConfigurationError(RuntimeError):
    """Raised when Clerk verification is not configured — never a client error."""


class ClerkTokenError(Exception):
    """Raised when a presented token is missing, malformed, expired or forged."""


_jwk_client: PyJWKClient | None = None
_jwk_client_lock = threading.Lock()


def get_issuer() -> str:
    issuer = (getattr(settings, "CLERK_ISSUER", "") or "").strip().rstrip("/")
    if not issuer:
        raise ClerkConfigurationError(
            "CLERK_ISSUER is not set. Set it in backend/.env to your Clerk Frontend "
            "API origin (e.g. https://your-app.clerk.accounts.dev). Tokens cannot be "
            "verified without it, and unverified tokens are not accepted."
        )
    return issuer


def _get_jwk_client() -> PyJWKClient:
    """Process-wide JWKS client. Double-checked so threads don't each build one."""
    global _jwk_client
    if _jwk_client is None:
        with _jwk_client_lock:
            if _jwk_client is None:
                _jwk_client = PyJWKClient(
                    f"{get_issuer()}/.well-known/jwks.json",
                    cache_keys=True,
                    cache_jwk_set=True,
                    lifespan=JWKS_CACHE_SECONDS,
                    timeout=5,
                )
    return _jwk_client


def reset_jwk_client_cache() -> None:
    """Drop the cached JWKS client. Used by tests and after a settings change."""
    global _jwk_client
    with _jwk_client_lock:
        _jwk_client = None


def verify_clerk_token(token: str) -> dict:
    """
    Verify a Clerk session JWT and return its claims.

    Raises ClerkTokenError for anything attributable to the caller's token, and
    ClerkConfigurationError if this server is not set up to verify at all — the
    two must not be conflated, since the latter is a 500 and not a 401.
    """
    if not token or not token.strip():
        raise ClerkTokenError("Missing token")

    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
    except PyJWKClientError as exc:
        # Unknown `kid`, or JWKS unreachable. The former is a forged/stale token,
        # the latter is an outage; we cannot authenticate either way.
        raise ClerkTokenError(f"Could not resolve signing key: {exc}") from exc
    except jwt.DecodeError as exc:
        raise ClerkTokenError("Malformed token") from exc

    decode_kwargs: dict = {
        "algorithms": ["RS256"],
        "issuer": get_issuer(),
        "leeway": LEEWAY_SECONDS,
        "options": {"require": ["exp", "iat", "sub"]},
    }

    audience = (getattr(settings, "CLERK_AUDIENCE", "") or "").strip()
    if audience:
        decode_kwargs["audience"] = audience
    else:
        # Clerk omits `aud` unless a JWT template adds it; without this PyJWT
        # rejects tokens that legitimately carry no audience.
        decode_kwargs["options"]["verify_aud"] = False

    try:
        return jwt.decode(token, signing_key.key, **decode_kwargs)
    except jwt.ExpiredSignatureError as exc:
        raise ClerkTokenError("Token has expired") from exc
    except jwt.InvalidTokenError as exc:
        raise ClerkTokenError(f"Invalid token: {exc}") from exc
