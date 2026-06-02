from django.urls import path

from .views import (
    BattleProblemReviewView,
    BattleRequestAcceptView,
    BattleRequestCancelView,
    BattleRequestDeclineView,
    BattleRequestHistoryView,
    BattleRequestListCreateView,
    BattleEndedSummaryView,
    BattleResignView,
    BattleStateView,
    CreateBattleView,
    LiveBattlesListView,
    MyActiveBattleView,
    PublicBattleStateView,
    RunSolutionView,
    SimpleLeaderboardView,
    SubmitSolutionView,
)

urlpatterns = [
    path("create/", CreateBattleView.as_view(), name="battle-create"),
    path("live/", LiveBattlesListView.as_view(), name="battle-live-list"),
    path(
        "public/<int:pk>/state/",
        PublicBattleStateView.as_view(),
        name="battle-public-state",
    ),
    path("active/", MyActiveBattleView.as_view(), name="battle-active"),
    path(
        "requests/history/",
        BattleRequestHistoryView.as_view(),
        name="battle-request-history",
    ),
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
    path(
        "requests/<int:pk>/cancel/",
        BattleRequestCancelView.as_view(),
        name="battle-request-cancel",
    ),
    path("<int:pk>/state/", BattleStateView.as_view(), name="battle-state"),
    path("<int:pk>/ended/", BattleEndedSummaryView.as_view(), name="battle-ended-summary"),
    path("<int:pk>/resign/", BattleResignView.as_view(), name="battle-resign"),
    path(
        "<int:pk>/problems/<int:problem_id>/review/",
        BattleProblemReviewView.as_view(),
        name="battle-problem-review",
    ),
    path("<int:pk>/submit/", SubmitSolutionView.as_view(), name="battle-submit"),
    path("<int:pk>/run/", RunSolutionView.as_view(), name="battle-run"),
    path("leaderboard/", SimpleLeaderboardView.as_view(), name="battle-leaderboard"),
]

