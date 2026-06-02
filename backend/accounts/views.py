from django.contrib.auth import login, logout
from django.shortcuts import get_object_or_404
from rest_framework import generics, permissions, status
from rest_framework.authtoken.models import Token
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import User
from .serializers import LoginSerializer, RegisterSerializer, UserProfileSerializer


class RegisterView(generics.CreateAPIView):
    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request, *args, **kwargs):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        token, _ = Token.objects.get_or_create(user=user)
        login(request, user)
        return Response(
            {
                "token": token.key,
                "user": UserProfileSerializer(user).data,
            }
        )


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, *args, **kwargs):
        Token.objects.filter(user=request.user).delete()
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProfileView(generics.RetrieveAPIView):
    queryset = User.objects.all()
    serializer_class = UserProfileSerializer
    lookup_field = "username"
    permission_classes = [permissions.AllowAny]


class LeaderboardView(generics.ListAPIView):
    queryset = User.objects.filter(role__in=["player", "spectator"]).order_by(
        "-total_wins", "total_losses"
    )
    serializer_class = UserProfileSerializer
    permission_classes = [permissions.AllowAny]

class AuthMeView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        user = request.user
        return Response({
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "rating": getattr(user, "rating", 800),
            "rank_name": getattr(user, "rank_name", "Newbie"),
            "clerk_id": getattr(user, "clerk_id", None),
            "role": getattr(user, "role", "player"),
            "total_wins": getattr(user, "total_wins", 0),
            "total_losses": getattr(user, "total_losses", 0),
        })

    def post(self, request, *args, **kwargs):
        user = request.user
        
        username = request.data.get("username")
        email = request.data.get("email")
        first_name = request.data.get("first_name", "")
        last_name = request.data.get("last_name", "")

        changed = False

        from django.db import IntegrityError, transaction
        try:
            with transaction.atomic():
                if username and user.username != username:
                    user.username = username
                    if not user.display_name or str(user.display_name).startswith("Player_"):
                        user.display_name = username
                    changed = True
                if email and getattr(user, 'email', '') != email:
                    user.email = email
                    changed = True
                if getattr(user, 'first_name', '') != first_name:
                    user.first_name = first_name
                    changed = True
                if getattr(user, 'last_name', '') != last_name:
                    user.last_name = last_name
                    changed = True

                if changed:
                    user.save(update_fields=["username", "email", "first_name", "last_name", "display_name"])
        except IntegrityError:
            pass # ignore if username is duplicate

        return Response({
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "rating": getattr(user, "rating", 800),
            "rank_name": getattr(user, "rank_name", "Newbie"),
            "clerk_id": getattr(user, "clerk_id", None),
            "role": getattr(user, "role", "player"),
            "total_wins": getattr(user, "total_wins", 0),
            "total_losses": getattr(user, "total_losses", 0),
        })

import svix
from django.conf import settings
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

@method_decorator(csrf_exempt, name='dispatch')
class ClerkWebhookView(APIView):
    permission_classes = [permissions.AllowAny]
    authentication_classes = []

    def post(self, request, *args, **kwargs):
        secret = getattr(settings, 'CLERK_WEBHOOK_SECRET', '')
        if not secret:
            # Avoid HTTP 500 so Clerk does not retry; sync still works via JWT + /api/auth/me/
            return Response({"detail": "webhook_disabled"}, status=status.HTTP_200_OK)

        headers = request.headers
        try:
            wh = svix.Webhook(secret)
            evt = wh.verify(request.body, headers)
        except Exception as e:
            return Response(str(e), status=status.HTTP_400_BAD_REQUEST)

        evt_type = evt.get('type')
        data = evt.get('data', {})
        clerk_id = data.get('id')

        if not clerk_id:
            return Response("Missing ID", status=status.HTTP_400_BAD_REQUEST)

        if evt_type == 'user.created':
            username = data.get('username') or ''
            email = ''
            if data.get('email_addresses'):
                email = data['email_addresses'][0].get('email_address', '')
            
            first_name = data.get('first_name', '')
            last_name = data.get('last_name', '')
            
            User.objects.update_or_create(
                clerk_id=clerk_id,
                defaults={
                    'username': username or clerk_id,
                    'email': email,
                    'first_name': first_name,
                    'last_name': last_name,
                    'display_name': username or first_name or clerk_id,
                }
            )
        elif evt_type == 'user.updated':
            username = data.get('username') or ''
            email = ''
            if data.get('email_addresses'):
                email = data['email_addresses'][0].get('email_address', '')
                
            User.objects.filter(clerk_id=clerk_id).update(
                username=username or clerk_id,
                email=email,
            )
        elif evt_type == 'user.deleted':
            User.objects.filter(clerk_id=clerk_id).update(is_active=False)

        return Response(status=status.HTTP_200_OK)

