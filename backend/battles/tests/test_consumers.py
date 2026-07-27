"""
WebSocket access control.

Two bugs live here historically:
  * the battle socket accepted anyone, and broadcast both players' raw editor
    buffers to a group the public spectate socket also joined — so a player
    could open /spectate/<their own battle> and read the opponent's solution;
  * the sabotage view sent a raw {"type": "gc_start"} message to that shared
    group, and the spectator consumer has no such handler, so Channels raised
    and disconnected every spectator.
"""
from __future__ import annotations

import pytest
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator

from battles.consumers import BattleConsumer
from battles.events import broadcast_battle_event, code_activity, spectator_group
from spectators.consumers import SpectatorConsumer


def _communicator(consumer_cls, battle_id, user):
    communicator = WebsocketCommunicator(consumer_cls.as_asgi(), f"/ws/{battle_id}/")
    communicator.scope["url_route"] = {"kwargs": {"battle_id": str(battle_id)}}
    communicator.scope["user"] = user
    return communicator


class AnonUser:
    is_authenticated = False
    id = None


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
class TestBattleConsumerAccess:
    async def test_participants_are_accepted(self, battle, player1):
        communicator = _communicator(BattleConsumer, battle.id, player1)
        connected, _ = await communicator.connect()
        assert connected is True
        await communicator.disconnect()

    async def test_outsiders_are_rejected(self, battle, outsider):
        communicator = _communicator(BattleConsumer, battle.id, outsider)
        connected, code = await communicator.connect()
        assert connected is False
        assert code == 4403

    async def test_anonymous_is_rejected(self, battle):
        communicator = _communicator(BattleConsumer, battle.id, AnonUser())
        connected, code = await communicator.connect()
        assert connected is False
        assert code == 4401


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
class TestSpectatorConsumerAccess:
    async def test_a_participant_cannot_spectate_their_own_battle(
        self, battle, player1
    ):
        """The exploit: watching your own match showed the opponent's code."""
        communicator = _communicator(SpectatorConsumer, battle.id, player1)
        connected, code = await communicator.connect()
        assert connected is False
        assert code == 4403

    async def test_anonymous_cannot_spectate(self, battle):
        communicator = _communicator(SpectatorConsumer, battle.id, AnonUser())
        connected, code = await communicator.connect()
        assert connected is False
        assert code == 4401

    async def test_a_third_party_can_spectate(self, battle, outsider):
        communicator = _communicator(SpectatorConsumer, battle.id, outsider)
        connected, _ = await communicator.connect()
        assert connected is True
        await communicator.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
class TestCodeRouting:
    async def test_opponent_receives_activity_not_code(self, battle, player1, player2):
        p1 = _communicator(BattleConsumer, battle.id, player1)
        p2 = _communicator(BattleConsumer, battle.id, player2)
        await p1.connect()
        await p2.connect()

        secret = "def solve():  # my secret approach\n    return 42"
        await p1.send_json_to({"type": "code_update", "code": secret})

        # PLAYER_JOINED frames arrive first; read past them to the one we want.
        message = None
        for _ in range(10):
            frame = await p2.receive_json_from(timeout=2)
            assert secret not in str(frame), "raw code reached the opponent"
            if frame["event"] == "OPPONENT_ACTIVITY":
                message = frame
                break

        assert message is not None, "opponent never received an activity update"
        assert "code" not in message["payload"]
        assert message["payload"]["chars"] == len(secret)
        assert message["payload"]["player_id"] == player1.id

        await p1.disconnect()
        await p2.disconnect()

    async def test_spectators_do_receive_the_code(self, battle, player1, outsider):
        p1 = _communicator(BattleConsumer, battle.id, player1)
        watcher = _communicator(SpectatorConsumer, battle.id, outsider)
        await p1.connect()
        await watcher.connect()

        secret = "print('hello from player one')"
        await p1.send_json_to({"type": "code_update", "code": secret})

        message = await watcher.receive_json_from(timeout=2)
        assert message["event"] == "OPPONENT_CODE"
        assert message["payload"]["code"] == secret

        await p1.disconnect()
        await watcher.disconnect()


@pytest.mark.django_db(transaction=True)
@pytest.mark.asyncio
async def test_gc_start_does_not_disconnect_spectators(battle, outsider):
    """
    Regression: GC was sent as {"type": "gc_start"}; SpectatorConsumer has no
    `gc_start` handler, and Channels raises ValueError on an unknown type, which
    tore down every spectator connection.
    """
    watcher = _communicator(SpectatorConsumer, battle.id, outsider)
    connected, _ = await watcher.connect()
    assert connected is True

    await database_sync_to_async(broadcast_battle_event)(
        battle.id, "GC_START", {"attacker_id": 1, "target_user_id": 2}
    )

    message = await watcher.receive_json_from(timeout=2)
    assert message["event"] == "GC_START"

    # Still alive — a following event must also arrive.
    await database_sync_to_async(broadcast_battle_event)(
        battle.id, "HP_UPDATE", {"player1_hp": 90, "player2_hp": 80}
    )
    followup = await watcher.receive_json_from(timeout=2)
    assert followup["event"] == "HP_UPDATE"

    await watcher.disconnect()


def test_code_activity_is_not_reversible():
    code = "secret solution text"
    activity = code_activity(code)
    assert set(activity) == {"chars", "lines", "non_empty_lines"}
    assert "secret" not in str(activity)
    assert activity["chars"] == len(code)
