from django.conf import settings
from django.db import models

from battles.models import Battle


class SabotageMove(models.Model):
    class MoveType(models.TextChoices):
        GARBAGE_COLLECTION = "GARBAGE_COLLECTION", "Garbage Collection"

    battle = models.ForeignKey(
        Battle,
        on_delete=models.CASCADE,
        related_name="sabotage_moves",
    )
    attacker = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sabotage_moves",
    )
    move_type = models.CharField(
        max_length=32,
        choices=MoveType.choices,
    )
    triggered_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"{self.attacker.username} -> {self.move_type} in Battle {self.battle_id}"

