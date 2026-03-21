from django.urls import re_path

from .consumers import BattleConsumer


websocket_urlpatterns = [
    re_path(r"ws/battles/(?P<battle_id>\d+)/$", BattleConsumer.as_asgi()),
]

