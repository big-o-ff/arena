from rest_framework import generics, permissions

from .models import Problem
from .serializers import ProblemSerializer


class ProblemListView(generics.ListAPIView):
    serializer_class = ProblemSerializer
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        queryset = Problem.objects.filter(is_active=True)
        difficulty = self.request.query_params.get("difficulty")
        if difficulty:
            queryset = queryset.filter(difficulty=difficulty)
        return queryset

