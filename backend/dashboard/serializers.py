from rest_framework import serializers

from accounts.models import User
from battles.models import Battle, Submission


class AdminUserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = (
            "id",
            "username",
            "display_name",
            "email",
            "role",
            "is_active",
            "total_wins",
            "total_losses",
            "date_joined",
        )


class AdminBattleSerializer(serializers.ModelSerializer):
    player1_username = serializers.CharField(source="player1.username", read_only=True)
    player2_username = serializers.CharField(source="player2.username", read_only=True)

    class Meta:
        model = Battle
        fields = (
            "id",
            "player1_username",
            "player2_username",
            "status",
            "current_round",
            "player1_hp",
            "player2_hp",
            "winner_id",
            "created_at",
        )


class SubmissionLogSerializer(serializers.ModelSerializer):
    user = serializers.CharField(source="user.username", read_only=True)
    problem = serializers.CharField(source="problem.title", read_only=True)

    class Meta:
        model = Submission
        fields = (
            "id",
            "user",
            "problem",
            "battle_id",
            "language",
            "passed_cases",
            "total_cases",
            "complexity_score",
            "submitted_at",
        )

