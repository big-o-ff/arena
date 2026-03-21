from rest_framework import serializers

from .models import Problem


class ProblemSerializer(serializers.ModelSerializer):
    """
    Public serializer — test_cases is NEVER included.
    Only safe fields that can be shown to the user are listed here.
    """

    class Meta:
        model = Problem
        fields = [
            "id",
            "title",
            "description",
            "difficulty",
            "input_format",
            "output_format",
            "constraints",
            "sample_input",
            "sample_output",
        ]
