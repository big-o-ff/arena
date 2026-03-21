from django.urls import re_path

from .consumers import SpectatorConsumer


websocket_urlpatterns = [
    re_path(r"ws/battles/(?P<battle_id>\d+)/spectate/$", SpectatorConsumer.as_asgi()),
]

