from rest_framework import generics, permissions

from .models import SpectatorSession
from .serializers import SpectatorSessionSerializer


class SpectatorSessionListView(generics.ListAPIView):
    queryset = SpectatorSession.objects.all()
    serializer_class = SpectatorSessionSerializer
    permission_classes = [permissions.IsAdminUser]

