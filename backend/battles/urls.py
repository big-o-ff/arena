from django.urls import path

from .views import (
    BattleRequestAcceptView,
    BattleRequestDeclineView,
    BattleRequestListCreateView,
    BattleStateView,
    CreateBattleView,
    MyActiveBattleView,
    RunSolutionView,
    SimpleLeaderboardView,
    SubmitSolutionView,
    ShareCardView,
)

urlpatterns = [
    path("create/", CreateBattleView.as_view(), name="battle-create"),
    path("active/", MyActiveBattleView.as_view(), name="battle-active"),
    path("requests/", BattleRequestListCreateView.as_view(), name="battle-request-list"),
    path(
        "requests/<int:pk>/accept/",
        BattleRequestAcceptView.as_view(),
        name="battle-request-accept",
    ),
    path(
        "requests/<int:pk>/decline/",
        BattleRequestDeclineView.as_view(),
        name="battle-request-decline",
    ),
    path("<int:pk>/state/", BattleStateView.as_view(), name="battle-state"),
    path("<int:pk>/submit/", SubmitSolutionView.as_view(), name="battle-submit"),
    path("<int:pk>/run/", RunSolutionView.as_view(), name="battle-run"),
    path("leaderboard/", SimpleLeaderboardView.as_view(), name="battle-leaderboard"),
    path("share/<uuid:share_uuid>/", ShareCardView.as_view(), name="share-card"),
]

