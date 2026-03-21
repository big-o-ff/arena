from datetime import timedelta

from django.db.models import Avg
from django.utils import timezone
from rest_framework import generics, permissions, status, views
from rest_framework.response import Response

from accounts.models import User
from accounts.permissions import IsAdmin
from battles.models import Battle, Submission

from .serializers import (
    AdminBattleSerializer,
    AdminUserSerializer,
    SubmissionLogSerializer,
)


class AdminBattleListView(generics.ListAPIView):
    queryset = Battle.objects.all()
    serializer_class = AdminBattleSerializer
    permission_classes = [IsAdmin]


class AdminUserListView(generics.ListAPIView):
    queryset = User.objects.all()
    serializer_class = AdminUserSerializer
    permission_classes = [IsAdmin]


class AdminUserRoleUpdateView(views.APIView):
    permission_classes = [IsAdmin]

    def patch(self, request, pk: int, *args, **kwargs):
        user = generics.get_object_or_404(User, pk=pk)
        role = request.data.get("role")
        if role not in dict(User.Role.choices):
            return Response(
                {"detail": "Invalid role."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user.role = role
        user.save(update_fields=["role"])
        return Response(AdminUserSerializer(user).data)


class SubmissionLogListView(generics.ListAPIView):
    queryset = Submission.objects.all()
    serializer_class = SubmissionLogSerializer
    permission_classes = [IsAdmin]


class PlatformStatsView(views.APIView):
    permission_classes = [IsAdmin]

    def get(self, request, *args, **kwargs):
        now = timezone.now()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

        battles_today = Battle.objects.filter(
            created_at__gte=today_start,
        ).count()
        active_battles = Battle.objects.filter(status=Battle.Status.ACTIVE).count()
        active_users = (
            User.objects.filter(last_login__gte=now - timedelta(minutes=15)).count()
        )
        avg_submission_time = (
            Submission.objects.filter(submitted_at__gte=today_start)
            .aggregate(avg_submitted_at=Avg("submitted_at"))
            .get("avg_submitted_at")
        )

        return Response(
            {
                "battles_today": battles_today,
                "active_battles": active_battles,
                "active_users": active_users,
                "average_submission_time": avg_submission_time,
            }
        )

