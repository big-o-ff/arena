from django.urls import path

from .views import AuthMeView, LeaderboardView, LoginView, LogoutView, ProfileView, RegisterView, ClerkWebhookView


urlpatterns = [
    path("register/", RegisterView.as_view(), name="register"),
    path("login/", LoginView.as_view(), name="login"),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("profile/<str:username>/", ProfileView.as_view(), name="profile"),
    path("leaderboard/", LeaderboardView.as_view(), name="leaderboard"),
    path("me/", AuthMeView.as_view(), name="auth-me"),
    path("clerk-webhook/", ClerkWebhookView.as_view(), name="clerk-webhook"),
]

