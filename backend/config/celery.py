"""
Celery application for Arena.

Two queues:
  - 'execution'  (concurrency=4)  — runs user code, CPU-bound
  - 'events'     (concurrency=10) — WS broadcasts, fog/gc timers, fast I/O
"""
import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("arena")
app.config_from_object("django.conf:settings", namespace="CELERY")

# Auto-discover tasks in every installed app (e.g. battles/tasks.py)
app.autodiscover_tasks()
