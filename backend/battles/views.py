import time
from collections import defaultdict
from threading import Lock

from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status, views
from rest_framework.response import Response
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from accounts.models import User
from problems.models import Problem

from .models import Battle, BattleRequest, Round, Submission
from .serializers import BattleRequestSerializer, BattleSerializer
from .execution import run_code_safe

# ---------------------------------------------------------------------------
# In-memory rate limiter for /run/ — 10 requests per minute per user+battle
# ---------------------------------------------------------------------------
_run_rate: dict[str, list[float]] = defaultdict(list)
_run_rate_lock = Lock()

RUN_LIMIT = 10       # max runs
RUN_WINDOW = 60.0    # seconds


def _check_run_rate(user_id: int, battle_id: int) -> bool:
    """Return True if the request is allowed, False if rate-limited."""
    key = f"{user_id}:{battle_id}"
    now = time.monotonic()
    with _run_rate_lock:
        timestamps = _run_rate[key]
        # Purge timestamps older than window
        _run_rate[key] = [t for t in timestamps if now - t < RUN_WINDOW]
        if len(_run_rate[key]) >= RUN_LIMIT:
            return False
        _run_rate[key].append(now)
        return True


def _create_battle(player1: User, player2: User) -> Battle:
    battle = Battle.objects.create(player1=player1, player2=player2)

    difficulties = ["easy", "medium", "hard"]
    for idx, diff in enumerate(difficulties, start=1):
        problem = (
            Problem.objects.filter(difficulty=diff, is_active=True).order_by("?").first()
        )
        if problem:
            Round.objects.create(
                battle=battle,
                problem=problem,
                round_number=idx,
            )

    battle.status = Battle.Status.ACTIVE
    battle.save(update_fields=["status"])

    # Inform connected clients that the first round is starting.
    # If the websocket layer (eg. Redis) is unavailable, we still want
    # the battle to be created successfully, so failures here are ignored.
    try:
        channel_layer = get_channel_layer()
        if channel_layer is not None:
            async_to_sync(channel_layer.group_send)(
                f"battle_{battle.id}",
                {
                    "type": "broadcast.event",
                    "event": "ROUND_START",
                    "payload": {
                        "battle_id": battle.id,
                        "current_round": battle.current_round,
                    },
                },
            )
    except Exception:
        # In dev or when Redis is down, just skip broadcasting.
        pass

    # Schedule Celery tasks for battle lifecycle
    try:
        from .tasks import process_battle_end, schedule_fog
        # 30-minute battle timeout
        process_battle_end.apply_async(
            (battle.id,), countdown=1800, queue="events",
        )
        # Fog cycle starts in 90 seconds
        schedule_fog.apply_async(
            (battle.id,), countdown=90, queue="events",
        )
    except Exception:
        pass

    return battle


class CreateBattleView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, *args, **kwargs):
        opponent_id = request.data.get("opponent_id")
        opponent = get_object_or_404(User, id=opponent_id)

        battle = _create_battle(request.user, opponent)

        return Response(BattleSerializer(battle).data, status=status.HTTP_201_CREATED)


class BattleRequestListCreateView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        pending = BattleRequest.objects.filter(
            to_user=request.user, status=BattleRequest.Status.PENDING
        ).select_related("from_user")
        serializer = BattleRequestSerializer(pending, many=True)
        return Response(serializer.data)

    def post(self, request, *args, **kwargs):
        opponent_id = request.data.get("opponent_id")
        opponent = get_object_or_404(User, id=opponent_id)
        if opponent == request.user:
            return Response(
                {"detail": "You cannot challenge yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Ensure opponent does not already have a pending invite from this user
        if BattleRequest.objects.filter(from_user=request.user, to_user=opponent, status=BattleRequest.Status.PENDING).exists():
            return Response(
                {"detail": "You already have a pending invite to this user."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        battle_request = BattleRequest.objects.create(
            from_user=request.user,
            to_user=opponent,
        )

        # Notify recipient via WS
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f"user_{opponent.id}",
                    {
                        "type": "battle_invite",
                        "battle_request_id": battle_request.id,
                        "from_id": request.user.id,
                        "from_username": request.user.username,
                        "expires_at": battle_request.expires_at.isoformat() if battle_request.expires_at else None,
                    },
                )
        except Exception:
            pass

        # Schedule expiry task
        try:
            from .tasks import expire_battle_request
            expire_battle_request.apply_async((battle_request.id,), countdown=300, queue="events")
        except Exception:
            pass

        return Response(
            {
                "battle_request_id": battle_request.id,
                "expires_at": battle_request.expires_at.isoformat() if battle_request.expires_at else None
            },
            status=status.HTTP_201_CREATED,
        )


class BattleRequestAcceptView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        from django.db import transaction
        from django.utils import timezone
        
        with transaction.atomic():
            battle_request = get_object_or_404(
                BattleRequest.objects.select_for_update(), pk=pk, to_user=request.user
            )
            
            if battle_request.status != BattleRequest.Status.PENDING:
                return Response(
                    {"detail": "This request has already been handled."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
                
            if battle_request.expires_at and battle_request.expires_at <= timezone.now():
                return Response(
                    {"detail": "Invite has expired."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            battle = _create_battle(battle_request.from_user, battle_request.to_user)
            battle_request.status = BattleRequest.Status.ACCEPTED
            battle_request.save(update_fields=["status"])

        # Broadcast to BOTH sender and recipient
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                for user_id in [battle_request.from_user_id, battle_request.to_user_id]:
                    async_to_sync(channel_layer.group_send)(
                        f"user_{user_id}",
                        {
                            "type": "battle_starting",
                            "battle_id": battle.id,
                        },
                    )
        except Exception:
            pass

        return Response({"battle_id": battle.id}, status=status.HTTP_200_OK)


class BattleRequestDeclineView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        battle_request = get_object_or_404(
            BattleRequest, pk=pk, to_user=request.user
        )
        if battle_request.status != BattleRequest.Status.PENDING:
            return Response(
                {"detail": "This request has already been handled."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        battle_request.status = BattleRequest.Status.DECLINED
        battle_request.save(update_fields=["status"])
        
        # Notify sender
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f"user_{battle_request.from_user_id}",
                    {
                        "type": "invite_declined",
                        "by_username": request.user.username,
                    },
                )
        except Exception:
            pass
            
        return Response(status=status.HTTP_200_OK)


class MyActiveBattleView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        battle = (
            Battle.objects.filter(status=Battle.Status.ACTIVE)
            .filter(Q(player1=request.user) | Q(player2=request.user))
            .order_by("-created_at")
            .first()
        )
        if not battle:
            return Response(status=status.HTTP_204_NO_CONTENT)
        return Response(BattleSerializer(battle).data)


class BattleStateView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=pk)
        return Response(BattleSerializer(battle).data)


class SubmitSolutionView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=pk)

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

        code = request.data.get("code", "")
        language = request.data.get("language", "python")
        problem_id = request.data.get("problem_id")

        if not code.strip():
            return Response(
                {"detail": "Code cannot be empty."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if language not in ("python", "javascript", "cpp"):
            return Response(
                {"detail": "Unsupported language."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Resolve the problem — must belong to a round in this battle
        if problem_id:
            problem = get_object_or_404(Problem, pk=problem_id)
            if not Round.objects.filter(battle=battle, problem=problem).exists():
                return Response(
                    {"detail": "This problem is not part of this battle."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            # Fallback: use current round's problem (backwards compat)
            round_obj = Round.objects.filter(
                battle=battle, round_number=battle.current_round
            ).first()
            if not round_obj:
                return Response(
                    {"detail": "No active round found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            problem = round_obj.problem

        # Check if player already submitted for this problem
        existing = Submission.objects.filter(
            battle=battle, player=request.user, problem=problem,
        ).first()
        if existing:
            return Response(
                {"detail": "You have already submitted for this problem."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Create submission with status=pending
        submission = Submission.objects.create(
            battle=battle,
            player=request.user,
            problem=problem,
            code=code,
            language=language,
            total_cases=len(problem.test_cases or []),
        )

        # Fire Celery task (non-blocking)
        from .tasks import evaluate_submission
        evaluate_submission.delay(submission.id)

        # Broadcast that a submission was received (opponent sees a toast)
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    f"battle_{battle.id}",
                    {
                        "type": "broadcast.event",
                        "event": "SUBMISSION_RECEIVED",
                        "payload": {
                            "player_id": request.user.id,
                            "problem_id": problem.id,
                        },
                    },
                )
        except Exception:
            pass  # Don't fail the submission if WS is down

        return Response(
            {"submission_id": submission.id, "status": "pending"},
            status=status.HTTP_202_ACCEPTED,
        )


class RunSolutionView(views.APIView):
    """POST /api/battles/{id}/run/

    Synchronously runs code against sample_input only.
    No HP changes, no WS broadcasts, no Celery.
    Rate limited: 10 runs / minute / user / battle.
    """

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=pk)

        if request.user not in (battle.player1, battle.player2):
            return Response(
                {"detail": "You are not a participant in this battle."},
                status=status.HTTP_403_FORBIDDEN,
            )

        if not _check_run_rate(request.user.id, pk):
            return Response(
                {"detail": "Rate limit exceeded — max 10 runs per minute."},
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

        problem_id = request.data.get("problem_id")
        code = request.data.get("code", "")
        language = request.data.get("language", "python")

        if not code.strip():
            return Response(
                {"detail": "Code cannot be empty."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if language not in ("python", "javascript", "cpp"):
            return Response(
                {"detail": "Unsupported language."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        problem = get_object_or_404(Problem, pk=problem_id)
        if not Round.objects.filter(battle=battle, problem=problem).exists():
            return Response(
                {"detail": "This problem is not part of this battle."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = run_code_safe(
            code=code,
            stdin_str=problem.sample_input,
            language=language,
            timeout=5,
        )

        actual = result.stdout.strip()
        expected = problem.sample_output.strip()
        passed = actual == expected

        return Response(
            {
                "passed": passed,
                "output": actual,
                "expected": expected,
                "execution_time_ms": result.elapsed_ms,
                "stderr": result.stderr or None,
            },
            status=status.HTTP_200_OK,
        )


class SimpleLeaderboardView(views.APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, *args, **kwargs):
        users = (
            User.objects.filter(role="player")
            .order_by("-total_wins", "total_losses")[:50]
            .values("username", "display_name", "total_wins", "total_losses")
        )
        return Response(list(users))


class ShareCardView(views.APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request, share_uuid: str, *args, **kwargs):
        from .models import BattleResult
        result = get_object_or_404(BattleResult.objects.select_related("battle__player1", "battle__player2"), share_uuid=share_uuid)
        battle = result.battle
        
        return Response({
            "battle_id": battle.id,
            "player1": battle.player1.username,
            "player2": battle.player2.username,
            "winner": battle.winner.username if battle.winner else None,
            "player1_rating_change": result.player1_rating_change,
            "player2_rating_change": result.player2_rating_change,
            "fastest_solve_ms": result.fastest_solve_time_ms,
            "problems_solved": result.problems_solved,
        })
