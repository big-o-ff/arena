"""
Settings for the test suite.

Tests must not need MySQL, Redis or a Clerk account to run, so the three
external dependencies are swapped for in-process equivalents.
"""
import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-only-key-not-used-anywhere-else")

# The execution tests really do spawn interpreters and invoke the C++ compiler.
# Under sustained load the default wall-clock budgets are tight enough to make
# correct submissions look like timeouts, so give the suite more headroom.
os.environ.setdefault("ARENA_RUN_TIMEOUT", "15")
os.environ.setdefault("ARENA_COMPILE_TIMEOUT", "120")

from .settings import *  # noqa: F401,F403

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
}

CHANNEL_LAYERS = {
    "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}
}

# Run queued work inline so task behaviour is covered without a worker.
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True

# Scopes must still resolve (DRF raises on an unknown scope), but the limits are
# lifted so unrelated tests sharing the cache don't throttle each other.
REST_FRAMEWORK = {  # noqa: F405
    **REST_FRAMEWORK,  # noqa: F405
    "DEFAULT_THROTTLE_RATES": {
        "run": "10000/min",
        "submit": "10000/min",
        "public": "10000/min",
    },
}

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]

# The production hardening block turns these on whenever DEBUG is false, which
# would 301 every test request to https://testserver.
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0

CLERK_ISSUER = "https://test-app.clerk.accounts.dev"
CLERK_AUDIENCE = ""
CLERK_WEBHOOK_SECRET = ""
