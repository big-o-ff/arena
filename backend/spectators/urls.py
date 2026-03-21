from django.urls import path

from .views import SpectatorSessionListView


urlpatterns = [
    path("sessions/", SpectatorSessionListView.as_view(), name="spectator-sessions"),
]

