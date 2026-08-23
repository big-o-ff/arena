"""Narrow regression tests for specific bugs found in the audit."""
from __future__ import annotations

import pytest

from battles.utils import calculate_elo_deltas, get_k_factor

pytestmark = pytest.mark.django_db


class TestAdminSubmissionLog:
    def test_serializer_builds(self):
        """
        Regression: the field was named `user`, but the model relates through
        `player`. DRF raised ImproperlyConfigured at field-build time, so GET
        /api/admin/submissions/ returned 500 on every request.
        """
        from dashboard.serializers import SubmissionLogSerializer

        fields = set(SubmissionLogSerializer().fields)
        assert "player" in fields
        assert "user" not in fields

    def test_endpoint_returns_data(self, battle, player1, make_user, api_client):
        from accounts.models import User
        from battles.models import Submission

        Submission.objects.create(
            battle=battle,
            player=player1,
            problem=battle.rounds.first().problem,
            code="print(1)",
            language="python",
            status=Submission.Status.PASSED,
        )
        admin = make_user(
            username="admin1", clerk_id="user_admin1", role=User.Role.ADMIN
        )
        api_client.force_authenticate(user=admin)

        response = api_client.get("/api/admin/submissions/")
        assert response.status_code == 200
        rows = response.data["results"]
        assert rows[0]["player"] == player1.username

    def test_non_admins_are_refused(self, as_player1):
        assert as_player1.get("/api/admin/submissions/").status_code == 403


class TestSabotageBalance:
    def test_gc_cost_leaves_the_attacker_alive(self, battle, as_player1):
        """
        Regression: GC cost 80 of a 100 HP pool. Since the winner is whoever has
        more HP, using it was a guaranteed loss.
        """
        from sabotage.views import GC_HP_COST

        assert GC_HP_COST < 35, "must cost less than a round loss"

        response = as_player1.post(
            f"/api/battles/{battle.id}/sabotage/",
            {"move_type": "GARBAGE_COLLECTION"},
            format="json",
        )
        assert response.status_code == 201

        battle.refresh_from_db()
        assert battle.player1_hp == 100 - GC_HP_COST
        assert battle.player1_hp > 0

    def test_cannot_spend_your_last_hp(self, battle, as_player1):
        from battles.models import Battle
        from sabotage.views import GC_HP_COST

        Battle.objects.filter(pk=battle.pk).update(player1_hp=GC_HP_COST)
        response = as_player1.post(
            f"/api/battles/{battle.id}/sabotage/",
            {"move_type": "GARBAGE_COLLECTION"},
            format="json",
        )
        assert response.status_code == 400

    def test_single_use_per_battle(self, battle, as_player1):
        payload = {"move_type": "GARBAGE_COLLECTION"}
        url = f"/api/battles/{battle.id}/sabotage/"
        assert as_player1.post(url, payload, format="json").status_code == 201
        assert as_player1.post(url, payload, format="json").status_code == 400

    def test_outsiders_cannot_sabotage(self, battle, outsider, api_client):
        api_client.force_authenticate(user=outsider)
        response = api_client.post(
            f"/api/battles/{battle.id}/sabotage/",
            {"move_type": "GARBAGE_COLLECTION"},
            format="json",
        )
        assert response.status_code == 403


class TestEloMaths:
    def test_even_match_win_moves_half_the_k_factor(self):
        d1, d2 = calculate_elo_deltas(1000, 1000, winner_id=1, player1_id=1, player2_id=2)
        assert d1 == 16 and d2 == -16

    def test_a_draw_between_equals_moves_nothing(self):
        d1, d2 = calculate_elo_deltas(1000, 1000, winner_id=None, player1_id=1, player2_id=2)
        assert d1 == 0 and d2 == 0

    def test_beating_a_stronger_player_gains_more(self):
        underdog, _ = calculate_elo_deltas(800, 1600, 1, 1, 2)
        favourite, _ = calculate_elo_deltas(1600, 800, 1, 1, 2)
        assert underdog > favourite

    def test_k_factor_tiers(self):
        assert get_k_factor(800) == 32
        assert get_k_factor(2200) == 24
        assert get_k_factor(2500) == 16

    def test_deltas_are_symmetric_at_equal_rating(self):
        d1, d2 = calculate_elo_deltas(1500, 1500, 2, 1, 2)
        assert d1 == -d2


class TestPublicProfileSerializer:
    def test_email_is_never_exposed(self, player1):
        """UserProfileSerializer is used on public endpoints."""
        from accounts.serializers import UserProfileSerializer

        player1.email = "private@example.com"
        player1.save(update_fields=["email"])
        data = UserProfileSerializer(player1).data

        assert "email" not in data
        assert "clerk_id" not in data
        assert "password" not in data
