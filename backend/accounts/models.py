from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    class Role(models.TextChoices):
        SUPERADMIN = "superadmin", "Super Admin"
        ADMIN = "admin", "Admin"
        PLAYER = "player", "Player"
        SPECTATOR = "spectator", "Spectator"

    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.PLAYER,
    )
    clerk_id = models.CharField(max_length=100, unique=True, null=True, blank=True)
    display_name = models.CharField(max_length=100)
    avatar_url = models.URLField(blank=True)
    total_wins = models.PositiveIntegerField(default=0)
    total_losses = models.PositiveIntegerField(default=0)
    rating = models.IntegerField(default=800)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def rank_name(self) -> str:
        if self.rating < 1000:
            return "Newbie"
        if self.rating < 1200:
            return "Pupil"
        if self.rating < 1400:
            return "Specialist"
        if self.rating < 1600:
            return "Expert"
        if self.rating < 1900:
            return "Candidate Master"
        if self.rating < 2100:
            return "Master"
        if self.rating < 2300:
            return "International Master"
        if self.rating < 2400:
            return "Grandmaster"
        if self.rating < 2600:
            return "International Grandmaster"
        return "Legendary Grandmaster"

    def __str__(self) -> str:
        return self.username


class HeatmapEntry(models.Model):
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="heatmap_entries",
    )
    date = models.DateField()
    problems_solved = models.PositiveIntegerField(default=0)

    class Meta:
        unique_together = ("user", "date")
        ordering = ["-date"]

    def __str__(self) -> str:
        return f"{self.user.username} - {self.date} - {self.problems_solved}"

