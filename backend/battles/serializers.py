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
    """
    Battle state, including the caller's own progress.

    The progress fields exist because the battle screen used to learn which
    problems it had solved *only* from the live ROUND_RESULT socket event. That
    event fires while the player is being redirected to the review page, so the
    battle screen was unmounted when it arrived — and on the way back it
    remounted with an empty set. Solved problems showed as unsolved, and the
    single-use sabotage button came back available, until the page was reloaded
    (which did not help either, since nothing seeded it).
    """

    player1 = UserProfileSerializer(read_only=True)
    player2 = UserProfileSerializer(read_only=True)
    rounds = RoundSerializer(many=True, read_only=True)
    my_solved_problem_ids = serializers.SerializerMethodField()
    my_submitted_problem_ids = serializers.SerializerMethodField()
    my_sabotage_used = serializers.SerializerMethodField()

    class Meta:
        model = Battle
        fields = "__all__"

    def _me(self):
        """The authenticated caller, or None when serialized without a request."""
        user = getattr(self.context.get("request"), "user", None)
        return user if user is not None and user.is_authenticated else None

    def get_my_solved_problem_ids(self, obj: Battle) -> list[int]:
        me = self._me()
        if me is None:
            return []
        return list(
            Submission.objects.filter(
                battle=obj, player=me, status=Submission.Status.PASSED
            )
            .values_list("problem_id", flat=True)
            .distinct()
        )

    def get_my_submitted_problem_ids(self, obj: Battle) -> list[int]:
        me = self._me()
        if me is None:
            return []
        return list(
            Submission.objects.filter(battle=obj, player=me)
            .values_list("problem_id", flat=True)
            .distinct()
        )

    def get_my_sabotage_used(self, obj: Battle) -> bool:
        me = self._me()
        if me is None:
            return False
        # Local import: `sabotage` imports `battles.models`, so a module-level
        # import here would close the loop.
        from sabotage.models import SabotageMove

        return SabotageMove.objects.filter(battle=obj, attacker=me).exists()


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


class BattleRequestHistorySerializer(serializers.ModelSerializer):
    """Sent + received battle requests for the notification center."""

    from_user = UserProfileSerializer(read_only=True)
    to_user = UserProfileSerializer(read_only=True)
    direction = serializers.SerializerMethodField()

    class Meta:
        model = BattleRequest
        fields = (
            "id",
            "from_user",
            "to_user",
            "status",
            "created_at",
            "expires_at",
            "direction",
        )

    def get_direction(self, obj: BattleRequest) -> str:
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            if request.user.id == obj.from_user_id:
                return "sent"
        return "received"

