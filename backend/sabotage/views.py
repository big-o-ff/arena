from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, views
from rest_framework.response import Response
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from battles.models import Battle

from .models import SabotageMove
from .serializers import SabotageMoveSerializer


class SabotageTriggerView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, battle_id: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=battle_id)

        if battle.status != Battle.Status.ACTIVE:
            return Response(
                {"detail": "This battle is not active."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if request.user not in (battle.player1, battle.player2):
            return Response(
                {"detail": "You are not a participant in this battle."},
                status=status.HTTP_403_FORBIDDEN,
            )

        move_type = request.data.get("move_type")
        if move_type != SabotageMove.MoveType.GARBAGE_COLLECTION:
            return Response(
                {"detail": "Invalid or unsupported sabotage move."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Enforce single use per player per battle
        if SabotageMove.objects.filter(
            battle=battle, attacker=request.user, move_type=move_type
        ).exists():
            return Response(
                {"detail": "You have already used this sabotage in this battle."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ------------------------------------------------------------------
        # HP Deduction Transaction
        # ------------------------------------------------------------------
        with transaction.atomic():
            battle_lock = Battle.objects.select_for_update().get(pk=battle.id)
            
            is_player1 = request.user == battle_lock.player1
            my_hp = battle_lock.player1_hp if is_player1 else battle_lock.player2_hp
            
            cost = 80
            if my_hp < cost:
                return Response(
                    {"detail": f"Not enough HP! Garbage Collection costs {cost} HP."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Deduct HP
            if is_player1:
                battle_lock.player1_hp -= cost
            else:
                battle_lock.player2_hp -= cost
                
            battle_lock.save(update_fields=["player1_hp", "player2_hp"])

            # Create the record
            sabotage = SabotageMove.objects.create(
                battle=battle_lock,
                attacker=request.user,
                move_type=move_type,
            )

        # ------------------------------------------------------------------
        # Broadcasting Events
        # ------------------------------------------------------------------
        channel_layer = get_channel_layer()
        target_user_id = battle.player2_id if is_player1 else battle.player1_id
        
        # 1. Update HP for everyone
        async_to_sync(channel_layer.group_send)(
            f"battle_{battle.id}",
            {
                "type": "broadcast.event",
                "event": "HP_UPDATE",
                "payload": {
                    "battle_id": battle.id,
                    "player1_hp": battle_lock.player1_hp,
                    "player2_hp": battle_lock.player2_hp,
                },
            },
        )

        # 2. Start GC Sabotage
        async_to_sync(channel_layer.group_send)(
            f"battle_{battle.id}",
            {
                "type": "gc_start",
                "attacker_id": request.user.id,
                "target_user_id": target_user_id,
            },
        )

        # 3. Queue GC End task after 5 seconds
        from battles.tasks import send_gc_end
        send_gc_end.apply_async(
            (battle.id, target_user_id),
            countdown=5,
            queue="events"
        )
        
        # Check if paying the HP cost killed the player (unlikely, but safe)
        if battle_lock.player1_hp <= 0 or battle_lock.player2_hp <= 0:
            from battles.tasks import process_battle_end
            process_battle_end.apply_async((battle.id,), queue="events")

        serializer = SabotageMoveSerializer(sabotage)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

