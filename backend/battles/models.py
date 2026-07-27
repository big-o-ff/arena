import uuid
from django.conf import settings
from django.db import models

from problems.models import Problem


class Battle(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACTIVE = "active", "Active"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    player1 = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="battles_as_player1",
    )
    player2 = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="battles_as_player2",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    current_round = models.PositiveSmallIntegerField(default=1)
    winner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="battles_won",
    )
    player1_hp = models.PositiveSmallIntegerField(default=100)
    player2_hp = models.PositiveSmallIntegerField(default=100)
    spectator_likes = models.PositiveIntegerField(default=0)
    ends_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the match auto-ends (typically 30 minutes after going active).",
    )
    ended_reason = models.CharField(
        max_length=32,
        blank=True,
        null=True,
        help_text="How the battle ended: resign, hp_zero, timeout, etc.",
    )
    resigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="battles_resigned",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            # Every lobby poll, spectate list and expiry sweep filters on status.
            models.Index(fields=["status", "-created_at"], name="battle_status_created"),
            models.Index(fields=["status", "ends_at"], name="battle_status_ends_at"),
        ]
        constraints = [
            models.CheckConstraint(
                check=~models.Q(player1=models.F("player2")),
                name="battle_players_must_differ",
            ),
        ]

    def __str__(self) -> str:
        return f"Battle #{self.pk}"


class Round(models.Model):
    battle = models.ForeignKey(
        Battle,
        on_delete=models.CASCADE,
        related_name="rounds",
    )
    problem = models.ForeignKey(Problem, on_delete=models.PROTECT)
    round_number = models.PositiveSmallIntegerField()
    winner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="rounds_won",
    )
    started_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    player1_time_ms = models.PositiveIntegerField(null=True, blank=True)
    player2_time_ms = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["round_number"]

    def __str__(self) -> str:
        return f"Battle {self.battle_id} Round {self.round_number}"


class Submission(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PASSED = "passed", "Passed"
        FAILED = "failed", "Failed"
        ERROR = "error", "Error"

    battle = models.ForeignKey(
        Battle,
        on_delete=models.CASCADE,
        related_name="submissions",
    )
    player = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="submissions",
    )
    problem = models.ForeignKey(Problem, on_delete=models.CASCADE)
    code = models.TextField()
    language = models.CharField(max_length=20)  # python | javascript | cpp
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    passed_cases = models.PositiveSmallIntegerField(default=0)
    total_cases = models.PositiveSmallIntegerField(default=0)
    execution_time_ms = models.PositiveIntegerField(null=True, blank=True)
    complexity_class = models.CharField(max_length=20, null=True, blank=True)
    submitted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-submitted_at"]
        # Deliberately NOT unique on (battle, player, problem): a single failed
        # attempt used to lock a player out of that problem for the whole match,
        # which with a 3-problem pool could eliminate them outright. Retries are
        # allowed; scoring only ever counts the first *passing* submission.
        indexes = [
            models.Index(
                fields=["battle", "problem", "status"],
                name="submission_battle_prob_st",
            ),
            models.Index(
                fields=["battle", "player"], name="submission_battle_player"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.player.username} -> {self.problem.title} ({self.passed_cases}/{self.total_cases})"


class BattleReward(models.Model):
    """Persisted reward when a player wins a round (first to pass all tests)."""

    class RewardType(models.TextChoices):
        ROUND_FIRST_SOLVE = "round_first_solve", "Round first solve"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="battle_rewards",
    )
    battle = models.ForeignKey(
        Battle,
        on_delete=models.CASCADE,
        related_name="rewards",
    )
    problem = models.ForeignKey(Problem, on_delete=models.CASCADE)
    reward_type = models.CharField(
        max_length=32,
        choices=RewardType.choices,
        default=RewardType.ROUND_FIRST_SOLVE,
    )
    hp_damage_dealt = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.user} +{self.hp_damage_dealt} HP vs opp ({self.battle_id})"


class BattleRequest(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        ACCEPTED = "accepted", "Accepted"
        DECLINED = "declined", "Declined"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"

    from_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="battle_requests_sent",
    )
    to_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="battle_requests_received",
    )
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    def save(self, *args, **kwargs):
        if not self.pk:  # only on creation
            from django.utils import timezone
            from datetime import timedelta
            self.expires_at = timezone.now() + timedelta(minutes=30)
        super().save(*args, **kwargs)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["to_user", "status"], name="battlereq_to_user_status"
            ),
            models.Index(
                fields=["status", "expires_at"], name="battlereq_status_expires"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.from_user} -> {self.to_user} ({self.status})"


class BattleResult(models.Model):
    # Store history of the final battle outcome
    battle = models.OneToOneField(
        Battle,
        on_delete=models.CASCADE,
        related_name="result",
    )
    player1_rating_change = models.IntegerField()
    player2_rating_change = models.IntegerField()
    fastest_solve_time_ms = models.PositiveIntegerField(null=True, blank=True)
    problems_solved = models.PositiveSmallIntegerField(default=0)
    share_uuid = models.UUIDField(default=uuid.uuid4, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Result for Battle #{self.battle_id}"

