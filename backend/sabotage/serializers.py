from rest_framework import serializers

from .models import SabotageMove


class SabotageMoveSerializer(serializers.ModelSerializer):
    class Meta:
        model = SabotageMove
        fields = "__all__"
        read_only_fields = ("attacker", "battle", "triggered_at")

