from django.conf import settings
from django.db import models

from battles.models import Battle


class SpectatorSession(models.Model):
    battle = models.ForeignKey(
        Battle,
        on_delete=models.CASCADE,
        related_name="spectator_sessions",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="spectator_sessions",
    )
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("battle", "user")

    def __str__(self) -> str:
        return f"{self.user.username} spectating battle {self.battle_id}"

