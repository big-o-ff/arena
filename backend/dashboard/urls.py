from django.urls import path

from .views import (
    AdminBattleListView,
    AdminUserListView,
    AdminUserRoleUpdateView,
    PlatformStatsView,
    SubmissionLogListView,
)


urlpatterns = [
    path("battles/", AdminBattleListView.as_view(), name="admin-battles"),
    path("users/", AdminUserListView.as_view(), name="admin-users"),
    path("users/<int:pk>/role/", AdminUserRoleUpdateView.as_view(), name="admin-user-role"),
    path("submissions/", SubmissionLogListView.as_view(), name="admin-submissions"),
    path("stats/", PlatformStatsView.as_view(), name="admin-stats"),
]

