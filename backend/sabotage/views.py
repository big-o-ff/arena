from __future__ import annotations

import logging

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, views
from rest_framework.response import Response

from battles.events import broadcast_battle_event
from battles.models import Battle

from .models import SabotageMove
from .serializers import SabotageMoveSerializer

logger = logging.getLogger(__name__)

# HP the attacker pays to blank the opponent's editor for GC_DURATION_SECONDS.
#
# This was 80 of a 100 HP pool, which made the ability strictly self-defeating:
# the winner is decided by remaining HP, so spending 80 handed the match away,
# and it left the attacker one opponent solve (35) from elimination. 15 makes it
# a real trade-off — meaningful, recoverable, still cheaper than losing a round.
GC_HP_COST = 15
GC_DURATION_SECONDS = 5


class SabotageTriggerView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, battle_id: int, *args, **kwargs):
        move_type = request.data.get("move_type")
        if move_type != SabotageMove.MoveType.GARBAGE_COLLECTION:
            return Response(
                {"detail": "Invalid or unsupported sabotage move."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            battle = (
                Battle.objects.select_for_update().filter(pk=battle_id).first()
            )
            if battle is None:
                return Response(
                    {"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND
                )
            if request.user.id not in (battle.player1_id, battle.player2_id):
                return Response(
                    {"detail": "You are not a participant in this battle."},
                    status=status.HTTP_403_FORBIDDEN,
                )
            if battle.status != Battle.Status.ACTIVE:
                return Response(
                    {"detail": "This battle is not active."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            # Single use per player per battle. Checked under the same lock that
            # applies the cost, so two concurrent requests cannot both pass.
            if SabotageMove.objects.filter(
                battle=battle, attacker=request.user, move_type=move_type
            ).exists():
                return Response(
                    {"detail": "You have already used this sabotage in this battle."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            is_player1 = request.user.id == battle.player1_id
            my_hp = battle.player1_hp if is_player1 else battle.player2_hp

            # Must leave the attacker alive; paying your last HP to blank the
            # opponent's screen would end the match against you.
            if my_hp <= GC_HP_COST:
                return Response(
                    {
                        "detail": (
                            f"Not enough HP — Garbage Collection costs {GC_HP_COST} HP "
                            "and cannot reduce you to zero."
                        )
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if is_player1:
                battle.player1_hp = my_hp - GC_HP_COST
            else:
                battle.player2_hp = my_hp - GC_HP_COST
            battle.save(update_fields=["player1_hp", "player2_hp"])

            sabotage = SabotageMove.objects.create(
                battle=battle, attacker=request.user, move_type=move_type
            )
            target_user_id = battle.player2_id if is_player1 else battle.player1_id
            player1_hp, player2_hp = battle.player1_hp, battle.player2_hp

        broadcast_battle_event(
            battle_id,
            "HP_UPDATE",
            {
                "battle_id": battle_id,
                "player1_hp": player1_hp,
                "player2_hp": player2_hp,
            },
        )
        # Sent through the standard broadcast.event envelope. It used to be sent
        # as a raw {"type": "gc_start"} message, which the spectator consumer has
        # no handler for — Channels raises on an unknown type, so every spectator
        # was disconnected whenever anyone used this ability.
        broadcast_battle_event(
            battle_id,
            "GC_START",
            {
                "attacker_id": request.user.id,
                "target_user_id": target_user_id,
                "duration_seconds": GC_DURATION_SECONDS,
            },
        )

        try:
            from battles.tasks import send_gc_end

            send_gc_end.apply_async(
                (battle_id, target_user_id),
                countdown=GC_DURATION_SECONDS,
                queue="events",
            )
        except Exception:
            # Without a worker the overlay would never lift, so the client also
            # self-clears after duration_seconds.
            logger.exception("Could not schedule GC_END for battle %s", battle_id)

        return Response(
            SabotageMoveSerializer(sabotage).data, status=status.HTTP_201_CREATED
        )
