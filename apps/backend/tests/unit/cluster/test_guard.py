"""Execution guard: plan freshness, execution token and capability rejection."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from llm_d_lens.cluster import execution, guard, registry
from llm_d_lens.cluster.evaluator import CapabilityReport
from llm_d_lens.cluster.plan import normalize_plan, plan_hashes
from llm_d_lens.db.dao.cluster import ClusterDao

CLUSTER_ID = "01234567"


def _cluster() -> registry.Cluster:
    return registry.create_cluster("guard-cluster", "", "kubeconfig: {}", draft=True)


def _plan():
    return normalize_plan(
        {
            "gateway": {"provider": "gke", "namespace": "lens-gateway", "name": "lens-gateway"},
            "accelerators": [],
            "storage": {"kind": "none"},
            "hfTokenSecret": {"tokenSource": "create-secret", "secretNamespace": "lens-gateway"},
            "modelCache": {"enabled": False},
            "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
            "runtime": {"inotifyEnabled": False},
        },
        cluster_id=CLUSTER_ID,
    )


def _store_plan(cluster_id: str) -> guard.PlanState:
    plan = _plan()
    assert ClusterDao().set_provisioning_plan(cluster_id, plan.model_dump(mode="json", by_alias=True)) is True
    return guard.require_plan(cluster_id, None)


def _report(**overrides) -> CapabilityReport:
    values = {
        "plan_hash": "plan-hash",
        "status": "sufficient",
        "sufficient": True,
        "identity": None,
        "checked_at": datetime(2026, 1, 1, tzinfo=UTC),
        "missing": [],
        "skipped": [],
    }
    values.update(overrides)
    return CapabilityReport(**values)


def test_load_plan_reports_a_missing_plan_and_hashes_a_stored_one():
    cluster = _cluster()
    assert guard.load_plan(cluster.id) is None

    state = _store_plan(cluster.id)
    hashes = plan_hashes(_plan())

    assert state.plan_hash == hashes.plan_hash
    assert state.plan_version == hashes.plan_version


def test_require_plan_rejects_missing_and_stale_plans():
    cluster = _cluster()

    with pytest.raises(guard.GuardError) as missing:
        guard.require_plan(cluster.id, None)
    assert missing.value.status_code == 409
    assert missing.value.code == "plan_missing"

    state = _store_plan(cluster.id)
    with pytest.raises(guard.GuardError) as stale:
        guard.require_plan(cluster.id, "not-the-plan-hash")
    assert stale.value.status_code == 409
    assert stale.value.code == "permission_check_stale"

    assert guard.require_plan(cluster.id, state.plan_hash).plan_hash == state.plan_hash


def test_require_execution_token_rejects_missing_wrong_and_expired_tokens(monkeypatch):
    cluster = _cluster()
    _store_plan(cluster.id)

    with pytest.raises(guard.GuardError) as missing:
        guard.require_execution_token(cluster.id, None)
    assert missing.value.code == "execution_token_invalid"

    with pytest.raises(guard.GuardError) as wrong:
        guard.require_execution_token(cluster.id, "wrong")
    assert wrong.value.code == "execution_token_invalid"

    token = execution.acquire(cluster.id)
    guard.require_execution_token(cluster.id, token)

    monkeypatch.setattr(guard.execution, "refresh", lambda *_args, **_kwargs: False)
    with pytest.raises(guard.GuardError) as expired:
        guard.require_execution_token(cluster.id, token)
    assert expired.value.code == "execution_token_invalid"


def test_load_plan_backfills_old_lws_version_into_the_hash(monkeypatch):
    cluster = _cluster()
    raw = _plan().model_dump(mode="json", by_alias=True)
    raw["planVersion"] = 2
    raw["stack"].pop("lwsVersion", None)
    assert ClusterDao().set_provisioning_plan(cluster.id, raw) is True

    state = guard.load_plan(cluster.id)
    assert state is not None
    assert state.plan.plan_version == 5
    assert state.plan.stack.lws_version
    assert state.plan_hash == plan_hashes(state.plan).plan_hash

    import llm_d_lens.cluster.plan as plan_module  # noqa: PLC0415

    monkeypatch.setattr(plan_module, "current_lws_version", lambda: "v999.0.0")
    changed = guard.load_plan(cluster.id)
    assert changed is not None
    assert changed.plan.stack.lws_version == "v999.0.0"
    assert changed.plan_hash != state.plan_hash


def test_old_plan_without_service_type_requires_a_resave():
    cluster = _cluster()
    raw = _plan().model_dump(mode="json", by_alias=True)
    raw["gateway"].pop("serviceType", None)
    assert ClusterDao().set_provisioning_plan(cluster.id, raw) is True

    state = guard.load_plan(cluster.id)
    assert state is not None
    assert state.requires_resave is True

    with pytest.raises(guard.GuardError) as error:
        guard.require_plan(cluster.id, None)
    assert error.value.code == "plan_resave_required"


def test_old_enabled_cache_plan_without_entry_id_requires_a_resave():
    cluster = _cluster()
    plan = normalize_plan(
        {
            "gateway": {"provider": "gke", "namespace": "lens-gateway", "name": "lens-gateway"},
            "accelerators": [],
            "storage": {
                "kind": "local-disk",
                "hostPath": "/data/models",
                "capacity": "50Gi",
                "purposes": ["model-cache"],
            },
            "hfTokenSecret": {"tokenSource": "create-secret", "secretNamespace": "lens-gateway"},
            "modelCache": {
                "enabled": True,
                "repoId": "org/model",
                "revision": "main",
                "storageVolumeRef": "lens-models",
            },
            "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
            "runtime": {"inotifyEnabled": False},
        },
        cluster_id=cluster.id,
    )
    raw = plan.model_dump(mode="json", by_alias=True)
    raw["modelCache"].pop("entryId", None)
    assert ClusterDao().set_provisioning_plan(cluster.id, raw) is True

    state = guard.load_plan(cluster.id)
    assert state is not None
    assert state.requires_resave is True
    assert state.plan.model_cache.entry_id


def test_old_disabled_cache_plan_without_entry_id_does_not_require_resave():
    cluster = _cluster()
    raw = _plan().model_dump(mode="json", by_alias=True)
    raw["modelCache"].pop("entryId", None)
    assert ClusterDao().set_provisioning_plan(cluster.id, raw) is True

    state = guard.load_plan(cluster.id)
    assert state is not None
    assert state.requires_resave is False


def _operation_report():
    from llm_d_lens.cluster.evaluator import OperationReport

    return OperationReport(
        plan_hash="plan-hash",
        plan_version=5,
        status="blocked",
        sufficient=False,
        checked_at=datetime(2026, 1, 1, tzinfo=UTC),
        user_operations=[{"id": "user.op", "executor": "user"}],
        admin_operations=[{"id": "admin.op", "executor": "admin"}],
        lens_operations=[{"id": "lens.op", "executor": "lens"}],
        blocked_operations=[{"id": "blocked.op", "executor": "user", "missing": [{"verb": "get"}]}],
        missing=[],
        marker={},
    )


def test_require_operation_only_accepts_user_operations():
    report = _operation_report()

    assert guard.require_operation(report, "user.op")["id"] == "user.op"
    with pytest.raises(guard.GuardError) as admin:
        guard.require_operation(report, "admin.op")
    assert admin.value.status_code == 409
    assert admin.value.code == "admin_operation_required"
    with pytest.raises(guard.GuardError) as blocked:
        guard.require_operation(report, "blocked.op")
    assert blocked.value.status_code == 409
    assert blocked.value.code == "operation_blocked"
    assert blocked.value.extra["operation_id"] == "blocked.op"
    with pytest.raises(guard.GuardError) as lens:
        guard.require_operation(report, "lens.op")
    assert lens.value.code == "admin_operation_required"
    with pytest.raises(guard.GuardError) as missing:
        guard.require_operation(report, "missing.op")
    assert missing.value.status_code == 404
    assert missing.value.code == "operation_not_found"


def test_begin_user_operation_acquires_then_refreshes_and_records_ledger():
    cluster = _cluster()
    state = _store_plan(cluster.id)

    token, acquired = guard.begin_user_operation(cluster.id, plan_hash=state.plan_hash)
    assert acquired is True
    assert guard.operation_ledger(cluster.id) == {}
    assert guard.record_operation(cluster.id, token, "user.op", "user_done") is True
    assert guard.operation_ledger(cluster.id) == {"user.op": "user_done"}

    same, acquired_again = guard.begin_user_operation(
        cluster.id,
        plan_hash=state.plan_hash,
        execution_token=token,
    )
    assert same == token
    assert acquired_again is False
    assert guard.record_operation(cluster.id, token, "admin.op", "admin_done") is True
    assert guard.operation_ledger(cluster.id) == {"user.op": "user_done", "admin.op": "admin_done"}

    with pytest.raises(guard.GuardError) as stale:
        guard.begin_user_operation(cluster.id, plan_hash="old-plan-hash")
    assert stale.value.code == "permission_check_stale"


def test_load_plan_returns_none_for_monitoring_only_legacy_cluster():
    cluster = registry.create_cluster("legacy-mon-cluster", "", "kubeconfig: {}", draft=False)
    registry.update_cluster_monitoring(
        cluster.id,
        {"mode": "existing", "namespace": "llm-d-monitoring", "prometheusUrl": "http://10.0.0.5:9090"},
    )

    assert guard.load_plan(cluster.id) is None
    with pytest.raises(guard.GuardError) as missing:
        guard.require_plan(cluster.id, None)
    assert missing.value.status_code == 409
    assert missing.value.code == "plan_missing"


def test_load_plan_accepts_legacy_plan_without_monitoring_key():
    cluster = _cluster()
    raw = _plan().model_dump(mode="json", by_alias=True)
    raw.pop("monitoring", None)
    assert ClusterDao().set_provisioning_plan(cluster.id, raw) is True

    state = guard.load_plan(cluster.id)
    assert state is not None
    assert state.requires_resave is False
    assert state.plan.monitoring.mode == "managed"
