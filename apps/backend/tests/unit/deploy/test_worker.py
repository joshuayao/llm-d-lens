"""Deployment worker failure reporting tests."""

from types import SimpleNamespace

from llm_d_lens.deploy.worker import DeploymentRunWorker


def test_failure_detail_reports_invalid_hugging_face_model() -> None:
    execution = SimpleNamespace(
        diagnostics=SimpleNamespace(
            value={
                "reasons": ['error: deployment "modelserver" exceeded its progress deadline'],
                "snapshot": {
                    "modelserver_logs": (
                        "(APIServer pid=1) OSError: Qwen/Qwen3-0.3B is not a local folder and is not a valid "
                        "model identifier listed on 'https://huggingface.co/models'"
                    ),
                },
            }
        )
    )

    assert DeploymentRunWorker._failure_detail(execution) == (
        'modelserver could not access model "Qwen/Qwen3-0.3B": verify the model ID; if it is private or gated, '
        "enter a Hugging Face token below and retry"
    )


def test_restart_preserves_retry_eligibility_until_new_attempt_is_created(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock, Mock

    import pytest

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus, DeploymentStatus
    from llm_d_lens.deploy.plan_service import DeploymentPlanService

    async def check():
        for cleanup_status in [DeploymentStatus.FAILED, DeploymentStatus.CLEANED, DeploymentStatus.CLEANED_UP]:
            case = SimpleNamespace(id="original", status=DeploymentCaseStatus.FAILED)
            retry = SimpleNamespace(id="retry", status=DeploymentCaseStatus.QUEUED)
            run = SimpleNamespace(id="run", cases=[case], provenance={})
            store = SimpleNamespace(get_run=lambda _, run=run: run, save_run=Mock(), save_execution=Mock())
            service = SimpleNamespace(clean=AsyncMock(return_value=SimpleNamespace(status=cleanup_status)))
            worker = DeploymentRunWorker(store, service)
            worker._require_active_cluster_session = Mock()
            worker._case_execution = Mock(return_value=(run, case, SimpleNamespace(execution_id="execution")))
            worker._execute_retry = AsyncMock()

            def create_retry(self, run_id, case_id, case=case, run=run, retry=retry):
                assert case.status == DeploymentCaseStatus.FAILED
                run.cases.append(retry)
                return retry

            monkeypatch.setattr(DeploymentPlanService, "retry_case", create_retry)
            if cleanup_status == DeploymentStatus.FAILED:
                with pytest.raises(ValueError, match="could not be cleaned"):
                    await worker.restart_case("run", "original")
                assert run.cases == [case]
                continue
            assert await worker.restart_case("run", "original") is retry
            await asyncio.sleep(0)
            assert case.status == DeploymentCaseStatus.CLEANED
            assert run.cases == [case, retry]
            worker._execute_retry.assert_awaited_once_with("run", "retry", None)

    asyncio.run(check())


def test_failure_detail_reports_gated_hugging_face_model() -> None:
    execution = SimpleNamespace(
        diagnostics=SimpleNamespace(
            value={
                "snapshot": {
                    "modelserver_logs": "OSError: You are trying to access a gated repo. Request access first."
                }
            }
        )
    )

    assert DeploymentRunWorker._failure_detail(execution) == (
        "modelserver could not access the Hugging Face model: if it is private or gated, "
        "enter a Hugging Face token below and retry"
    )


def test_failure_detail_falls_back_to_readiness_reason() -> None:
    execution = SimpleNamespace(
        diagnostics=SimpleNamespace(
            value={"reasons": ['error: deployment "modelserver" exceeded its progress deadline']}
        )
    )

    assert DeploymentRunWorker._failure_detail(execution) == (
        "['error: deployment \"modelserver\" exceeded its progress deadline']"
    )


def test_failure_detail_reports_refreshed_readiness_error() -> None:
    execution = SimpleNamespace(
        diagnostics=SimpleNamespace(
            value={
                "readiness": ['deployments.apps "modelserver" not found'],
            }
        )
    )
    assert "modelserver" in DeploymentRunWorker._failure_detail(execution)


def test_evaluation_cancel_cleans_ready_and_inflight_resources_and_updates_run():
    import asyncio
    from unittest.mock import AsyncMock, Mock

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus, DeploymentRunStatus, DeploymentStatus

    async def check():
        ready = SimpleNamespace(id="ready", execution_id="e1", status=DeploymentCaseStatus.READY)
        deploying = SimpleNamespace(id="deploying", execution_id="e2", status=DeploymentCaseStatus.DEPLOYING)
        cleaned = SimpleNamespace(id="cleaned", execution_id="e3", status=DeploymentCaseStatus.CLEANED)
        pending = SimpleNamespace(id="pending", execution_id=None, status=DeploymentCaseStatus.QUEUED)
        run = SimpleNamespace(id="run", status=DeploymentRunStatus.RUNNING, cases=[ready, deploying, cleaned, pending])
        store = SimpleNamespace(get_run=lambda _: run, get_execution=lambda _: None, save_run=Mock())
        worker = DeploymentRunWorker(store, SimpleNamespace())
        order = []

        async def settle(_):
            order.append("settled")
            pending.status = DeploymentCaseStatus.CANCELLED
            deploying.status = DeploymentCaseStatus.CANCELLED

        async def clean(_, case_id):
            assert order[0] == "settled"
            order.append(case_id)
            next(case for case in run.cases if case.id == case_id).status = DeploymentCaseStatus.CLEANED
            return None, SimpleNamespace(status=DeploymentStatus.CLEANED)

        worker._cancel_and_wait = AsyncMock(side_effect=settle)
        worker.clean_case = AsyncMock(side_effect=clean)
        worker.delete_run = AsyncMock()
        await worker.cancel_evaluation_deployment("run")
        worker.delete_run.assert_awaited_once_with("run")
        assert order == ["settled", "ready", "deploying"]
        assert run.status == DeploymentRunStatus.CANCELLED
        assert ready.status == deploying.status == DeploymentCaseStatus.CLEANED
        assert pending.status == DeploymentCaseStatus.CANCELLED
        assert run.finished_at is not None

    asyncio.run(check())


def test_evaluation_cancel_does_not_report_success_when_cleanup_returns_ready():
    import asyncio
    from unittest.mock import AsyncMock, Mock

    import pytest

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus, DeploymentRunStatus, DeploymentStatus

    case = SimpleNamespace(id="ready", execution_id="e1", status=DeploymentCaseStatus.READY)
    run = SimpleNamespace(id="run", status=DeploymentRunStatus.SUCCEEDED, cases=[case])
    store = SimpleNamespace(get_run=lambda _: run, get_execution=lambda _: None, save_run=Mock())
    worker = DeploymentRunWorker(store, SimpleNamespace())
    worker._cancel_and_wait = AsyncMock()
    worker.clean_case = AsyncMock(return_value=(case, SimpleNamespace(status=DeploymentStatus.READY)))
    with pytest.raises(ValueError, match="did not confirm resource removal"):
        asyncio.run(worker.cancel_evaluation_deployment("run"))
    assert run.status == DeploymentRunStatus.SUCCEEDED


def test_cancel_is_not_overwritten_by_inflight_run_snapshot():
    import asyncio
    from copy import deepcopy

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus, DeploymentRunStatus

    async def check():
        run = SimpleNamespace(
            id="run",
            status=DeploymentRunStatus.QUEUED,
            failure_policy="stop",
            cases=[
                SimpleNamespace(
                    id="one", execution_id=None, status=DeploymentCaseStatus.QUEUED, ordinal=0, attempt=1, depends_on=[]
                ),
            ],
        )
        saved = [deepcopy(run)]
        store = SimpleNamespace(
            get_run=lambda _: deepcopy(saved[0]), save_run=lambda value: saved.__setitem__(0, deepcopy(value))
        )
        worker = DeploymentRunWorker(store, SimpleNamespace())
        entered = asyncio.Event()

        async def execute(stale_run, case):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                case.status = DeploymentCaseStatus.CANCELLED
                store.save_run(stale_run)

        worker._execute_case = execute
        task = asyncio.create_task(worker.execute_run("run"))
        await entered.wait()
        worker.request_cancel("run")
        await task
        assert saved[0].status == DeploymentRunStatus.CANCELLED
        assert saved[0].cases[0].status == DeploymentCaseStatus.CANCELLED

    asyncio.run(check())


def test_enable_ready_monitoring_falls_back_to_namespace_scoped_monitors_on_403_or_stack_not_ready(
    tmp_path, monkeypatch
):
    import asyncio

    import llm_d_lens.deploy.capabilities as caps
    from llm_d_lens.deploy.contracts import DeploymentStatus
    from llm_d_lens.deploy.run_store import JsonDeploymentRunStore
    from llm_d_lens.infrastructure.process import CommandResult
    from llm_d_lens.monitoring.deployment import service as monitoring
    from tests.unit.deploy.test_deployment_management import _execution

    async def check():
        store = JsonDeploymentRunStore(tmp_path)
        execution = _execution("exec-mon", DeploymentStatus.READY, "llmd-mon-ns")
        store.save_execution(execution)

        async def fail_enable(_execution_id):
            raise monitoring.DeploymentMonitoringError("apply_failed", "clusterrolebindings is forbidden", 500)

        applied = []

        class _Runner:
            async def run(self, argv, *, input=None, timeout=15):  # noqa: A002
                applied.append((argv, input))
                return CommandResult(tuple(argv), 0, "configured", "")

        monkeypatch.setattr(monitoring, "enable", fail_enable)
        monkeypatch.setattr(
            monitoring,
            "_discover_epp_service",
            lambda _ns, _cid: asyncio.sleep(
                0, result={"name": "svc-epp", "labels": {"app.kubernetes.io/name": "svc-epp"}}
            ),
        )
        monkeypatch.setattr(
            caps, "is_bootstrap_marker_present", lambda _cid, _ns, runner=None: asyncio.sleep(0, result=True)
        )
        monkeypatch.setattr("llm_d_lens.infrastructure.kubernetes.scoped_runner", lambda _cid: _Runner())

        worker = DeploymentRunWorker(store, SimpleNamespace())
        updated = await worker._enable_ready_monitoring(execution)
        assert updated.monitoring_setup["status"] == "ready"
        assert updated.monitoring_setup["enabled"] is True
        assert updated.monitoring_setup["mode"] == "namespace_scoped_fallback"
        assert len(applied) == 1
        assert applied[0][0] == ["kubectl", "apply", "--namespace", "llmd-mon-ns", "-f", "-"]
        assert "ServiceMonitor" in applied[0][1]
        assert "PodMonitor" in applied[0][1]
        assert "ClusterRole" not in applied[0][1]

        # 401 never falls back
        exec_401 = _execution("exec-401", DeploymentStatus.READY, "llmd-mon-401")
        store.save_execution(exec_401)

        async def fail_401(_execution_id):
            raise monitoring.DeploymentMonitoringError("apply_failed", "Unauthorized", 500)

        monkeypatch.setattr(monitoring, "enable", fail_401)
        updated_401 = await worker._enable_ready_monitoring(exec_401)
        assert updated_401.monitoring_setup["status"] == "unavailable"
        assert updated_401.monitoring_setup["code"] == "kubeconfig_unauthorized"

        # Secret/kubeconfig leakage is redacted in monitoring_setup message
        exec_leak = _execution("exec-leak", DeploymentStatus.READY, "llmd-mon-leak")
        store.save_execution(exec_leak)

        async def fail_leak(_execution_id):
            raise monitoring.DeploymentMonitoringError(
                "apply_failed",
                "failed --kubeconfig=/tmp/secret.kubeconfig Bearer secret.tok.123",
                500,
            )

        monkeypatch.setattr(monitoring, "enable", fail_leak)
        updated_leak = await worker._enable_ready_monitoring(exec_leak)
        assert updated_leak.monitoring_setup["status"] == "unavailable"
        assert "secret.kubeconfig" not in updated_leak.monitoring_setup["message"]
        assert "secret.tok.123" not in updated_leak.monitoring_setup["message"]

    asyncio.run(check())


def test_clean_case_propagates_cleanup_permission_denied(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock, Mock

    import pytest

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus
    from llm_d_lens.deploy.executions import DeploymentCleanupPermissionDenied

    case = SimpleNamespace(id="case-1", execution_id="exec-1", status=DeploymentCaseStatus.READY)
    run = SimpleNamespace(id="run-1", cases=[case], provenance={})
    store = SimpleNamespace(get_run=lambda _: run, save_run=Mock(), save_execution=Mock())
    service = SimpleNamespace(
        clean=AsyncMock(
            side_effect=DeploymentCleanupPermissionDenied(
                "admin needed",
                payload={"executionId": "exec-1", "adminCleanup": {"script": "#!/usr/bin/env bash"}},
            )
        )
    )
    worker = DeploymentRunWorker(store, service)
    worker._require_active_cluster_session = Mock()
    worker._case_execution = Mock(return_value=(run, case, SimpleNamespace(execution_id="exec-1")))

    with pytest.raises(DeploymentCleanupPermissionDenied) as exc:
        asyncio.run(worker.clean_case("run-1", "case-1"))
    assert exc.value.code == "deployment_cleanup_permission_denied"
    assert exc.value.payload["executionId"] == "exec-1"


def test_cancel_evaluation_propagates_cleanup_permission_denied_directly():
    import asyncio
    from unittest.mock import AsyncMock, Mock

    import pytest

    from llm_d_lens.deploy.contracts import DeploymentCaseStatus, DeploymentRunStatus
    from llm_d_lens.deploy.executions import DeploymentCleanupPermissionDenied

    case = SimpleNamespace(id="case-1", execution_id="exec-1", status=DeploymentCaseStatus.READY)
    run = SimpleNamespace(id="run-1", status=DeploymentRunStatus.CANCELLING, cases=[case], finished_at=None)
    store = SimpleNamespace(get_run=lambda _: run, get_execution=lambda _: None, save_run=Mock())
    worker = DeploymentRunWorker(store, SimpleNamespace())
    worker._cancel_and_wait = AsyncMock()
    worker.clean_case = AsyncMock(
        side_effect=DeploymentCleanupPermissionDenied(
            "admin needed",
            payload={"executionId": "exec-1", "phase1Completed": True, "adminCleanup": {"detail": "admin needed"}},
        )
    )
    worker.delete_run = AsyncMock()

    with pytest.raises(DeploymentCleanupPermissionDenied) as exc:
        asyncio.run(worker.cancel_evaluation_deployment("run-1"))
    assert exc.value.code == "deployment_cleanup_permission_denied"
    assert exc.value.payload["executionId"] == "exec-1"
    worker.delete_run.assert_not_awaited()

    # Generic errors still raise ValueError
    worker.clean_case = AsyncMock(side_effect=RuntimeError("transient error"))
    with pytest.raises(ValueError, match="deployment case case-1: transient error"):
        asyncio.run(worker.cancel_evaluation_deployment("run-1"))


def test_repeat_clean_preserves_phase1_deleted_resources(monkeypatch):
    import asyncio

    import pytest

    from llm_d_lens.deploy import orphans
    from llm_d_lens.deploy.contracts import DeploymentStatus
    from llm_d_lens.deploy.executions import DeploymentCleanupPermissionDenied
    from llm_d_lens.deploy.providers.guide_catalog import GuideCatalog
    from llm_d_lens.deploy.service import GuideAdapterDeploymentService
    from tests.unit.deploy.test_deployment_management import _execution

    class _Adapter:
        async def diagnostics(self, _exec):
            return {"ok": True}

        async def cleanup(self, _exec, _artifact, *, force=False):
            return {"cleaned_up": False, "error": 'namespaces "llmd-repeat" is forbidden'}

    catalog = GuideCatalog([])
    monkeypatch.setattr(catalog, "get_adapter", lambda _ref: _Adapter())
    svc = GuideAdapterDeploymentService(catalog, lambda _req: "llmd-repeat", log_archive=None)
    monkeypatch.setattr(orphans, "is_deletable_deployment_namespace", lambda _ns, cluster_id=None: True)

    calls = {"count": 0}

    async def fake_prepare_handoff(**_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "executionId": "exec-repeat",
                "clusterId": "cluster-1",
                "namespace": "llmd-repeat",
                "phase1Completed": True,
                "deletedInNamespace": ["deployments.apps", "jobs.batch", "rolebindings.rbac.authorization.k8s.io"],
                "adminCleanup": {
                    "detail": "Namespace cleanup requires admin",
                    "completedOperations": [{"id": "cleanup.in_namespace.deployments.apps"}],
                },
            }
        raise AssertionError("prepare_deployment_cleanup_handoff must not overwrite prior phase1 result")

    monkeypatch.setattr(orphans, "prepare_deployment_cleanup_handoff", fake_prepare_handoff)

    execution = _execution("exec-repeat", DeploymentStatus.READY, "llmd-repeat")

    with pytest.raises(DeploymentCleanupPermissionDenied) as first_exc:
        asyncio.run(svc.clean(execution))
    assert first_exc.value.payload["deletedInNamespace"] == [
        "deployments.apps",
        "jobs.batch",
        "rolebindings.rbac.authorization.k8s.io",
    ]

    persisted = svc._executions.get("exec-repeat")
    assert persisted is not None
    assert persisted.status == DeploymentStatus.ROLLED_BACK
    assert persisted.endpoint is None
    # Simulate an older persisted Phase-1 execution still marked READY -> repeat clean transitions it to ROLLED_BACK
    legacy_ready = persisted.model_copy(update={"status": DeploymentStatus.READY, "endpoint": execution.endpoint})
    with pytest.raises(DeploymentCleanupPermissionDenied) as repeat_exc:
        asyncio.run(svc.clean(legacy_ready))
    assert repeat_exc.value.payload["deletedInNamespace"] == [
        "deployments.apps",
        "jobs.batch",
        "rolebindings.rbac.authorization.k8s.io",
    ]
    assert repeat_exc.value.payload["adminCleanup"]["completedOperations"] == [
        {"id": "cleanup.in_namespace.deployments.apps"}
    ]
    updated_repeat = svc._executions.get("exec-repeat")
    assert updated_repeat is not None
    assert updated_repeat.status == DeploymentStatus.ROLLED_BACK
    assert updated_repeat.endpoint is None


def test_delete_case_execution_phase1_handoff_behavior_and_cancel_cleanup(tmp_path):
    import asyncio
    from uuid import uuid4

    import pytest

    from llm_d_lens.auth.records import RoleRecord, UserRecord, UserRoleBindingRecord
    from llm_d_lens.auth.service import default_service
    from llm_d_lens.db.dao.cluster import ClusterDao
    from llm_d_lens.db.dao.role import RoleDao
    from llm_d_lens.db.dao.user import UserDao
    from llm_d_lens.deploy.contracts import (
        DeployableConfiguration,
        DeploymentCaseStatus,
        DeploymentRun,
        DeploymentRunStatus,
        DeploymentStatus,
    )
    from llm_d_lens.deploy.executions import DeploymentCleanupPermissionDenied
    from llm_d_lens.deploy.run_store import JsonDeploymentRunStore
    from tests.unit.deploy.test_deployment_management import _case, _execution

    class _Phase1Service:
        async def clean(self, execution, *, preserve_rendered_overlay: bool = False):
            del preserve_rendered_overlay
            raise DeploymentCleanupPermissionDenied(
                "Namespace cleanup requires Orchestration administrator action.",
                payload={
                    "executionId": execution.execution_id,
                    "clusterId": "cluster-1",
                    "namespace": execution.namespace,
                    "phase1Completed": True,
                    "deletedInNamespace": ["deployments.apps", "pods"],
                    "adminCleanup": {"detail": "Admin required", "cleanupDigest": "a" * 64},
                },
            )

    def _seed_run(store, suffix: str, *, two_cases: bool = False):
        run_id = f"run-{suffix}"
        exec_id = f"exec-{suffix}"
        cases = [_case(run_id, 0, exec_id, DeploymentCaseStatus.READY).model_copy(update={"id": f"case-{suffix}-0"})]
        store.save_execution(_execution(exec_id, DeploymentStatus.READY, f"llmd-{suffix}"))
        if two_cases:
            sibling_id = f"exec-{suffix}-sibling"
            cases.append(
                _case(run_id, 1, sibling_id, DeploymentCaseStatus.READY).model_copy(update={"id": f"case-{suffix}-1"})
            )
            store.save_execution(_execution(sibling_id, DeploymentStatus.READY, f"llmd-{suffix}-sib"))
        store.create_run(
            DeploymentRun(
                id=run_id,
                status=DeploymentRunStatus.SUCCEEDED,
                cases=cases,
                source_configurations=[
                    DeployableConfiguration(
                        type="optimized-baseline",
                        format="helm",
                        provider_ref="optimized-baseline",
                        checksum="checksum",
                    )
                ],
                provenance={"cluster_server_id": "cluster-1"},
            )
        )
        return run_id, exec_id

    async def check():
        store = JsonDeploymentRunStore(tmp_path)
        auth_service = default_service()
        role = RoleDao().create(RoleRecord(name="worker-phase1-role"))
        cluster = ClusterDao().create(f"c-{uuid4().hex[:6]}", "", "apiVersion: v1\nkind: Config")
        user = UserDao().create(UserRecord(username=f"u-{uuid4().hex[:6]}"))

        def add_share(resource_type: str, resource_id: str) -> None:
            auth_service.user_binding_dao.create(
                UserRoleBindingRecord(
                    user_id=user.id,
                    role_id=role.id,
                    scope_type="resource",
                    scope_cluster_id=cluster.id,
                    scope_resource_type=resource_type,
                    scope_resource_id=resource_id,
                )
            )

        worker = DeploymentRunWorker(store, _Phase1Service())

        # 1. Standalone delete (remove_records_on_phase1_handoff=False): keeps records & transitions to ROLLED_BACK / STOPPED
        run_keep, exec_keep = _seed_run(store, "keep")
        add_share("deployment_execution", exec_keep)
        add_share("deployment_run", run_keep)
        with pytest.raises(DeploymentCleanupPermissionDenied) as keep_exc:
            await worker.delete_case_execution(run_keep, "case-keep-0")
        assert keep_exc.value.payload["phase1Completed"] is True
        retained_exec = store.get_execution(exec_keep)
        assert retained_exec is not None
        assert retained_exec.status == DeploymentStatus.ROLLED_BACK
        assert retained_exec.endpoint is None
        assert retained_exec.diagnostics.value["cleanup"]["phase1"]["phase1Completed"] is True
        retained_run = store.get_run(run_keep)
        assert retained_run is not None
        assert retained_run.cases[0].status == DeploymentCaseStatus.STOPPED
        assert len(auth_service.list_resource_shares("deployment_execution", exec_keep)) == 1

        # 2. Evaluation auto-cleanup (remove_records_on_phase1_handoff=True): drops run/exec & revokes shares, then re-raises
        run_eval, exec_eval = _seed_run(store, "eval")
        add_share("deployment_execution", exec_eval)
        add_share("deployment_run", run_eval)
        with pytest.raises(DeploymentCleanupPermissionDenied) as eval_exc:
            await worker.delete_case_execution(run_eval, "case-eval-0", remove_records_on_phase1_handoff=True)
        assert eval_exc.value.payload["phase1Completed"] is True
        assert store.get_execution(exec_eval) is None
        assert store.get_run(run_eval) is None
        assert auth_service.list_resource_shares("deployment_execution", exec_eval) == []
        assert auth_service.list_resource_shares("deployment_run", run_eval) == []

        # 3. Multi-case run with remove_records_on_phase1_handoff=True drops only that case/execution
        run_multi, exec_multi = _seed_run(store, "multi", two_cases=True)
        with pytest.raises(DeploymentCleanupPermissionDenied):
            await worker.delete_case_execution(run_multi, "case-multi-0", remove_records_on_phase1_handoff=True)
        assert store.get_execution(exec_multi) is None
        assert store.get_execution(f"{exec_multi}-sibling") is not None
        assert [c.id for c in store.get_run(run_multi).cases] == ["case-multi-1"]

        # 4. Evaluation cancel with Phase-1 403 drops ghost run/execution & revokes shares, then propagates handoff
        run_cancel, exec_cancel = _seed_run(store, "cancel")
        add_share("deployment_execution", exec_cancel)
        add_share("deployment_run", run_cancel)
        with pytest.raises(DeploymentCleanupPermissionDenied) as cancel_exc:
            await worker.cancel_evaluation_deployment(run_cancel)
        assert cancel_exc.value.payload["phase1Completed"] is True
        assert store.get_execution(exec_cancel) is None
        assert store.get_run(run_cancel) is None
        assert auth_service.list_resource_shares("deployment_execution", exec_cancel) == []
        assert auth_service.list_resource_shares("deployment_run", run_cancel) == []

    asyncio.run(check())
