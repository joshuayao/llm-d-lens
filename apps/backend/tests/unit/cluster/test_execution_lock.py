"""Database-backed execution lock behavior using an injected clock."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from llm_d_lens.cluster import execution, registry


def _cluster() -> registry.Cluster:
    return registry.create_cluster("lock-cluster", "", "kubeconfig: {}", draft=True)


def test_acquire_rejects_a_live_lock_and_returns_a_token():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)

    token = execution.acquire(cluster.id, now=now)

    assert token
    assert execution.state(cluster.id)["token"] == token
    with pytest.raises(execution.ExecutionInProgress):
        execution.acquire(cluster.id, now=now + timedelta(seconds=1))


def test_refresh_cancel_and_release_require_the_current_token():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    token = execution.acquire(cluster.id, now=now)

    assert execution.refresh(cluster.id, "wrong", now=now + timedelta(seconds=30)) is False
    assert execution.refresh(cluster.id, token, now=now + timedelta(seconds=30)) is True
    assert execution.state(cluster.id)["heartbeat_at"] == now + timedelta(seconds=30)

    assert execution.cancel(cluster.id, "wrong") is False
    assert execution.cancel(cluster.id, token) is True
    assert execution.state(cluster.id)["cancel_requested"] is True

    assert execution.release(cluster.id, "wrong") is False
    assert execution.release(cluster.id, token) is True
    assert execution.state(cluster.id) == {
        "token": None,
        "started_at": None,
        "heartbeat_at": None,
        "cancel_requested": False,
    }


def test_expired_heartbeat_cannot_be_refreshed():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    token = execution.acquire(cluster.id, now=now)

    assert (
        execution.refresh(cluster.id, token, now=now + timedelta(seconds=execution.EXECUTION_STALE_SECONDS + 1))
        is False
    )


def test_a_stale_run_can_be_taken_over_and_clears_the_cancel_flag():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    old_token = execution.acquire(cluster.id, now=now)
    assert execution.cancel(cluster.id, old_token) is True

    takeover_at = now + timedelta(seconds=execution.EXECUTION_STALE_SECONDS + 1)
    new_token = execution.acquire(cluster.id, now=takeover_at)

    assert new_token != old_token
    assert execution.state(cluster.id) == {
        "token": new_token,
        "started_at": takeover_at,
        "heartbeat_at": takeover_at,
        "cancel_requested": False,
    }


def test_force_cancel_flags_any_live_run():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    execution.acquire(cluster.id, now=now)

    assert execution.cancel(cluster.id, "someone-else") is False
    assert execution.cancel(cluster.id, "someone-else", force=True) is True
    assert execution.state(cluster.id)["cancel_requested"] is True


def test_missing_cluster_and_unknown_cluster_state():
    assert execution.state("missing") is None
    with pytest.raises(execution.ExecutionInProgress):
        execution.acquire("missing", now=datetime(2026, 1, 1, tzinfo=UTC))
    assert execution.refresh("missing", "token") is False
    assert execution.release("missing", "token") is False


def test_acquire_uses_the_injected_module_clock(monkeypatch):
    cluster = _cluster()
    now = datetime(2026, 2, 2, 9, 30, tzinfo=UTC)
    monkeypatch.setattr(execution, "_now", lambda: now)

    token = execution.acquire(cluster.id)

    assert execution.state(cluster.id)["started_at"] == now
    assert execution.refresh(cluster.id, token) is True
    assert execution.state(cluster.id)["heartbeat_at"] == now


def test_complete_keeps_operations_and_completion_while_clearing_the_lock():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    token = execution.acquire(cluster.id, now=now)
    execution.mark_operation(cluster.id, token, "gateway.manifests", "user_done")

    assert execution.complete(cluster.id, "wrong-token", now=now) is False
    assert execution.complete(cluster.id, token, now=now) is True

    assert execution.is_completed(cluster.id) is True
    assert execution.state(cluster.id) == {
        "token": None,
        "started_at": None,
        "heartbeat_at": None,
        "cancel_requested": False,
    }
    assert execution.operations(cluster.id) == {"gateway.manifests": "user_done"}
    # release must not erase the completion record the finalize guard reads.
    assert execution.release(cluster.id, token) is False
    assert execution.is_completed(cluster.id) is True


def test_a_new_run_clears_the_previous_operation_ledger_and_completion():
    cluster = _cluster()
    now = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    token = execution.acquire(cluster.id, now=now)
    execution.mark_operation(cluster.id, token, "gateway.namespace", "user_done")
    assert execution.complete(cluster.id, token, now=now) is True
    assert execution.operations(cluster.id) == {"gateway.namespace": "user_done"}

    new_token = execution.acquire(cluster.id, now=now + timedelta(seconds=1))

    assert new_token != token
    assert execution.operations(cluster.id) == {}
    assert execution.is_completed(cluster.id) is False


@pytest.mark.asyncio
async def test_heartbeat_refreshes_until_the_context_exits(monkeypatch):
    cluster = _cluster()
    token = execution.acquire(cluster.id, now=datetime(2026, 1, 1, 12, 0, tzinfo=UTC))
    refreshed: list[tuple[str, str]] = []
    monkeypatch.setattr(execution, "refresh", lambda cluster_id, token: refreshed.append((cluster_id, token)) or True)

    async with execution.heartbeat(cluster.id, token, interval=0.01):
        await asyncio.sleep(0.05)

    count = len(refreshed)
    assert count >= 1
    assert set(refreshed) == {(cluster.id, token)}

    # Exiting the context cancels the refresh task.
    await asyncio.sleep(0.03)
    assert len(refreshed) == count
