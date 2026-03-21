from rest_framework import serializers

from accounts.serializers import UserProfileSerializer
from problems.serializers import ProblemSerializer

from .models import Battle, BattleRequest, Round, Submission


class RoundSerializer(serializers.ModelSerializer):
    problem = ProblemSerializer(read_only=True)

    class Meta:
        model = Round
        fields = "__all__"


class BattleSerializer(serializers.ModelSerializer):
    player1 = UserProfileSerializer(read_only=True)
    player2 = UserProfileSerializer(read_only=True)
    rounds = RoundSerializer(many=True, read_only=True)

    class Meta:
        model = Battle
        fields = "__all__"


class SubmissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Submission
        fields = "__all__"
        read_only_fields = ("player", "battle", "problem")


class BattleRequestSerializer(serializers.ModelSerializer):
    from_user = UserProfileSerializer(read_only=True)

    class Meta:
        model = BattleRequest
        fields = ("id", "from_user", "to_user", "status", "created_at")
        read_only_fields = ("from_user", "to_user", "status", "created_at")

