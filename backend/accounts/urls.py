from django.urls import path

from .views import AuthMeView, ClerkWebhookView

# Profile and leaderboard are mounted once, at the project level (config/urls.py).
# They used to be registered here as well, giving every endpoint two URLs.
urlpatterns = [
    path("me/", AuthMeView.as_view(), name="auth-me"),
    path("clerk-webhook/", ClerkWebhookView.as_view(), name="clerk-webhook"),
]
