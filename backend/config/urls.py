from django.contrib import admin
from django.urls import include, path

from accounts.views import LeaderboardView, ProfileView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/", include("accounts.urls")),
    path("api/problems/", include("problems.urls")),
    path("api/battles/", include("battles.urls")),
    path("api/battles/", include("sabotage.urls")),
    path("api/spectators/", include("spectators.urls")),
    path("api/admin/", include("dashboard.urls")),
    # Single canonical mount for each of these — they were previously also
    # reachable under /api/auth/.
    path("api/profile/<str:username>/", ProfileView.as_view(), name="profile"),
    path("api/leaderboard/", LeaderboardView.as_view(), name="leaderboard"),
]
