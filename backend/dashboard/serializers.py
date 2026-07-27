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
    # `Submission` relates to the user through `player`, and stores
    # `complexity_class`. The previous `user` / `complexity_score` names raised
    # ImproperlyConfigured at field-build time, so this endpoint always 500'd.
    player = serializers.CharField(source="player.username", read_only=True)
    problem = serializers.CharField(source="problem.title", read_only=True)

    class Meta:
        model = Submission
        fields = (
            "id",
            "player",
            "problem",
            "battle_id",
            "language",
            "status",
            "passed_cases",
            "total_cases",
            "execution_time_ms",
            "complexity_class",
            "submitted_at",
        )

