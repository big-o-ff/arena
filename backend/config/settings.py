import os
from kombu import Queue, Exchange
from pathlib import Path
import pymysql
from dotenv import load_dotenv

pymysql.install_as_MySQLdb()

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

def _get_env(name: str, default: str | None = None) -> str:
    value = os.getenv(name, default)
    if value is None:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

# Fail safe: anything other than an explicit opt-in runs as production.
DEBUG = os.getenv("DJANGO_DEBUG", "False").strip().lower() in ("1", "true", "yes")

# Always required. A checked-in fallback key means forgeable sessions and signed
# cookies the moment this ships, so there is no development shortcut here.
# Generate one with:  python -c "from django.core.management.utils import
#   get_random_secret_key as k; print(k())"
SECRET_KEY = _get_env("DJANGO_SECRET_KEY")

# ---------------------------------------------------------------------------
# Clerk
# ---------------------------------------------------------------------------
# Origin that issues your session tokens, e.g. https://your-app.clerk.accounts.dev
# Used to pin the JWKS endpoint used for signature verification — see accounts/clerk.py.
CLERK_ISSUER = os.getenv("CLERK_ISSUER", "").strip()
# Only needed if your Clerk JWT template sets an `aud` claim.
CLERK_AUDIENCE = os.getenv("CLERK_AUDIENCE", "").strip()
CLERK_WEBHOOK_SECRET = os.getenv("CLERK_WEBHOOK_SECRET", "")

ALLOWED_HOSTS = [
    h.strip()
    for h in os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
    if h.strip()
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "corsheaders",
    "channels",
    # Local apps
    "accounts",
    "battles",
    "problems",
    "sabotage",
    "spectators",
    "dashboard",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"


DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "NAME": os.getenv("MYSQL_DATABASE", "bigoff"),
        "USER": os.getenv("MYSQL_USER", "bigoff"),
        "PASSWORD": os.getenv("MYSQL_PASSWORD", ""),
        "HOST": os.getenv("MYSQL_HOST", "127.0.0.1"),
        "PORT": os.getenv("MYSQL_PORT", "3306"),
    }
}


AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]


LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# Only advertise the extra source dir if it actually exists — otherwise every
# management command emits staticfiles.W004.
STATICFILES_DIRS = [BASE_DIR / "static"] if (BASE_DIR / "static").is_dir() else []


DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "accounts.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        # Clerk is the only way to authenticate as a player. SessionAuthentication
        # is retained purely so the Django admin / browsable API stay usable.
        "accounts.authentication.ClerkAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        # Code execution is the expensive, abusable path.
        "run": "20/min",
        "submit": "30/min",
        "public": "120/min",
    },
}

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")

# Shared cache — DRF throttling stores counters here. With the default LocMemCache
# every worker process would keep its own counts, so the limits would scale with
# the number of workers instead of being enforced.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }
}

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [REDIS_URL],
        },
    },
}

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,"
        "http://localhost:3001,http://127.0.0.1:3001,"
        "http://localhost:3002,http://127.0.0.1:3002",
    ).split(",")
    if origin.strip()
]

CORS_ALLOW_CREDENTIALS = True


# ---------------------------------------------------------------------------
# Celery
# ---------------------------------------------------------------------------
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC" 

execution_exchange = Exchange('execution', type='direct')
events_exchange    = Exchange('events',    type='direct')

CELERY_TASK_QUEUES = [
    Queue('execution', execution_exchange, routing_key='execution'),
    Queue('events',    events_exchange,    routing_key='events'),
]
CELERY_TASK_DEFAULT_QUEUE = "execution"
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True

# A submission runs every test case through the sandbox; without a hard ceiling a
# pathological program can pin a worker indefinitely.
CELERY_TASK_SOFT_TIME_LIMIT = 180
CELERY_TASK_TIME_LIMIT = 240
CELERY_WORKER_PREFETCH_MULTIPLIER = 1

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {"format": "[{asctime}] {levelname} {name}: {message}", "style": "{"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "verbose"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "battles": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "accounts": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}

if not DEBUG:
    # Django sits behind a TLS-terminating proxy (Nginx).
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_HTTPONLY = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"
    CSRF_TRUSTED_ORIGINS = [
        o for o in CORS_ALLOWED_ORIGINS if o.startswith("https://")
    ]