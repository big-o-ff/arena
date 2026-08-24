from __future__ import annotations

import logging
import random
from datetime import timedelta

from django.db import transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, status, views
from rest_framework.response import Response

from accounts.models import User
from accounts.serializers import UserProfileSerializer
from problems.models import Problem
from problems.serializers import ProblemSerializer

from .events import _group_send as _send, broadcast_battle_event
from .execution import SUPPORTED_LANGUAGES, run_code_safe
from .models import Battle, BattleRequest, BattleReward, BattleResult, Round, Submission
from .serializers import (
    BattleRequestHistorySerializer,
    BattleRequestSerializer,
    BattleSerializer,
)

logger = logging.getLogger(__name__)

BATTLE_DURATION = timedelta(minutes=30)
INVITE_TTL = timedelta(minutes=30)
MAX_CODE_CHARS = 200 * 1024


def _expire_stale_pending_battle_requests() -> None:
    """Mark PENDING invites past expires_at as EXPIRED (DB and Celery can drift)."""
    BattleRequest.objects.filter(
        status=BattleRequest.Status.PENDING,
        expires_at__isnull=False,
        expires_at__lt=timezone.now(),
    ).update(status=BattleRequest.Status.EXPIRED)


def _has_active_battle(user_ids: list[int]) -> Battle | None:
    return (
        Battle.objects.filter(status=Battle.Status.ACTIVE)
        .filter(Q(player1_id__in=user_ids) | Q(player2_id__in=user_ids))
        .first()
    )


def _create_battle(player1: User, player2: User) -> Battle:
    if player1.id == player2.id:
        raise ValueError("A player cannot battle themselves.")

    existing = _has_active_battle([player1.id, player2.id])
    if existing is not None:
        raise ValueError(
            "One of the players is already in an active battle. "
            "Finish or resign it before starting another."
        )

    difficulties = ["easy", "medium", "hard"]
    selected_problem_ids: list[int] = []
    for diff in difficulties:
        candidate_ids = list(
            Problem.objects.filter(difficulty=diff, is_active=True)
            .exclude(test_cases=[])
            .exclude(id__in=selected_problem_ids)
            .values_list("id", flat=True)
        )
        if not candidate_ids:
            raise ValueError(f"No active {diff} problems with test cases available.")
        selected_problem_ids.append(random.choice(candidate_ids))

    selected_by_id = Problem.objects.in_bulk(selected_problem_ids)
    battle = Battle.objects.create(
        player1=player1,
        player2=player2,
        status=Battle.Status.ACTIVE,
        ends_at=timezone.now() + BATTLE_DURATION,
    )
    Round.objects.bulk_create(
        [
            Round(battle=battle, problem=selected_by_id[pid], round_number=idx)
            for idx, pid in enumerate(selected_problem_ids, start=1)
        ]
    )

    broadcast_battle_event(
        battle.id,
        "ROUND_START",
        {"battle_id": battle.id, "current_round": battle.current_round},
    )

    try:
        from .tasks import process_battle_end, schedule_fog

        process_battle_end.apply_async(
            (battle.id,), countdown=int(BATTLE_DURATION.total_seconds()), queue="events"
        )
        schedule_fog.apply_async((battle.id,), countdown=90, queue="events")
    except Exception:
        # Without a worker the battle still ends via maybe_finalize_expired_battle
        # on the next state read; fog simply won't fire.
        logger.exception("Could not schedule lifecycle tasks for battle %s", battle.id)

    return battle


class BattleRequestListCreateView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        pending = BattleRequest.objects.filter(
            to_user=request.user, status=BattleRequest.Status.PENDING
        ).select_related("from_user")
        return Response(BattleRequestSerializer(pending, many=True).data)

    def post(self, request, *args, **kwargs):
        opponent = get_object_or_404(User, id=request.data.get("opponent_id"))
        if opponent.id == request.user.id:
            return Response(
                {"detail": "You cannot challenge yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not opponent.is_active:
            return Response(
                {"detail": "That player is no longer active."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if BattleRequest.objects.filter(
            from_user=request.user,
            to_user=opponent,
            status=BattleRequest.Status.PENDING,
        ).exists():
            return Response(
                {"detail": "You already have a pending invite to this user."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        battle_request = BattleRequest.objects.create(
            from_user=request.user, to_user=opponent
        )

        _send(
            f"user_{opponent.id}",
            {
                "type": "battle_invite",
                "battle_request_id": battle_request.id,
                "from_id": request.user.id,
                "from_username": request.user.display_name or request.user.username,
                "expires_at": battle_request.expires_at.isoformat()
                if battle_request.expires_at
                else None,
            },
            context="battle invite",
        )

        try:
            from .tasks import expire_battle_request

            expire_battle_request.apply_async(
                (battle_request.id,),
                countdown=int(INVITE_TTL.total_seconds()),
                queue="events",
            )
        except Exception:
            logger.exception("Could not schedule expiry for invite %s", battle_request.id)

        return Response(
            {
                "battle_request_id": battle_request.id,
                "expires_at": battle_request.expires_at.isoformat()
                if battle_request.expires_at
                else None,
            },
            status=status.HTTP_201_CREATED,
        )


class BattleRequestHistoryView(views.APIView):
    """All battle requests where the current user is sender or recipient."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        _expire_stale_pending_battle_requests()
        qs = (
            BattleRequest.objects.filter(
                Q(from_user=request.user) | Q(to_user=request.user)
            )
            .select_related("from_user", "to_user")
            .order_by("-created_at")[:100]
        )
        return Response(
            BattleRequestHistorySerializer(
                qs, many=True, context={"request": request}
            ).data
        )


class BattleRequestAcceptView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        _expire_stale_pending_battle_requests()

        with transaction.atomic():
            battle_request = get_object_or_404(
                BattleRequest.objects.select_for_update().select_related(
                    "from_user", "to_user"
                ),
                pk=pk,
                to_user=request.user,
            )

            if battle_request.status != BattleRequest.Status.PENDING:
                detail = (
                    "Invite has expired. Ask for a new invite."
                    if battle_request.status == BattleRequest.Status.EXPIRED
                    else "This request has already been handled."
                )
                return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)

            if battle_request.expires_at and battle_request.expires_at <= timezone.now():
                battle_request.status = BattleRequest.Status.EXPIRED
                battle_request.save(update_fields=["status"])
                return Response(
                    {"detail": "Invite has expired. Ask for a new invite."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            try:
                battle = _create_battle(
                    battle_request.from_user, battle_request.to_user
                )
            except ValueError as exc:
                return Response(
                    {"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST
                )

            battle_request.status = BattleRequest.Status.ACCEPTED
            battle_request.save(update_fields=["status"])

        for user_id in (battle_request.from_user_id, battle_request.to_user_id):
            _send(
                f"user_{user_id}",
                {"type": "battle_starting", "battle_id": battle.id},
                context="battle starting",
            )

        return Response({"battle_id": battle.id}, status=status.HTTP_200_OK)


class BattleRequestDeclineView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        battle_request = get_object_or_404(BattleRequest, pk=pk, to_user=request.user)
        if battle_request.status != BattleRequest.Status.PENDING:
            return Response(
                {"detail": "This request has already been handled."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        battle_request.status = BattleRequest.Status.DECLINED
        battle_request.save(update_fields=["status"])

        _send(
            f"user_{battle_request.from_user_id}",
            {
                "type": "invite_declined",
                "by_username": request.user.display_name or request.user.username,
            },
            context="invite declined",
        )
        return Response(status=status.HTTP_200_OK)


class BattleRequestCancelView(views.APIView):
    """Sender withdraws a pending invite (frees the pair for a new request)."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        battle_request = get_object_or_404(BattleRequest, pk=pk, from_user=request.user)
        if battle_request.status != BattleRequest.Status.PENDING:
            return Response(
                {"detail": "This request has already been handled."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        battle_request.status = BattleRequest.Status.CANCELLED
        battle_request.save(update_fields=["status"])
        return Response(status=status.HTTP_204_NO_CONTENT)


class MyActiveBattleView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, *args, **kwargs):
        from .tasks import maybe_finalize_expired_battle

        battle = (
            Battle.objects.filter(status=Battle.Status.ACTIVE)
            .filter(Q(player1=request.user) | Q(player2=request.user))
            .order_by("-created_at")
            .first()
        )
        if battle is None:
            return Response(status=status.HTTP_204_NO_CONTENT)

        # Only the battle we're about to return needs an expiry check. The old
        # implementation swept every active battle for the user on each poll,
        # which the lobby hits every 5 seconds per client.
        if maybe_finalize_expired_battle(battle.id):
            return Response(status=status.HTTP_204_NO_CONTENT)

        return Response(BattleSerializer(battle).data)


class BattleStateView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk: int, *args, **kwargs):
        from .tasks import maybe_finalize_expired_battle

        maybe_finalize_expired_battle(pk)
        battle = get_object_or_404(
            Battle.objects.select_related("player1", "player2").prefetch_related(
                "rounds__problem"
            ),
            pk=pk,
        )
        if request.user.id not in (battle.player1_id, battle.player2_id):
            return Response(
                {"detail": "You are not a participant in this battle."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return Response(BattleSerializer(battle).data)


class BattleResignView(views.APIView):
    """POST — resign: set the resigner's HP to 0 so the opponent wins."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk: int, *args, **kwargs):
        from .tasks import finalize_battle_if_active

        with transaction.atomic():
            battle = (
                Battle.objects.select_for_update()
                .filter(pk=pk)
                .first()
            )
            if not battle:
                return Response(
                    {"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND
                )
            if request.user.id not in (battle.player1_id, battle.player2_id):
                return Response(
                    {"detail": "Not a participant."}, status=status.HTTP_403_FORBIDDEN
                )
            if battle.status != Battle.Status.ACTIVE:
                return Response(
                    {"detail": "Battle is not active."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            if request.user.id == battle.player1_id:
                battle.player1_hp = 0
            else:
                battle.player2_hp = 0
            battle.save(update_fields=["player1_hp", "player2_hp"])

        finalize_battle_if_active(
            pk, end_reason="resign", resigned_user_id=request.user.id
        )

        battle = get_object_or_404(
            Battle.objects.select_related("player1", "player2").prefetch_related(
                "rounds__problem"
            ),
            pk=pk,
        )
        return Response(BattleSerializer(battle).data)


class BattleEndedSummaryView(views.APIView):
    """GET — report card for a completed battle (participants only)."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk: int, *args, **kwargs):
        from .tasks import maybe_finalize_expired_battle

        maybe_finalize_expired_battle(pk)
        battle = get_object_or_404(
            Battle.objects.select_related("player1", "player2", "winner", "resigned_by"),
            pk=pk,
        )
        if request.user.id not in (battle.player1_id, battle.player2_id):
            return Response(
                {"detail": "Not a participant."}, status=status.HTTP_403_FORBIDDEN
            )
        if battle.status != Battle.Status.COMPLETED:
            return Response(
                {"detail": "Battle has not ended yet."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        result = BattleResult.objects.filter(battle=battle).first()
        if not result:
            return Response(
                {"detail": "Battle result not available."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(
            {
                "battle_id": battle.id,
                "status": battle.status,
                "ended_reason": battle.ended_reason,
                "winner_id": battle.winner_id,
                "resigned_by_id": battle.resigned_by_id,
                "player1": UserProfileSerializer(battle.player1).data,
                "player2": UserProfileSerializer(battle.player2).data,
                "player1_hp": battle.player1_hp,
                "player2_hp": battle.player2_hp,
                "player1_rating_change": result.player1_rating_change,
                "player2_rating_change": result.player2_rating_change,
                "problems_solved": result.problems_solved,
                "fastest_solve_time_ms": result.fastest_solve_time_ms,
                # Frontend-relative on purpose: the share card is a Next.js route,
                # not a backend page, so the client resolves it against its own origin.
                "share_url": f"/share/{result.share_uuid}",
            }
        )


class BattleShareCardView(views.APIView):
    """
    Public, unauthenticated report card addressed by `BattleResult.share_uuid`.

    The uuid is the capability — it is unguessable, so it can be handed out
    without exposing the numeric battle id. Deliberately narrower than the
    participant-only `/ended/` view: no submitted code, no email, no clerk id,
    and no account metadata beyond the two display names.
    """

    permission_classes = [permissions.AllowAny]
    throttle_scope = "public"

    def get(self, request, share_uuid, *args, **kwargs):
        result = get_object_or_404(
            BattleResult.objects.select_related(
                "battle__player1", "battle__player2"
            ),
            share_uuid=share_uuid,
        )
        battle = result.battle

        def public_player(user):
            return {"display_name": user.display_name, "username": user.username}

        # Slot, not name: two accounts can share a display_name, so the client
        # cannot reliably tell who won by comparing strings.
        winner_slot = None
        if battle.winner_id == battle.player1_id:
            winner_slot = 1
        elif battle.winner_id == battle.player2_id:
            winner_slot = 2

        return Response(
            {
                "battle_id": battle.id,
                "ended_reason": battle.ended_reason,
                "winner_slot": winner_slot,
                "is_draw": winner_slot is None,
                "player1": public_player(battle.player1),
                "player2": public_player(battle.player2),
                "player1_hp": battle.player1_hp,
                "player2_hp": battle.player2_hp,
                "player1_rating_change": result.player1_rating_change,
                "player2_rating_change": result.player2_rating_change,
                "problems_solved": result.problems_solved,
                "fastest_solve_time_ms": result.fastest_solve_time_ms,
                "ended_at": result.created_at,
            }
        )


class LiveBattlesListView(views.APIView):
    """Public list of active battles for the spectate lobby."""

    permission_classes = [permissions.AllowAny]
    throttle_scope = "public"

    def get(self, request, *args, **kwargs):
        from .tasks import maybe_finalize_expired_battle

        now = timezone.now()
        # Bounded sweep. This endpoint is unauthenticated, so an unbounded
        # finalize loop here was a write-amplified DoS: each request could
        # trigger 50 rating updates, result inserts and broadcasts.
        stale_ids = list(
            Battle.objects.filter(status=Battle.Status.ACTIVE, ends_at__lte=now)
            .values_list("id", flat=True)[:5]
        )
        for battle_id in stale_ids:
            maybe_finalize_expired_battle(battle_id)

        qs = (
            Battle.objects.filter(status=Battle.Status.ACTIVE)
            .select_related("player1", "player2")
            .order_by("-id")[:40]
        )
        return Response(
            [
                {
                    "id": b.id,
                    "player1": {
                        "display_name": b.player1.display_name,
                        "username": b.player1.username,
                    },
                    "player2": {
                        "display_name": b.player2.display_name,
                        "username": b.player2.username,
                    },
                    "player1_hp": b.player1_hp,
                    "player2_hp": b.player2_hp,
                    "spectator_likes": b.spectator_likes,
                    "current_round": b.current_round,
                }
                for b in qs
            ]
        )


class PublicBattleStateView(views.APIView):
    """Unauthenticated battle snapshot for spectators (HP, players, likes)."""

    permission_classes = [permissions.AllowAny]
    throttle_scope = "public"

    def get(self, request, pk: int, *args, **kwargs):
        from .tasks import maybe_finalize_expired_battle

        maybe_finalize_expired_battle(pk)
        battle = get_object_or_404(
            Battle.objects.select_related("player1", "player2"), pk=pk
        )
        if battle.status not in (Battle.Status.ACTIVE, Battle.Status.COMPLETED):
            return Response(
                {"detail": "Battle not available to spectate."},
                status=status.HTTP_404_NOT_FOUND,
            )

        def public_player(user):
            # Deliberately narrower than UserProfileSerializer: spectating is
            # anonymous, so it should not expose role or account age.
            return {
                "id": user.id,
                "username": user.username,
                "display_name": user.display_name,
            }

        return Response(
            {
                "id": battle.id,
                "status": battle.status,
                "player1": public_player(battle.player1),
                "player2": public_player(battle.player2),
                "player1_hp": battle.player1_hp,
                "player2_hp": battle.player2_hp,
                "spectator_likes": battle.spectator_likes,
                "current_round": battle.current_round,
            }
        )


class BattleProblemReviewView(views.APIView):
    """
    GET /api/battles/{id}/problems/{problem_id}/review/

    Your own submissions for this problem, plus the opponent's — but only once
    the battle is over. Returning both sides mid-battle turned this endpoint into
    a way to read your opponent's solution the moment they submitted it.
    """

    permission_classes = [permissions.IsAuthenticated]

    @staticmethod
    def _submission_payload(sub: Submission | None) -> dict | None:
        if sub is None:
            return None
        return {
            "id": sub.id,
            "code": sub.code,
            "language": sub.language,
            "status": sub.status,
            "passed_cases": sub.passed_cases,
            "total_cases": sub.total_cases,
            "execution_time_ms": sub.execution_time_ms,
            "submitted_at": sub.submitted_at,
        }

    @classmethod
    def _redacted_payload(cls, sub: Submission | None) -> dict | None:
        """Opponent progress without the code itself."""
        if sub is None:
            return None
        return {**cls._submission_payload(sub), "code": None, "hidden": True}

    def get(self, request, pk: int, problem_id: int, *args, **kwargs):
        battle = get_object_or_404(
            Battle.objects.select_related("player1", "player2"), pk=pk
        )
        if request.user.id not in (battle.player1_id, battle.player2_id):
            return Response(
                {"detail": "You are not a participant in this battle."},
                status=status.HTTP_403_FORBIDDEN,
            )
        problem = get_object_or_404(Problem, pk=problem_id)
        if not Round.objects.filter(battle=battle, problem=problem).exists():
            return Response(
                {"detail": "This problem is not part of this battle."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        latest = {}
        for player in (battle.player1, battle.player2):
            latest[player.id] = (
                Submission.objects.filter(
                    battle=battle, problem=problem, player=player
                )
                .order_by("-submitted_at")
                .first()
            )

        reveal_opponent = battle.status == Battle.Status.COMPLETED

        def side(player):
            sub = latest[player.id]
            is_me = player.id == request.user.id
            payload = (
                self._submission_payload(sub)
                if is_me or reveal_opponent
                else self._redacted_payload(sub)
            )
            return {"user": UserProfileSerializer(player).data, "submission": payload}

        my_reward = (
            BattleReward.objects.filter(
                battle=battle, user=request.user, problem=problem
            )
            .order_by("-created_at")
            .first()
        )

        return Response(
            {
                "battle_id": battle.id,
                "battle_status": battle.status,
                "opponent_code_visible": reveal_opponent,
                "problem": ProblemSerializer(problem).data,
                "my_reward": (
                    {
                        "reward_type": my_reward.reward_type,
                        "hp_damage_dealt": my_reward.hp_damage_dealt,
                        "created_at": my_reward.created_at,
                    }
                    if my_reward
                    else None
                ),
                "player1": side(battle.player1),
                "player2": side(battle.player2),
            }
        )


def _validate_code_payload(request) -> tuple[str, str] | Response:
    code = request.data.get("code") or ""
    language = request.data.get("language") or "python"

    if not isinstance(code, str) or not code.strip():
        return Response(
            {"detail": "Code cannot be empty."}, status=status.HTTP_400_BAD_REQUEST
        )
    if len(code) > MAX_CODE_CHARS:
        return Response(
            {"detail": "Submission is too large."}, status=status.HTTP_400_BAD_REQUEST
        )
    if language not in SUPPORTED_LANGUAGES:
        return Response(
            {"detail": "Unsupported language."}, status=status.HTTP_400_BAD_REQUEST
        )
    return code, language


class SubmitSolutionView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = "submit"

    def post(self, request, pk: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=pk)

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

        validated = _validate_code_payload(request)
        if isinstance(validated, Response):
            return validated
        code, language = validated

        problem_id = request.data.get("problem_id")
        if problem_id:
            problem = get_object_or_404(Problem, pk=problem_id)
            if not Round.objects.filter(battle=battle, problem=problem).exists():
                return Response(
                    {"detail": "This problem is not part of this battle."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        else:
            round_obj = Round.objects.filter(
                battle=battle, round_number=battle.current_round
            ).first()
            if not round_obj:
                return Response(
                    {"detail": "No active round found."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            problem = round_obj.problem

        # Retries are allowed; only a solved problem is closed off. Previously any
        # prior submission blocked further attempts, so one typo removed a problem
        # from the match permanently.
        if Submission.objects.filter(
            battle=battle,
            player=request.user,
            problem=problem,
            status=Submission.Status.PASSED,
        ).exists():
            return Response(
                {"detail": "You have already solved this problem."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if Submission.objects.filter(
            battle=battle,
            player=request.user,
            problem=problem,
            status=Submission.Status.PENDING,
        ).exists():
            return Response(
                {"detail": "A submission for this problem is still being judged."},
                status=status.HTTP_409_CONFLICT,
            )

        submission = Submission.objects.create(
            battle=battle,
            player=request.user,
            problem=problem,
            code=code,
            language=language,
            total_cases=len(problem.test_cases or []),
        )

        broadcast_battle_event(
            battle.id,
            "SUBMISSION_RECEIVED",
            {"player_id": request.user.id, "problem_id": problem.id},
        )

        # Judging can take tens of seconds (compile + N test cases) and must not
        # occupy an ASGI worker for the duration. The client polls the review
        # endpoint, and SUBMISSION_PASSED/FAILED arrives over the battle socket.
        queued = True
        try:
            from .tasks import evaluate_submission

            evaluate_submission.apply_async((submission.id,), queue="execution")
        except Exception:
            logger.exception(
                "Could not queue evaluation for submission %s; judging inline",
                submission.id,
            )
            queued = False

        if not queued:
            from .evaluation import evaluate_submission_sync

            evaluation = evaluate_submission_sync(submission.id)
            return Response(
                {"submission_id": submission.id, "queued": False, "evaluation": evaluation},
                status=status.HTTP_200_OK,
            )

        return Response(
            {
                "submission_id": submission.id,
                "queued": True,
                "status": Submission.Status.PENDING,
                "total_cases": submission.total_cases,
            },
            status=status.HTTP_202_ACCEPTED,
        )


class SubmissionStatusView(views.APIView):
    """GET — poll a submission's judging result (own submissions only)."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk: int, submission_id: int, *args, **kwargs):
        submission = get_object_or_404(
            Submission.objects.select_related("battle"),
            pk=submission_id,
            battle_id=pk,
        )
        if submission.player_id != request.user.id:
            return Response(
                {"detail": "Not your submission."}, status=status.HTTP_403_FORBIDDEN
            )
        return Response(
            {
                "submission_id": submission.id,
                "problem_id": submission.problem_id,
                "status": submission.status,
                "passed_cases": submission.passed_cases,
                "total_cases": submission.total_cases,
                "execution_time_ms": submission.execution_time_ms,
                "all_passed": submission.status == Submission.Status.PASSED,
            }
        )


class RunSolutionView(views.APIView):
    permission_classes = [permissions.IsAuthenticated]
    throttle_scope = "run"

    def post(self, request, pk: int, *args, **kwargs):
        battle = get_object_or_404(Battle, pk=pk)

        if request.user.id not in (battle.player1_id, battle.player2_id):
            return Response(
                {"detail": "You are not a participant in this battle."},
                status=status.HTTP_403_FORBIDDEN,
            )

        validated = _validate_code_payload(request)
        if isinstance(validated, Response):
            return validated
        code, language = validated

        problem = get_object_or_404(Problem, pk=request.data.get("problem_id"))
        if not Round.objects.filter(battle=battle, problem=problem).exists():
            return Response(
                {"detail": "This problem is not part of this battle."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        result = run_code_safe(
            code=code, stdin_str=problem.sample_input, language=language
        )

        actual = result.stdout.strip()
        expected = problem.sample_output.strip()
        passed = actual == expected and result.ok

        stderr = result.stderr or None
        broadcast_battle_event(
            battle.id,
            "PLAYER_SAMPLE_RUN",
            {
                "player_id": request.user.id,
                "passed": passed,
                "output": actual[:4000],
                "expected": expected,
                "execution_time_ms": result.elapsed_ms,
                "stderr": stderr[:4000] if stderr else None,
            },
        )

        return Response(
            {
                "passed": passed,
                "output": actual,
                "expected": expected,
                "execution_time_ms": result.elapsed_ms,
                "timed_out": result.timed_out,
                "stderr": stderr,
            },
            status=status.HTTP_200_OK,
        )
