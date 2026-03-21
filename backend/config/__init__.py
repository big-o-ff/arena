import pymysql

pymysql.install_as_MySQLdb()

# Ensure the Celery app is always imported when Django starts
# so that @shared_task decorators use this app.
from .celery import app as celery_app  # noqa: E402, F401

__all__ = ("celery_app",)