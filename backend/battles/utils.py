from __future__ import annotations

from dataclasses import dataclass

from .models import Battle, Round


@dataclass
class DamageResult:
    player1_hp: int
    player2_hp: int
    winner_id: int | None


def calculate_round_damage(
    battle: Battle,
    round_obj: Round,
) -> DamageResult:
    base_damage = 25

    if round_obj.player1_time_ms is None or round_obj.player2_time_ms is None:
        return DamageResult(battle.player1_hp, battle.player2_hp, None)

    diff = round_obj.player2_time_ms - round_obj.player1_time_ms
    faster_player = None

    if diff > 0:
        faster_player = 1
    elif diff < 0:
        faster_player = 2

    if faster_player is None:
        return DamageResult(battle.player1_hp, battle.player2_hp, None)

    time_factor = min(abs(diff) / 10_000, 2)
    damage = int(base_damage * (1 + time_factor))

    if faster_player == 1:
        player2_hp = max(0, battle.player2_hp - damage)
        player1_hp = battle.player1_hp
    else:
        player1_hp = max(0, battle.player1_hp - damage)
        player2_hp = battle.player2_hp

    winner_id = None
    if player1_hp == 0 or player2_hp == 0:
        winner_id = battle.player1_id if player2_hp == 0 else battle.player2_id

    return DamageResult(player1_hp=player1_hp, player2_hp=player2_hp, winner_id=winner_id)


def get_k_factor(rating: int) -> int:
    """Return K-factor based on current rating. Lower for higher ranks to reduce volatility."""
    if rating < 2100:
        return 32
    if rating < 2400:
        return 24
    return 16


def calculate_elo_deltas(
    player1_rating: int,
    player2_rating: int,
    winner_id: int | None,
    player1_id: int,
    player2_id: int,
) -> tuple[int, int]:
    """
    Calculate rating changes using standard ELO formula.
    Returns: (player1_delta, player2_delta)
    """
    # Expected scores
    e1 = 1 / (1 + 10 ** ((player2_rating - player1_rating) / 400))
    e2 = 1 / (1 + 10 ** ((player1_rating - player2_rating) / 400))

    # Actual scores
    s1, s2 = 0.5, 0.5  # default to draw
    if winner_id == player1_id:
        s1, s2 = 1.0, 0.0
    elif winner_id == player2_id:
        s1, s2 = 0.0, 1.0

    k1 = get_k_factor(player1_rating)
    k2 = get_k_factor(player2_rating)

    delta1 = round(k1 * (s1 - e1))
    delta2 = round(k2 * (s2 - e2))

    return delta1, delta2
