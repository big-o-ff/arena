from rest_framework import serializers

from .models import SpectatorSession


class SpectatorSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = SpectatorSession
        fields = "__all__"
        read_only_fields = ("joined_at",)

