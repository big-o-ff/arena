import os
from kombu import Queue, Exchange
from pathlib import Path
from django.core.management.utils import get_random_secret_key
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

DEBUG = os.getenv("DJANGO_DEBUG", "True").lower() == "true"

if DEBUG:
    SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "dev-only-insecure-key")
else:
    SECRET_KEY = _get_env("DJANGO_SECRET_KEY")

CLERK_WEBHOOK_SECRET = os.getenv('CLERK_WEBHOOK_SECRET', '')

# ALLOWED_HOSTS: list[str] = os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(
#    ","
# )

ALLOWED_HOSTS = [
    h.strip()
    for h in os.getenv(
        "DJANGO_ALLOWED_HOSTS",
        "localhost,127.0.0.1,54.xx.xx.xx",  # add Tailscale IP or MagicDNS name when needed
    ).split(",")
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
    "rest_framework.authtoken",
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
STATICFILES_DIRS = [BASE_DIR / "static"]

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"


DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "accounts.User"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "accounts.authentication.ClerkAuthentication",
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}

REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0") # change this to elastiCache primary endpoint
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

CELERY_TASK_ROUTES = {
    'battles.tasks.evaluate_submission':  {'queue': 'execution'},
    'battles.tasks.complexity_analysis':  {'queue': 'execution'},
    'battles.tasks.schedule_fog':         {'queue': 'events'},
    'battles.tasks.end_fog':              {'queue': 'events'},
    'battles.tasks.send_gc_end':          {'queue': 'events'},
    'battles.tasks.process_battle_end':   {'queue': 'events'},
    'battles.tasks.battle_timeout':       {'queue': 'events'},
}

if not DEBUG:
    # Ensure Django knows it is behind a proxy (Nginx)
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = True  # Redirects 80 to 443
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True