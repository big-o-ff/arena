from django.conf import settings
from django.db import models


class Problem(models.Model):
    class Difficulty(models.TextChoices):
        EASY = "easy", "Easy"
        MEDIUM = "medium", "Medium"
        HARD = "hard", "Hard"

    title = models.CharField(max_length=255)
    description = models.TextField()
    difficulty = models.CharField(
        max_length=10,
        choices=Difficulty.choices,
    )
    input_format = models.TextField()
    output_format = models.TextField()
    constraints = models.TextField()
    sample_input = models.TextField(
        help_text="Shown to user, used for Run",
        blank=True,
        default="",
    )
    sample_output = models.TextField(
        help_text="Shown to user, used for Run",
        blank=True,
        default="",
    )
    test_cases = models.JSONField(
        help_text="Hidden test cases — backend only, never sent to frontend",
        default=list,
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="problems_created",
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.title} ({self.difficulty})"

