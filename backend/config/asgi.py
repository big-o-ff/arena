import os
from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

django_asgi_app = get_asgi_application()

import battles.routing
import spectators.routing
import dashboard.routing
from accounts.middleware import JWTAuthMiddlewareStack

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": JWTAuthMiddlewareStack(
        URLRouter(
            battles.routing.websocket_urlpatterns
            + spectators.routing.websocket_urlpatterns
            + dashboard.routing.websocket_urlpatterns
        )
    ),
})