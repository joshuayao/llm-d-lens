"""Entry-point parity: ownership controls cleanup, not measurement or analysis."""

import asyncio
import importlib
import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI

from llm_d_lens.deploy.contracts import DeployableConfiguration, DeploymentStatus
from llm_d_lens.infrastructure.artifacts.manifests import configuration_checksum
from tests.unit.evaluation.test_matrix import _FakeProcess, _patch_execute_dependencies

router = importlib.import_module("llm_d_lens.evaluation.router")
profiling = importlib.import_module("llm_d_lens.monitoring.profiling.service")
OWNERS = ["existing-endpoint", "evaluation"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership", OWNERS)
@pytest.mark.parametrize("already_ready", [True, False])
async def test_monitoring_setup_is_shared_and_reuses_healthy_targets(monkeypatch, ownership, already_ready):
    run = {"deployment_execution_id": "execution", "deployment_ownership": ownership}
    monkeypatch.setattr(router, "_save", lambda _: None)
    ready = AsyncMock(side_effect=[already_ready, True] if not already_ready else [True])
    enable = AsyncMock(return_value={"podmonitors": ["model"]})
    monkeypatch.setattr(router, "wait_for_deployment_metrics", ready)
    monkeypatch.setattr(router.deployment_monitoring, "enable", enable)
    await router._prepare_benchmark_monitoring(run)
    assert run["monitoring"]["status"] == "ready"
    assert run["monitoring"]["enabled"] is True
    if already_ready:
        enable.assert_not_awaited()
    else:
        enable.assert_awaited_once_with("execution", for_benchmark=True)
        assert run["monitoring"]["resources"]["podmonitors"] == ["model"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership", OWNERS)
async def test_monitoring_discovery_is_bounded_and_prevents_unmonitored_run(monkeypatch, ownership):
    cancelled = asyncio.Event()

    async def blocked(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router, "wait_for_deployment_metrics", blocked)
    monkeypatch.setattr(router, "_MONITORING_PREPARE_TIMEOUT", 0.01)
    run = {"deployment_execution_id": "execution", "deployment_ownership": ownership}
    with pytest.raises(RuntimeError, match="Benchmark traffic was not started"):
        await router._prepare_benchmark_monitoring(run)
    assert cancelled.is_set()
    assert run["monitoring"]["status"] == "unavailable"
    assert "exceeded" in run["monitoring"]["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership", OWNERS)
async def test_monitoring_cancellation_is_not_swallowed(monkeypatch, ownership):
    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router, "wait_for_deployment_metrics", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await router._prepare_benchmark_monitoring(
            {"deployment_execution_id": "execution", "deployment_ownership": ownership}
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("ownership", OWNERS)
async def test_runner_never_starts_traffic_when_monitoring_setup_fails(monkeypatch, tmp_path, ownership):
    run = {
        "id": "parity",
        "deployment_execution_id": "execution",
        "deployment_ownership": ownership,
        "specification_file": "guides/optimized-baseline",
        "harness": "inference-perf",
        "workload": "sanity_random.yaml",
        "parallelism": 1,
        "wait_timeout_seconds": 60,
    }
    calls = _patch_execute_dependencies(monkeypatch, tmp_path, run, [_FakeProcess(0)])
    monkeypatch.setattr(router, "wait_for_deployment_metrics", AsyncMock(return_value=False))
    monkeypatch.setattr(router.deployment_monitoring, "enable", AsyncMock(side_effect=ValueError("RBAC forbidden")))
    collect = AsyncMock()
    monkeypatch.setattr(router, "collect_benchmark_observability", collect)
    await router._execute(run["id"])
    assert run["status"] == "failed"
    assert "RBAC forbidden" in run["error"]
    assert "traffic was not started" in run["monitoring"]["message"]
    assert calls == []
    collect.assert_not_awaited()


def make_record(ownership):
    content = {
        "model": {"name": "test-model"},
        "prefill": {"replicaCount": 1, "tensorParallelSize": 2},
        "decode": {"replicaCount": 2, "tensorParallelSize": 1},
    }
    configuration = DeployableConfiguration(
        type="guide",
        provider_ref="pd-disaggregation",
        format="helm",
        content=content,
        checksum=configuration_checksum(content),
    )
    return {
        "id": "run",
        "kind": "benchmark",
        "status": "succeeded",
        "deployment_ownership": ownership,
        "deployment_configuration": configuration.model_dump(mode="json"),
        "metrics": {},
        "sla_targets": {"success_rate_min_percent": 99},
        "rate_stage_results": [
            {"rate": 10, "metrics": {"throughput_rps": 9.8, "success_rate": 100}},
            {"rate": 20, "metrics": {"throughput_rps": 15, "success_rate": 96}},
        ],
    }


@pytest.mark.asyncio
async def test_standalone_and_workflow_detail_have_identical_enrichment(monkeypatch):
    standalone = make_record("existing-endpoint")
    owned = make_record("evaluation")
    case = {**deepcopy(owned), "kind": "guide", "evaluation_run_id": "run", "workload_ids": ["workload"]}
    workflow = {"id": "workflow", "status": "succeeded", "cases": [case]}
    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router, "_get", lambda kind, _: workflow if kind == "workflow" else standalone)
    single = await router.get_run("run")
    monkeypatch.setattr(router, "_get", lambda kind, _: workflow if kind == "workflow" else owned)
    details = await router.get_workflow_run_details("workflow")
    assert single["metrics"] == details["cases"][0]["case"]["metrics"] == details["cases"][0]["evaluation"]["metrics"]
    assert single["metrics"]["maximum_stable_qps"] == 10
    assert single["metrics"]["slo_goodput_rps"] == 9.8
    assert single["metrics"]["mechanism_metrics"]["pd_topology"] == "1P×TP2 / 2D×TP1"
    assert single["metrics"]["diagnoses"]


@pytest.mark.asyncio
async def test_standalone_hydrates_read_only_context_without_recapturing_history(monkeypatch):
    run = {
        "id": "run",
        "kind": "benchmark",
        "status": "succeeded",
        "deployment_execution_id": "execution",
        "deployment_ownership": "existing-endpoint",
        "metrics": {},
    }
    configuration = DeployableConfiguration.model_validate(make_record("evaluation")["deployment_configuration"])
    execution = SimpleNamespace(
        namespace="model-ns",
        status=DeploymentStatus.READY,
        monitoring_setup={"status": "enabled"},
        diagnostics=None,
        configuration_artifacts=[],
        endpoint=SimpleNamespace(url="http://model", model_ref="test-model"),
    )
    deployment = SimpleNamespace(
        id="deployment",
        source_configurations=[configuration],
        cases=[SimpleNamespace(id="case", execution_id="execution", source_configuration_ordinal=0)],
    )
    monkeypatch.setattr(
        router, "_store", SimpleNamespace(get_execution=lambda _: execution, list_runs=lambda: [deployment])
    )
    monkeypatch.setattr(router, "_get", lambda *_: run)
    monkeypatch.setattr(router, "_save", lambda _: None)
    capture = AsyncMock(side_effect=AssertionError("GET must not recapture historical resources"))
    monkeypatch.setattr(router, "_kubernetes_resource_snapshot", capture)
    result = await router.get_run("run")
    assert result["namespace"] == "model-ns"
    assert result["configuration"]["guide"] == "pd-disaggregation"
    assert result["configuration"]["tensor_parallel_size"] == 1
    assert result["deployment_cases"][0]["execution_status"] == "ready"
    assert result["deployment_ownership"] == "existing-endpoint"
    assert not result.get("resource_snapshot")
    capture.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "up_pods,sample_pods,epp_up,expected",
    [
        (["exporter"], [], True, False),
        (["decode"], ["decode"], True, False),
        (["decode", "prefill"], ["decode", "prefill"], False, False),
        (["decode", "prefill"], ["decode", "prefill"], True, True),
    ],
)
async def test_readiness_requires_every_serving_pod_and_epp(monkeypatch, up_pods, sample_pods, epp_up, expected):
    monkeypatch.setattr(profiling, "_deployment_target", lambda *_: (None, "model-ns", "cluster"))
    monkeypatch.setattr(profiling, "_prometheus_local_port", AsyncMock(return_value=12345))
    monkeypatch.setattr(
        profiling,
        "_discover_components",
        AsyncMock(return_value={"prefill": ["prefill"], "decode": ["decode"], "epp": ["router"]}),
    )

    async def query(_client, expression):
        if expression.startswith("up{"):
            return [{"metric": {"pod": p}, "value": [0, "1"]} for p in up_pods] + (
                [{"metric": {"service": "router"}, "value": [0, "1"]}] if epp_up else []
            )
        assert expression == 'count_over_time(vllm:num_requests_running{namespace="model-ns"}[30s])'
        return [{"metric": {"pod": p}, "value": [0, "2"]} for p in sample_pods]

    monkeypatch.setattr(profiling, "_query", query)
    assert await profiling.wait_for_deployment_metrics("execution", timeout_seconds=0) is expected


@pytest.mark.asyncio
async def test_delayed_targets_block_preparation_until_ready(monkeypatch):
    release = asyncio.Event()
    entered = asyncio.Event()
    calls = 0

    async def ready(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return False
        entered.set()
        await release.wait()
        return True

    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router, "wait_for_deployment_metrics", ready)
    monkeypatch.setattr(router.deployment_monitoring, "enable", AsyncMock(return_value={}))
    run = {"deployment_execution_id": "execution", "wait_timeout_seconds": 60}
    task = asyncio.create_task(router._prepare_benchmark_monitoring(run))
    await entered.wait()
    assert not task.done()
    assert run["monitoring"]["status"] == "preparing"
    assert run["heartbeat_at"]
    release.set()
    await task
    assert run["monitoring"]["status"] == "ready"


def test_openapi_describes_shared_result_contract():
    app = FastAPI()
    app.include_router(router.router)
    paths = app.openapi()["paths"]
    assert "same runner" in paths["/api/v1/evaluate/runs"]["post"]["description"]
    assert "deployment_cases" in paths["/api/v1/evaluate/runs/{run_id}"]["get"]["description"]


def test_workflow_and_standalone_share_all_workload_defaults_and_validation():
    from llm_d_lens.evaluation.models import BenchmarkSpec

    request = router.EvaluateRunRequest(deployment_execution_id="execution")
    assert request.model_dump(include=set(BenchmarkSpec.model_fields)) == BenchmarkSpec().model_dump()
    for field in BenchmarkSpec.model_fields:
        assert (
            router.EvaluateRunRequest.model_json_schema()["properties"][field]
            == BenchmarkSpec.model_json_schema()["properties"][field]
        )


@pytest.mark.asyncio
async def test_cancelling_monitoring_wait_cancels_child_poll(monkeypatch):
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    calls = 0

    async def ready(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return False
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router, "wait_for_deployment_metrics", ready)
    monkeypatch.setattr(router.deployment_monitoring, "enable", AsyncMock(return_value={}))
    task = asyncio.create_task(router._prepare_benchmark_monitoring({"deployment_execution_id": "execution"}))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_non_admin_prepare_benchmark_monitoring_succeeds_via_prometheus_http_on_403(monkeypatch):
    from llm_d_lens.monitoring.deployment.service import DeploymentMonitoringError
    from llm_d_lens.monitoring.prometheus import PrometheusEndpoint

    handoff_err = DeploymentMonitoringError(
        "admin_handoff_required",
        (
            "Orchestration administrator permissions are required to complete this deployment monitoring action "
            '(config file "/var/lib/lens/kubeconfig_cache/c-na.kubeconfig", Bearer secret-tok-xyz).'
        ),
        403,
    )
    monkeypatch.setattr(router, "_save", lambda _: None)
    monkeypatch.setattr(router.deployment_monitoring, "enable", AsyncMock(side_effect=handoff_err))

    # 1. With configured Prometheus HTTP URL: skips 403 failure and polls Prometheus HTTP API to readiness
    wait_calls = []

    async def fake_wait(execution_id, timeout_seconds=20.0, *, allow_optional_epp=False):
        wait_calls.append((execution_id, timeout_seconds, allow_optional_epp))
        return timeout_seconds > 0

    monkeypatch.setattr(router, "wait_for_deployment_metrics", fake_wait)
    monkeypatch.setattr(
        router,
        "resolve_prometheus_endpoint",
        AsyncMock(return_value=PrometheusEndpoint(base_url="http://10.20.30.40:30090", source="explicit_url")),
    )
    run = {"id": "run-non-admin", "deployment_execution_id": "exec-na", "cluster_id": "c-na", "namespace": "ns-na"}
    await router._prepare_benchmark_monitoring(run)
    assert run["monitoring"]["status"] == "ready"
    assert run["monitoring"]["enabled"] is True
    assert run["monitoring"]["source"] == "prometheus_http"
    assert "secret-tok-xyz" not in run["monitoring"]["permission_note"]
    assert "kubeconfig_cache" not in run["monitoring"]["permission_note"]
    assert wait_calls == [("exec-na", 0, False), ("exec-na", 600.0, True)]

    # 2. Without configured Prometheus HTTP URL: surfaces redacted 403 Orchestration administrator error
    monkeypatch.setattr(router, "resolve_prometheus_endpoint", AsyncMock(return_value=None))
    run_no_prom = {"id": "run-no-prom", "deployment_execution_id": "exec-na", "cluster_id": "c-na"}
    with pytest.raises(RuntimeError, match="Orchestration administrator permissions are required") as no_prom_exc:
        await router._prepare_benchmark_monitoring(run_no_prom)
    assert "secret-tok-xyz" not in str(no_prom_exc.value)
    assert "kubeconfig_cache" not in str(no_prom_exc.value)
    assert run_no_prom["monitoring"]["status"] == "unavailable"

    # 3. With configured Prometheus HTTP URL that never receives serving metrics within timeout:
    #    surfaces clear actionable message referencing Prometheus URL and Orchestration administrator (redacted)
    monkeypatch.setattr(
        router,
        "resolve_prometheus_endpoint",
        AsyncMock(return_value=PrometheusEndpoint(base_url="http://10.20.30.40:30090", source="explicit_url")),
    )
    monkeypatch.setattr(router, "wait_for_deployment_metrics", AsyncMock(return_value=False))
    run_timeout = {
        "id": "run-timeout",
        "deployment_execution_id": "exec-na",
        "cluster_id": "c-na",
        "namespace": "ns-na",
        "wait_timeout_seconds": 5,
    }
    with pytest.raises(RuntimeError) as exc_info:
        await router._prepare_benchmark_monitoring(run_timeout)
    assert "http://10.20.30.40:30090" in str(exc_info.value)
    assert "Orchestration administrator" in str(exc_info.value)
    assert "secret-tok-xyz" not in str(exc_info.value)
    assert "kubeconfig_cache" not in str(exc_info.value)
    assert run_timeout["monitoring"]["status"] == "unavailable"


@pytest.mark.asyncio
async def test_deployment_monitoring_splits_namespace_monitors_and_cluster_rbac(monkeypatch):
    import httpx
    import yaml

    from llm_d_lens.monitoring.deployment import service as deploy_svc
    from llm_d_lens.monitoring.prometheus import PrometheusEndpoint
    from llm_d_lens.monitoring.service_links import MonitoringAccessResult

    exec_ctx = SimpleNamespace(execution_id="exec-split", cluster_id="c-split", namespace="ns-split")
    monkeypatch.setattr(deploy_svc, "get_execution_context", lambda _eid: exec_ctx)
    monkeypatch.setattr(
        deploy_svc,
        "probe_monitoring_access",
        AsyncMock(return_value=MonitoringAccessResult(reachable=True, access_mode="non_admin", can_manage=False)),
    )
    monkeypatch.setattr(
        deploy_svc,
        "resolve_prometheus_endpoint",
        AsyncMock(return_value=PrometheusEndpoint(base_url="http://10.0.0.9:30090", source="explicit_url")),
    )
    monkeypatch.setattr(deploy_svc, "check_prometheus_health", AsyncMock(return_value=True))

    bootstrap_present = False
    prom_epp_up = False

    async def fake_list_resources(resource, *, namespace=None, selector=None, cluster_id=None):
        del selector, cluster_id
        if resource == "services" and namespace == "ns-split":
            return [{"metadata": {"name": "vllm-epp", "labels": {"app.kubernetes.io/name": "vllm-epp"}}}]
        if resource == "pods" and namespace == "ns-split":
            return [{"spec": {"serviceAccountName": "vllm-epp-sa"}}]
        if resource == "configmaps" and namespace == "ns-split":
            items = [{"metadata": {"name": deploy_svc.MARKER_NAME}, "data": {"state": "enabled"}}]
            if bootstrap_present:
                items.append(
                    {
                        "metadata": {"name": "lens-deployment-bootstrap"},
                        "data": {
                            "clusterId": "c-split",
                            "namespace": "ns-split",
                            "status": "completed",
                            "eppAuthDelegator": "applied",
                        },
                    }
                )
            return items
        return []

    def fake_prom_client(endpoint, *, timeout=3.0):
        del timeout
        url = endpoint.base_url if isinstance(endpoint, PrometheusEndpoint) else str(endpoint)

        def handler(request: httpx.Request) -> httpx.Response:
            del request
            result = [{"metric": {"service": "vllm-epp"}, "value": [1, "1"]}] if prom_epp_up else []
            return httpx.Response(200, json={"status": "success", "data": {"result": result}})

        return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=url)

    monkeypatch.setattr(deploy_svc, "list_resources", fake_list_resources)
    monkeypatch.setattr(deploy_svc, "create_prometheus_client", fake_prom_client)

    recorded_cmds: list[tuple[list[str], list[str]]] = []
    preexisting_monitors: list[dict] = []
    get_monitors_forbidden = False
    ns_apply_forbidden = False
    ns_apply_stdout = (
        f"servicemonitor.monitoring.coreos.com/{deploy_svc.EPP_MONITOR_NAME} created\n"
        f"podmonitor.monitoring.coreos.com/{deploy_svc.MODELSERVER_MONITOR_NAME} created\n"
    )
    cluster_apply_stderr = "Error from server (Forbidden): clusterrolebindings.rbac.authorization.k8s.io is forbidden"

    class NamespaceOnlyNonAdminRunner:
        async def run(self, argv, *, input=None, timeout=30):  # noqa: A002
            del timeout
            kinds = [doc.get("kind") for doc in yaml.safe_load_all(input or "") if isinstance(doc, dict)]
            recorded_cmds.append((list(argv), kinds))
            if argv[:2] == ["kubectl", "apply"] and "-n" in argv:
                if ns_apply_forbidden:
                    return SimpleNamespace(
                        returncode=1,
                        stdout="",
                        stderr="Error from server (Forbidden): podmonitors.monitoring.coreos.com is forbidden",
                    )
                return SimpleNamespace(returncode=0, stdout=ns_apply_stdout, stderr="")
            if argv[:2] == ["kubectl", "apply"]:
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr=cluster_apply_stderr,
                )
            if argv[:3] == ["kubectl", "get", "configmap"]:
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if argv[:2] == ["kubectl", "get"] and any(
                arg.startswith(("servicemonitor/", "podmonitor/")) for arg in argv
            ):
                if get_monitors_forbidden:
                    return SimpleNamespace(
                        returncode=1,
                        stdout="",
                        stderr="Error from server (Forbidden): servicemonitors is forbidden",
                    )
                payload = json.dumps({"kind": "List", "items": preexisting_monitors}) if preexisting_monitors else ""
                return SimpleNamespace(returncode=0, stdout=payload, stderr="")
            if argv[:3] == ["kubectl", "get", "servicemonitors"] or argv[:3] == ["kubectl", "get", "podmonitors"]:
                return SimpleNamespace(
                    returncode=0,
                    stdout='{"items": [{"metadata": {"name": "mon"}}]}',
                    stderr="",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(deploy_svc, "scoped_runner", lambda _cid: NamespaceOnlyNonAdminRunner())

    # 1. Unbootstrapped non-admin UI Enable (for_benchmark=False, no bootstrap marker, EPP not scraped):
    #    splits namespace monitors from cluster RBAC, rolls back newly created monitors, and raises admin_handoff_required
    with pytest.raises(deploy_svc.DeploymentMonitoringError) as unbootstrapped_err:
        await deploy_svc.enable("exec-split")
    assert unbootstrapped_err.value.code == "admin_handoff_required"
    assert unbootstrapped_err.value.status_code == 403
    apply_cmds = [cmd for cmd in recorded_cmds if cmd[0][:2] == ["kubectl", "apply"]]
    assert apply_cmds[0] == (["kubectl", "apply", "-n", "ns-split", "-f", "-"], ["ServiceMonitor", "PodMonitor"])
    assert apply_cmds[1] == (
        ["kubectl", "apply", "-f", "-"],
        ["ClusterRoleBinding", "ClusterRole", "ClusterRoleBinding"],
    )
    delete_cmds = [cmd[0] for cmd in recorded_cmds if cmd[0][:2] == ["kubectl", "delete"]]
    assert delete_cmds == [
        [
            "kubectl",
            "delete",
            f"servicemonitor/{deploy_svc.EPP_MONITOR_NAME}",
            f"podmonitor/{deploy_svc.MODELSERVER_MONITOR_NAME}",
            "-n",
            "ns-split",
            "--ignore-not-found=true",
        ]
    ]
    assert not any("ConfigMap" in cmd[1] for cmd in recorded_cmds)

    # 1b. Pre-existing admin-installed monitors are NEVER deleted on 403 rollback (both via pre-check and stdout verbs)
    recorded_cmds.clear()
    preexisting_monitors = [{"kind": "ServiceMonitor", "metadata": {"name": deploy_svc.EPP_MONITOR_NAME}}]
    ns_apply_stdout = (
        f"servicemonitor.monitoring.coreos.com/{deploy_svc.EPP_MONITOR_NAME} configured\n"
        f"podmonitor.monitoring.coreos.com/{deploy_svc.MODELSERVER_MONITOR_NAME} created\n"
    )
    with pytest.raises(deploy_svc.DeploymentMonitoringError):
        await deploy_svc.enable("exec-split")
    delete_cmds = [cmd[0] for cmd in recorded_cmds if cmd[0][:2] == ["kubectl", "delete"]]
    assert delete_cmds == [
        [
            "kubectl",
            "delete",
            f"podmonitor/{deploy_svc.MODELSERVER_MONITOR_NAME}",
            "-n",
            "ns-split",
            "--ignore-not-found=true",
        ]
    ]

    # Even when `kubectl get` is RBAC-restricted (403), `configured` in apply stdout preserves pre-existing monitor
    recorded_cmds.clear()
    preexisting_monitors = []
    get_monitors_forbidden = True
    with pytest.raises(deploy_svc.DeploymentMonitoringError):
        await deploy_svc.enable("exec-split")
    delete_cmds = [cmd[0] for cmd in recorded_cmds if cmd[0][:2] == ["kubectl", "delete"]]
    assert delete_cmds == [
        [
            "kubectl",
            "delete",
            f"podmonitor/{deploy_svc.MODELSERVER_MONITOR_NAME}",
            "-n",
            "ns-split",
            "--ignore-not-found=true",
        ]
    ]
    get_monitors_forbidden = False

    # 1c. Namespace monitor 403 with for_benchmark=True raises admin_handoff_required so router handles fallback;
    #     non-403 cluster RBAC error (e.g. 401 Unauthorized) raises apply_failed instead of being swallowed
    ns_apply_forbidden = True
    with pytest.raises(deploy_svc.DeploymentMonitoringError) as ns_403_err:
        await deploy_svc.enable("exec-split", for_benchmark=True)
    assert ns_403_err.value.code == "admin_handoff_required"
    assert ns_403_err.value.status_code == 403
    ns_apply_forbidden = False

    cluster_apply_stderr = "Error from server (Unauthorized): credentials expired"
    with pytest.raises(deploy_svc.DeploymentMonitoringError) as non_403_err:
        await deploy_svc.enable("exec-split", for_benchmark=True)
    assert non_403_err.value.code == "apply_failed"
    assert non_403_err.value.status_code == 500
    cluster_apply_stderr = "Error from server (Forbidden): clusterrolebindings.rbac.authorization.k8s.io is forbidden"

    # 2. Bootstrapped non-admin UI Enable (ConfigMap/lens-deployment-bootstrap eppAuthDelegator=applied): succeeds!
    recorded_cmds.clear()
    bootstrap_present = True
    res_bootstrapped = await deploy_svc.enable("exec-split")
    assert res_bootstrapped["enabled"] is True
    assert res_bootstrapped["status"] == "enabled"
    assert any("ConfigMap" in cmd[1] for cmd in recorded_cmds)

    # 3. Unbootstrapped non-admin with for_benchmark=True (ns monitors applied, cluster RBAC 403): succeeds!
    recorded_cmds.clear()
    bootstrap_present = False
    res_bench = await deploy_svc.enable("exec-split", for_benchmark=True)
    assert res_bench["enabled"] is True

    # 4. Unbootstrapped non-admin UI Enable when Prometheus is already scraping EPP: succeeds!
    recorded_cmds.clear()
    prom_epp_up = True
    res_scraped = await deploy_svc.enable("exec-split")
    assert res_scraped["enabled"] is True


@pytest.mark.asyncio
async def test_resource_snapshot_falls_back_to_prometheus_http_on_non_admin_403(monkeypatch):
    import httpx

    from llm_d_lens.monitoring.prometheus import PrometheusEndpoint

    monkeypatch.setattr(router, "deployment_runtime_overrides", lambda _sid: {"KUBECONFIG": "/tmp/non-admin"})
    monkeypatch.setattr(
        router.sessions,
        "get_session",
        lambda _sid: SimpleNamespace(server_id="c-non-admin"),
    )
    # Simulate non-admin 403 on cluster-scoped `get nodes`, `get pods`, and `--raw` scrape_path
    monkeypatch.setattr(router, "_kubectl_json", AsyncMock(return_value=None))
    monkeypatch.setattr(router, "_kubectl_raw", AsyncMock(return_value=None))
    monkeypatch.setattr(
        router,
        "resolve_prometheus_endpoint",
        AsyncMock(return_value=PrometheusEndpoint(base_url="http://10.0.0.15:30090", source="explicit_url")),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        query = request.url.params.get("query", "")
        if "kube_pod_info" in query:
            rows = [{"metric": {"pod": "decode-0", "node": "worker-1"}, "value": [1, "1"]}]
        elif "kube_pod_status_phase" in query:
            rows = [{"metric": {"pod": "decode-0", "phase": "Running"}, "value": [1, "1"]}]
        elif "kube_pod_container_resource_requests" in query:
            rows = [
                {
                    "metric": {"pod": "decode-0", "container": "modelserver", "resource": "gpu_intel_com_xe"},
                    "value": [1, "2"],
                }
            ]
        elif "kube_node_status_allocatable" in query:
            rows = [
                {"metric": {"node": "worker-1", "resource": "cpu"}, "value": [1, "64"]},
                {"metric": {"node": "worker-1", "resource": "gpu_intel_com_xe"}, "value": [1, "8"]},
            ]
        elif query == 'hw_gpu_utilization_ratio{hw_gpu_task="compute-all"}':
            rows = [
                {
                    "metric": {"node": "worker-1", "pci_bdf": "0000:01:00.0", "hw_gpu_task": "compute-all"},
                    "value": [1, "0.75"],
                }
            ]
        elif query == 'hw_memory_usage_bytes{hw_memory_location="device"}':
            rows = [
                {
                    "metric": {"node": "worker-1", "pci_bdf": "0000:01:00.0", "hw_memory_location": "device"},
                    "value": [1, "8589934592"],
                }
            ]
        else:
            rows = []
        return httpx.Response(200, json={"status": "success", "data": {"result": rows}})

    monkeypatch.setattr(
        router,
        "create_prometheus_client",
        lambda endpoint, *, timeout=5.0: httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            base_url=endpoint.base_url,
            timeout=timeout,
        ),
    )

    snapshot = await router._kubernetes_resource_snapshot("sess-1", "ns-bench", "intel-xpu")
    assert snapshot is not None
    assert snapshot["source"] == "prometheus"
    assert snapshot["requested_gpus"] == 2
    assert snapshot["allocatable_gpus"] == 8
    assert snapshot["pods"][0]["name"] == "decode-0"
    assert snapshot["pods"][0]["phase"] == "Running"
    assert snapshot["nodes"][0]["name"] == "worker-1"
    assert snapshot["utilization_available"] is True
    assert snapshot["gpu_telemetry"]["hardware_profile"] == "intel-xpu"
    assert snapshot["gpu_telemetry"]["average_utilization_ratio"] == pytest.approx(0.75)
    assert snapshot["gpu_telemetry"]["devices"][0]["memory_used_bytes"] == 8589934592

    # Also works when session_id is None/expired and cluster_id is passed explicitly by callers
    monkeypatch.setattr(router.sessions, "get_session", lambda _sid: None)
    monkeypatch.setattr(
        router,
        "deployment_runtime_overrides",
        lambda _sid: (_ for _ in ()).throw(ValueError("session expired")),
    )
    expired_session_snapshot = await router._kubernetes_resource_snapshot(
        "expired-sess",
        "ns-bench",
        "intel-xpu",
        cluster_id="c-non-admin",
    )
    assert expired_session_snapshot is not None
    assert expired_session_snapshot["source"] == "prometheus"
    assert expired_session_snapshot["requested_gpus"] == 2
