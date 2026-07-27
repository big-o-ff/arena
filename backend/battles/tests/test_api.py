"""API-level behaviour, focused on the access-control fixes."""
from __future__ import annotations

import pytest
from django.urls import NoReverseMatch, reverse

from battles.models import Battle, BattleRequest, Submission
from battles.tests.conftest import ECHO_SOLUTION, WRONG_SOLUTION
from battles.views import _create_battle

pytestmark = pytest.mark.django_db


class TestForcedBattlesAreImpossible:
    def test_there_is_no_create_battle_endpoint(self):
        """
        The old POST /api/battles/create/ let any authenticated user drop an
        unwilling opponent into a rated 30-minute match.
        """
        with pytest.raises(NoReverseMatch):
            reverse("battle-create")

    def test_create_endpoint_returns_404(self, as_player1):
        assert as_player1.post("/api/battles/create/", {}).status_code == 404

    def test_cannot_battle_yourself(self, player1):
        with pytest.raises(ValueError, match="cannot battle themselves"):
            _create_battle(player1, player1)

    def test_cannot_invite_yourself(self, as_player1, player1):
        response = as_player1.post(
            "/api/battles/requests/", {"opponent_id": player1.id}, format="json"
        )
        assert response.status_code == 400

    def test_cannot_start_a_second_concurrent_battle(
        self, battle, player1, player2, make_problem
    ):
        make_problem(difficulty="medium")
        make_problem(difficulty="hard")
        with pytest.raises(ValueError, match="already in an active battle"):
            _create_battle(player1, player2)


class TestOpponentCodeIsNotLeaked:
    def _review(self, client, battle):
        problem = battle.rounds.first().problem
        return client.get(
            f"/api/battles/{battle.id}/problems/{problem.id}/review/"
        )

    def test_opponent_code_is_withheld_during_a_live_battle(
        self, battle, player1, player2, as_player1
    ):
        problem = battle.rounds.first().problem
        Submission.objects.create(
            battle=battle,
            player=player2,
            problem=problem,
            code="SECRET OPPONENT SOLUTION",
            language="python",
            status=Submission.Status.PASSED,
        )

        response = self._review(as_player1, battle)
        assert response.status_code == 200
        assert response.data["opponent_code_visible"] is False

        opponent = response.data["player2"]["submission"]
        assert opponent is not None
        assert opponent["code"] is None
        assert opponent["hidden"] is True
        assert "SECRET OPPONENT SOLUTION" not in str(response.data)

    def test_own_code_is_always_visible(self, battle, player1, as_player1):
        problem = battle.rounds.first().problem
        Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code="MY OWN SOLUTION",
            language="python",
            status=Submission.Status.PASSED,
        )
        response = self._review(as_player1, battle)
        assert response.data["player1"]["submission"]["code"] == "MY OWN SOLUTION"

    def test_opponent_code_is_released_after_the_battle_ends(
        self, battle, player2, as_player1
    ):
        problem = battle.rounds.first().problem
        Submission.objects.create(
            battle=battle,
            player=player2,
            problem=problem,
            code="SECRET OPPONENT SOLUTION",
            language="python",
            status=Submission.Status.PASSED,
        )
        Battle.objects.filter(pk=battle.pk).update(status=Battle.Status.COMPLETED)

        response = self._review(as_player1, battle)
        assert response.data["opponent_code_visible"] is True
        assert (
            response.data["player2"]["submission"]["code"]
            == "SECRET OPPONENT SOLUTION"
        )

    def test_outsiders_cannot_read_the_review(self, battle, outsider, api_client):
        api_client.force_authenticate(user=outsider)
        assert self._review(api_client, battle).status_code == 403

    def test_outsiders_cannot_read_battle_state(self, battle, outsider, api_client):
        api_client.force_authenticate(user=outsider)
        response = api_client.get(f"/api/battles/{battle.id}/state/")
        assert response.status_code == 403


class TestSubmissionRules:
    def _submit(self, client, battle, code=ECHO_SOLUTION):
        return client.post(
            f"/api/battles/{battle.id}/submit/",
            {
                "problem_id": battle.rounds.first().problem.id,
                "code": code,
                "language": "python",
            },
            format="json",
        )

    def test_a_failed_attempt_can_be_retried(self, battle, as_player1):
        """
        Regression: any prior submission used to block the problem permanently,
        so a single typo removed it from the match for that player.
        """
        first = self._submit(as_player1, battle, WRONG_SOLUTION)
        assert first.status_code in (200, 202)

        second = self._submit(as_player1, battle, ECHO_SOLUTION)
        assert second.status_code in (200, 202)

        assert Submission.objects.filter(
            battle=battle, status=Submission.Status.PASSED
        ).exists()

    def test_a_solved_problem_cannot_be_resubmitted(self, battle, as_player1):
        assert self._submit(as_player1, battle).status_code in (200, 202)
        again = self._submit(as_player1, battle)
        assert again.status_code == 400
        assert "already solved" in again.data["detail"].lower()

    def test_outsiders_cannot_submit(self, battle, outsider, api_client):
        api_client.force_authenticate(user=outsider)
        assert self._submit(api_client, battle).status_code == 403

    def test_cannot_submit_to_a_finished_battle(self, battle, as_player1):
        Battle.objects.filter(pk=battle.pk).update(status=Battle.Status.COMPLETED)
        assert self._submit(as_player1, battle).status_code == 400

    def test_unsupported_language_is_rejected(self, battle, as_player1):
        response = as_player1.post(
            f"/api/battles/{battle.id}/submit/",
            {
                "problem_id": battle.rounds.first().problem.id,
                "code": "print(1)",
                "language": "malbolge",
            },
            format="json",
        )
        assert response.status_code == 400

    def test_empty_code_is_rejected(self, battle, as_player1):
        assert self._submit(as_player1, battle, "   ").status_code == 400

    def test_problem_outside_the_battle_is_rejected(
        self, battle, as_player1, make_problem
    ):
        other = make_problem(difficulty="medium")
        response = as_player1.post(
            f"/api/battles/{battle.id}/submit/",
            {"problem_id": other.id, "code": ECHO_SOLUTION, "language": "python"},
            format="json",
        )
        assert response.status_code == 400

    def test_submission_status_is_private(self, battle, player1, as_player2):
        submission = Submission.objects.create(
            battle=battle,
            player=player1,
            problem=battle.rounds.first().problem,
            code="mine",
            language="python",
        )
        response = as_player2.get(
            f"/api/battles/{battle.id}/submissions/{submission.id}/"
        )
        assert response.status_code == 403


class TestResign:
    def test_resigning_hands_the_win_to_the_opponent(
        self, battle, player1, player2, as_player1
    ):
        response = as_player1.post(f"/api/battles/{battle.id}/resign/")
        assert response.status_code == 200

        battle.refresh_from_db()
        assert battle.status == Battle.Status.COMPLETED
        assert battle.winner_id == player2.id
        assert battle.ended_reason == "resign"
        assert battle.resigned_by_id == player1.id

    def test_outsiders_cannot_resign_someone_elses_battle(
        self, battle, outsider, api_client
    ):
        api_client.force_authenticate(user=outsider)
        assert api_client.post(f"/api/battles/{battle.id}/resign/").status_code == 403


class TestPublicEndpoints:
    def test_public_state_does_not_expose_account_metadata(self, battle, api_client):
        response = api_client.get(f"/api/battles/public/{battle.id}/state/")
        assert response.status_code == 200
        assert set(response.data["player1"]) == {"id", "username", "display_name"}
        assert "role" not in response.data["player1"]
        assert "date_joined" not in response.data["player1"]

    def test_live_list_is_public(self, battle, api_client):
        response = api_client.get("/api/battles/live/")
        assert response.status_code == 200
        assert [b["id"] for b in response.data] == [battle.id]


class TestInvites:
    def test_accepting_an_invite_creates_the_battle(
        self, player1, player2, make_problem, api_client
    ):
        make_problem(difficulty="easy")
        make_problem(difficulty="medium")
        make_problem(difficulty="hard")
        invite = BattleRequest.objects.create(from_user=player1, to_user=player2)

        api_client.force_authenticate(user=player2)
        response = api_client.post(f"/api/battles/requests/{invite.id}/accept/")

        assert response.status_code == 200
        battle = Battle.objects.get(pk=response.data["battle_id"])
        assert battle.status == Battle.Status.ACTIVE
        assert battle.rounds.count() == 3

    def test_only_the_recipient_can_accept(self, player1, player2, as_player1):
        invite = BattleRequest.objects.create(from_user=player1, to_user=player2)
        assert (
            as_player1.post(f"/api/battles/requests/{invite.id}/accept/").status_code
            == 404
        )

    def test_an_invite_cannot_be_accepted_twice(
        self, player1, player2, make_problem, api_client
    ):
        make_problem(difficulty="easy")
        make_problem(difficulty="medium")
        make_problem(difficulty="hard")
        invite = BattleRequest.objects.create(from_user=player1, to_user=player2)

        api_client.force_authenticate(user=player2)
        assert api_client.post(f"/api/battles/requests/{invite.id}/accept/").status_code == 200
        assert api_client.post(f"/api/battles/requests/{invite.id}/accept/").status_code == 400
