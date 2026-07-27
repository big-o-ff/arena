"""Rating maths for battle settlement."""
from __future__ import annotations

# `calculate_round_damage` used to live here. Nothing ever called it, and the
# Round.player{1,2}_time_ms fields it read are never written — damage is applied
# in battles.evaluation when a player is first to pass every test case.


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
