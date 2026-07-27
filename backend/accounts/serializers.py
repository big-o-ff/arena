from rest_framework import serializers

from .models import User


class UserProfileSerializer(serializers.ModelSerializer):
    """Public-facing profile. Never includes email or clerk_id."""

    rank_name = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = (
            "id",
            "username",
            "display_name",
            "avatar_url",
            "role",
            "rating",
            "rank_name",
            "total_wins",
            "total_losses",
            "date_joined",
        )
        read_only_fields = fields
