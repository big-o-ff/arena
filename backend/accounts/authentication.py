import jwt
from rest_framework import authentication, exceptions
from accounts.models import User

class ClerkAuthentication(authentication.BaseAuthentication):
    def authenticate(self, request):
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return None

        token = auth_header.split(' ')[1]
        try:
            payload = jwt.decode(token, options={"verify_signature": False})
            clerk_id = payload.get('sub')

            if not clerk_id:
                raise exceptions.AuthenticationFailed('Invalid token payload')

            username = (
                payload.get('username') or
                payload.get('preferred_username') or
                clerk_id
            )

            from django.db import IntegrityError
            try:
                user, created = User.objects.update_or_create(
                    clerk_id=clerk_id,
                    defaults={
                        'username': username,
                        'display_name': f"Player_{username[:8]}",
                        'role': 'player'
                    }
                )
            except IntegrityError:
                # username taken by another user — use clerk_id suffix
                user, created = User.objects.update_or_create(
                    clerk_id=clerk_id,
                    defaults={
                        'username': f"{username}_{clerk_id[-4:]}",
                        'display_name': f"Player_{username[:8]}",
                        'role': 'player'
                    }
                )

            return (user, token)

        except jwt.InvalidTokenError:
            raise exceptions.AuthenticationFailed('Invalid Clerk token')
        except Exception as e:
            raise exceptions.AuthenticationFailed(str(e))