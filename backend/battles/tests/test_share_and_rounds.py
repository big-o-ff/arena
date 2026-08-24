"""Share card endpoint and current_round advancement."""
from __future__ import annotations

import pytest

from battles.models import Battle, BattleResult, Round, Submission

pytestmark = pytest.mark.django_db

ECHO_SOLUTION = "import sys\nprint(sys.stdin.read().strip())"


def _finish(battle):
    from battles.tasks import finalize_battle_if_active

    finalize_battle_if_active(battle.id)
    return BattleResult.objects.get(battle=battle)


class TestShareCard:
    def test_ended_summary_hands_out_a_share_path(self, battle, as_player1):
        _finish(battle)
        res = as_player1.get(f"/api/battles/{battle.id}/ended/")
        assert res.status_code == 200

        result = BattleResult.objects.get(battle=battle)
        assert res.data["share_url"] == f"/share/{result.share_uuid}"

    def test_card_is_readable_without_auth(self, battle, api_client):
        result = _finish(battle)
        res = api_client.get(f"/api/battles/share/{result.share_uuid}/")
        assert res.status_code == 200
        assert res.data["battle_id"] == battle.id
        assert res.data["player1"]["username"] == "alice"
        assert res.data["player2"]["username"] == "bob"

    def test_card_never_leaks_private_account_fields(self, battle, api_client):
        result = _finish(battle)
        res = api_client.get(f"/api/battles/share/{result.share_uuid}/")

        blob = str(res.data)
        assert "email" not in blob
        assert "clerk_id" not in blob
        for side in ("player1", "player2"):
            assert set(res.data[side]) == {"display_name", "username"}

    def test_winner_is_reported_as_a_slot_not_a_name(self, battle, api_client):
        Battle.objects.filter(pk=battle.pk).update(player2_hp=0)
        battle.refresh_from_db()
        result = _finish(battle)

        res = api_client.get(f"/api/battles/share/{result.share_uuid}/")
        assert res.data["winner_slot"] == 1
        assert res.data["is_draw"] is False

    def test_draw_reports_no_winner(self, battle, api_client):
        result = _finish(battle)  # equal HP → draw
        res = api_client.get(f"/api/battles/share/{result.share_uuid}/")
        assert res.data["winner_slot"] is None
        assert res.data["is_draw"] is True

    def test_unknown_uuid_is_404(self, api_client):
        res = api_client.get(
            "/api/battles/share/00000000-0000-0000-0000-000000000000/"
        )
        assert res.status_code == 404


class TestCurrentRoundAdvances:
    def test_first_solve_advances_the_round(self, battle, player1, problem, make_problem):
        """Regression: current_round was created at 1 and never incremented."""
        from battles.evaluation import evaluate_submission_sync

        # A second round so there is somewhere to advance to.
        Round.objects.create(battle=battle, problem=make_problem(), round_number=2)
        assert battle.current_round == 1

        submission = Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code=ECHO_SOLUTION,
            language="python",
            total_cases=len(problem.test_cases),
        )
        out = evaluate_submission_sync(submission.id)

        assert out["round_won"] is True
        assert out["current_round"] == 2
        battle.refresh_from_db()
        assert battle.current_round == 2

    def test_it_never_runs_past_the_last_round(self, battle, player1, problem):
        """Only one Round exists, so a solve must leave current_round at 1."""
        from battles.evaluation import evaluate_submission_sync

        assert battle.rounds.count() == 1

        submission = Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code=ECHO_SOLUTION,
            language="python",
            total_cases=len(problem.test_cases),
        )
        out = evaluate_submission_sync(submission.id)

        assert out["round_won"] is True
        battle.refresh_from_db()
        assert battle.current_round == 1

    def test_a_failed_submission_does_not_advance(self, battle, player1, problem, make_problem):
        from battles.evaluation import evaluate_submission_sync

        Round.objects.create(battle=battle, problem=make_problem(), round_number=2)

        submission = Submission.objects.create(
            battle=battle,
            player=player1,
            problem=problem,
            code="print('wrong')",
            language="python",
            total_cases=len(problem.test_cases),
        )
        out = evaluate_submission_sync(submission.id)

        assert out["round_won"] is False
        battle.refresh_from_db()
        assert battle.current_round == 1

    def test_the_same_player_resolving_does_not_advance_twice(
        self, battle, player1, problem, make_problem
    ):
        from battles.evaluation import evaluate_submission_sync

        Round.objects.create(battle=battle, problem=make_problem(), round_number=2)
        Round.objects.create(battle=battle, problem=make_problem(), round_number=3)

        for _ in range(2):
            submission = Submission.objects.create(
                battle=battle,
                player=player1,
                problem=problem,
                code=ECHO_SOLUTION,
                language="python",
                total_cases=len(problem.test_cases),
            )
            evaluate_submission_sync(submission.id)

        battle.refresh_from_db()
        assert battle.current_round == 2
