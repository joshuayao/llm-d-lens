"""Tests for Evaluate deployment benchmark support."""

import importlib
from types import SimpleNamespace

import pytest

from llm_d_lens.deploy.contracts import DeployableConfiguration
from llm_d_lens.evaluation.models import EvaluationCreateRequest
from llm_d_lens.infrastructure.artifacts.manifests import configuration_checksum

router = importlib.import_module("llm_d_lens.evaluation.router")


@pytest.mark.parametrize("guide", [None, "baseline-vllm", "source-composition", "pd-disaggregation"])
def test_endpoint_benchmark_specification_defaults(guide):
    expected = "guides/pd-disaggregation" if guide == "pd-disaggregation" else "guides/optimized-baseline"
    assert router._guide_benchmark_specification(guide) == expected


def test_source_benchmark_specification_preserves_environment_override(monkeypatch):
    monkeypatch.setattr(router, "_embedded_configuration", lambda _: SimpleNamespace(provider_ref="source-composition"))
    monkeypatch.delenv("LLM_D_BENCH_SPECIFICATION_FILE", raising=False)
    assert router._benchmark_specification({"kind": "candidate"}) == "guides/optimized-baseline"
    monkeypatch.setenv("LLM_D_BENCH_SPECIFICATION_FILE", "custom/spec")
    assert router._benchmark_specification({"kind": "candidate"}) == "custom/spec"


def test_xpumd_metrics_use_compute_engine_utilization():
    from llm_d_lens.hardware.registry import get_profile

    metrics = router._parse_xpumd_metrics(
        "\n".join(
            [
                'hw_gpu_utilization_ratio{pci_bdf="0000:01:00.0",hw_gpu_task="all"} 0.125',
                'hw_gpu_utilization_ratio{pci_bdf="0000:01:00.0",hw_gpu_task="compute-all"} 1',
                'hw_gpu_utilization_ratio{pci_bdf="0000:01:00.0",hw_gpu_task="copy-all"} 0',
            ]
        ),
        get_profile("intel-xpu"),
    )

    assert metrics["average_utilization_ratio"] == 1
    assert metrics["maximum_utilization_ratio"] == 1
    assert metrics["devices"][0]["utilization_ratio"] == 1


@pytest.mark.parametrize(
    ("baseline_type", "provider_ref", "router_profile"),
    [
        ("direct-vllm", "baseline-vllm", None),
        ("router-neutral", "optimized-baseline", "router-neutral"),
        ("optimized-baseline", "optimized-baseline", "optimized-baseline"),
    ],
)
def test_explicit_baseline_types_select_expected_provider(baseline_type, provider_ref, router_profile):
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 2, "tensorParallelSize": 1},
        "runtime": {"image": "example/vllm:test", "imageMode": "use-upstream-image"},
    }
    source = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
    )

    baseline = router.baseline_configuration(source, baseline_type, ["workload"], "artifact")

    assert baseline.provider_ref == provider_ref
    assert baseline.content.get("routerProfile") == router_profile
    assert baseline.content["decode"] == content["decode"]
    assert baseline.checksum == configuration_checksum(baseline.content)


def test_comparison_core_parameters_override_generated_baseline():
    content = {
        "model": {"name": "Qwen/Qwen3-8B"},
        "decode": {"replicaCount": 1, "tensorParallelSize": 1, "maxModelLen": 20480},
        "runtime": {"image": "example/vllm:test", "imageMode": "use-upstream-image"},
        "customParameters": [{"target": "decode", "kind": "argument", "name": "block-size", "value": "16"}],
    }
    source = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
    )

    baseline = router.baseline_configuration(
        source,
        "direct-vllm",
        ["workload"],
        "artifact",
        {
            "replicas": 2,
            "tensor_parallel_size": 1,
            "max_model_len": 16384,
            "max_num_seqs": 64,
            "gpu_memory_utilization": 0.85,
            "block_size": 64,
            "max_num_batched_tokens": 2048,
        },
    )

    assert baseline.content["decode"] == {
        "replicaCount": 2,
        "tensorParallelSize": 1,
        "maxModelLen": 16384,
        "maxNumSeqs": 64,
    }
    arguments = {item["name"]: item["value"] for item in baseline.content["customParameters"]}
    assert arguments == {
        "gpu-memory-utilization": "0.85",
        "block-size": "64",
        "max-num-batched-tokens": "2048",
    }
    assert baseline.checksum == configuration_checksum(baseline.content)


def test_evaluation_case_links_candidate_to_multiple_baselines():
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 1, "tensorParallelSize": 1},
        "runtime": {"image": "example/vllm:test", "imageMode": "use-upstream-image"},
    }
    configuration = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
    )
    artifact_id = "00000000-0000-4000-8000-000000000001"
    request = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000002",
        benchmark_plans=[
            {
                "id": "candidate",
                "configuration_artifact_id": artifact_id,
                "baseline_types": ["direct-vllm", "router-neutral", "optimized-baseline"],
            }
        ],
    )

    cases = router._evaluation_cases(request, {artifact_id: SimpleNamespace(deployable_configuration=configuration)})

    assert cases[0]["kind"] == "guide"
    assert cases[0]["baseline_case_ids"] == ["baseline-1", "baseline-2", "baseline-3"]
    assert [case["baseline_type"] for case in cases[1:]] == ["direct-vllm", "router-neutral", "optimized-baseline"]


@pytest.mark.parametrize(
    "provider_ref",
    ["optimized-baseline", "pd-disaggregation", "tiered-prefix-cache", "precise-prefix-cache-routing"],
)
def test_suite_scenarios_expand_for_every_supported_guide(provider_ref):
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 1, "tensorParallelSize": 1},
        "runtime": {"image": "example/vllm:test"},
    }
    if provider_ref == "pd-disaggregation":
        content["prefill"] = {"replicaCount": 1, "tensorParallelSize": 1}
    configuration = DeployableConfiguration(
        type="baseline",
        provider_ref=provider_ref,
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
    )
    artifact_id = "00000000-0000-4000-8000-000000000001"
    request = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000002",
        benchmark_plans=[
            {
                "id": "candidate",
                "configuration_artifact_id": artifact_id,
                "include_baseline": False,
                "scenarios": [
                    {"id": "smoke", "name": "Smoke", "benchmark": {"matrix": [{"isl": 128, "osl": 64}]}},
                    {"id": "chat", "name": "Chat", "benchmark": {"matrix": [{"isl": 256, "osl": 128}]}},
                ],
            }
        ],
    )

    cases = router._evaluation_cases(request, {artifact_id: SimpleNamespace(deployable_configuration=configuration)})

    assert [case["id"] for case in cases] == ["guide-1-1", "guide-1-2"]
    assert [case["scenario_id"] for case in cases] == ["smoke", "chat"]
    assert all(case["deployment_configuration"]["provider_ref"] == provider_ref for case in cases)


def test_suite_sla_evaluation_uses_requested_percentiles():
    result = router._sla_evaluation(
        {
            "throughput_tps": 1200,
            "success_rate": 99.5,
            "latency_distributions": {
                "ttft": {"p99_ms": 450},
                "tpot": {"p90_ms": 55},
            },
        },
        {
            "ttft_ms": 500,
            "ttft_percentile": "p99",
            "tpot_ms": 50,
            "tpot_percentile": "p90",
            "throughput_min_tps": 1000,
            "success_rate_min_percent": 99,
        },
    )

    assert result["met"] is False
    assert result["checks"]["ttft"]["met"] is True
    assert result["checks"]["tpot"]["met"] is False


def test_suite_scenarios_share_deployment_until_the_last_scenario():
    workflow = {
        "cases": [
            {"id": "guide-1-1", "kind": "guide", "status": "benchmarking", "deployment_group_id": "candidate:guide"},
            {
                "id": "guide-1-2",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "candidate:guide",
                "deployment_run_id": None,
            },
            {
                "id": "guide-2-1",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "other:guide",
                "deployment_run_id": None,
            },
        ]
    }

    first, second, other = workflow["cases"]
    router._share_suite_deployment(workflow, first, "deployment-1")

    assert second["deployment_run_id"] == "deployment-1"
    assert other["deployment_run_id"] is None
    assert router._has_pending_suite_scenario(workflow, first)
    second["status"] = "succeeded"
    assert not router._has_pending_suite_scenario(workflow, first)


def test_evaluation_capacity_rejects_model_that_cannot_fit_xpu(monkeypatch):
    monkeypatch.setenv("PRISM_ACCELERATOR_MEMORY_GIB", "24")
    content = {
        "model": {"name": "Qwen/Qwen3-32B"},
        "decode": {"replicaCount": 1, "tensorParallelSize": 1},
        "runtime": {"image": "ghcr.io/llm-d/llm-d-xpu:v0.8.0"},
    }
    configuration = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="helm",
        content=content,
        checksum=configuration_checksum(content),
    )

    with pytest.raises(ValueError, match="use TP>=4"):
        router._validate_evaluation_capacity(configuration)

    configuration.content["decode"]["tensorParallelSize"] = 4
    router._validate_evaluation_capacity(configuration)


def test_evaluation_capacity_rejects_more_cards_than_allowlisted(monkeypatch):
    monkeypatch.setenv("PRISM_ACCELERATOR_MEMORY_GIB", "24")
    monkeypatch.setenv("PRISM_GPU_PCI_ALLOWLIST", "gpu-1,gpu-2,gpu-3,gpu-4")
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 2, "tensorParallelSize": 4},
        "runtime": {"image": "ghcr.io/llm-d/llm-d-xpu:v0.8.0"},
    }
    configuration = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="helm",
        content=content,
        checksum=configuration_checksum(content),
    )

    with pytest.raises(ValueError, match="configuration requires 8 XPU cards, but only 4 are available to Prism"):
        router._validate_evaluation_capacity(configuration)


@pytest.mark.parametrize("preserve_deployment", [False, True])
def test_failed_benchmark_always_cleans_owned_deployment(preserve_deployment):
    assert router._should_cleanup_deployment(
        owns_deployment=True,
        benchmark_succeeded=False,
        case={"preserve_deployment": preserve_deployment},
    )


def test_successful_benchmark_keeps_deployment_only_when_requested():
    assert router._should_cleanup_deployment(
        owns_deployment=True, benchmark_succeeded=True, case={"preserve_deployment": False}
    )
    assert not router._should_cleanup_deployment(
        owns_deployment=True, benchmark_succeeded=True, case={"preserve_deployment": True}
    )


def test_evaluation_does_not_clean_external_deployment():
    assert not router._should_cleanup_deployment(
        owns_deployment=False, benchmark_succeeded=False, case={"preserve_deployment": False}
    )


@pytest.mark.asyncio
async def test_delete_terminal_endpoint_benchmark_removes_record_and_results(monkeypatch, tmp_path):
    run_id = "00000000-0000-4000-8000-000000000001"
    run = {"kind": "benchmark", "id": run_id, "status": "failed"}
    results = tmp_path / "results"
    output = results / run_id
    output.mkdir(parents=True)
    (output / "report.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(router, "_results_root", results)
    router._save(run)

    await router.delete_benchmark_run(run_id)

    assert router._get("benchmark", run_id) is None
    assert not output.exists()


@pytest.mark.asyncio
async def test_delete_active_endpoint_benchmark_is_rejected(monkeypatch):
    run_id = "00000000-0000-4000-8000-000000000002"
    monkeypatch.setattr(router, "_get", lambda _kind, _record_id: {"id": run_id, "status": "running"})

    with pytest.raises(router.HTTPException, match="must be cancelled") as raised:
        await router.delete_benchmark_run(run_id)

    assert raised.value.status_code == 409


@pytest.mark.asyncio
async def test_delete_workflow_deletes_owned_deployments_and_records(monkeypatch, tmp_path):
    workflow_id = "00000000-0000-4000-8000-000000000021"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "succeeded",
        "deployment_run_id": "legacy-deployment",
        "cases": [
            {
                "id": "00000000-0000-4000-8000-000000000031",
                "status": "succeeded",
                "deployment_run_id": "deployment-1",
                "evaluation_run_id": "00000000-0000-4000-8000-000000000011",
            },
            {
                "id": "00000000-0000-4000-8000-000000000032",
                "status": "succeeded",
                "deployment_run_id": "deployment-1",
                "evaluation_run_id": "00000000-0000-4000-8000-000000000012",
            },
        ],
    }
    deleted_deployments = []
    monkeypatch.setattr(router, "_results_root", tmp_path / "results")
    monkeypatch.setattr(router, "_records", lambda kind: [])

    class Worker:
        def __init__(self, run_id):
            self.run_id = run_id

        async def delete_run(self, run_id):
            assert run_id == self.run_id
            deleted_deployments.append(run_id)

    monkeypatch.setattr(router, "_store", SimpleNamespace(get_run=lambda _run_id: object()))
    monkeypatch.setattr(
        router,
        "deployment_run_manager",
        SimpleNamespace(worker_for_run=lambda run_id: Worker(run_id)),
    )
    router._save(workflow)
    router._save({"kind": "benchmark", "id": "00000000-0000-4000-8000-000000000011", "status": "failed"})
    router._save({"kind": "benchmark", "id": "00000000-0000-4000-8000-000000000012", "status": "failed"})

    await router.delete_workflow_run(workflow_id)

    assert set(deleted_deployments) == {"legacy-deployment", "deployment-1"}
    assert router._get("workflow", workflow_id) is None
    assert router._get("benchmark", "00000000-0000-4000-8000-000000000011") is None
    assert router._get("benchmark", "00000000-0000-4000-8000-000000000012") is None


@pytest.mark.asyncio
async def test_delete_workflow_keeps_records_when_deployment_cleanup_fails(monkeypatch, tmp_path):
    workflow_id = "00000000-0000-4000-8000-000000000022"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "failed",
        "cases": [
            {
                "id": "00000000-0000-4000-8000-000000000033",
                "status": "failed",
                "deployment_run_id": "deployment-1",
                "evaluation_run_id": "00000000-0000-4000-8000-000000000011",
            }
        ],
    }

    class Worker:
        async def delete_run(self, _run_id):
            raise ValueError("reconnect the deployment cluster")

    router._save(workflow)
    monkeypatch.setattr(router, "_store", SimpleNamespace(get_run=lambda _run_id: object()))
    monkeypatch.setattr(router, "deployment_run_manager", SimpleNamespace(worker_for_run=lambda _run_id: Worker()))

    with pytest.raises(router.HTTPException, match="reconnect the deployment cluster") as raised:
        await router.delete_workflow_run(workflow_id)

    assert raised.value.status_code == 409
    saved = router._get("workflow", workflow_id)
    assert saved is not None
    assert saved["id"] == workflow["id"]
    assert saved["status"] == workflow["status"]
    assert [case["id"] for case in saved["cases"]] == [case["id"] for case in workflow["cases"]]
    assert [case["status"] for case in saved["cases"]] == [case["status"] for case in workflow["cases"]]
    assert [case["deployment_run_id"] for case in saved["cases"]] == [
        case["deployment_run_id"] for case in workflow["cases"]
    ]


@pytest.mark.asyncio
async def test_benchmark_runtime_requires_cluster_source(monkeypatch, tmp_path):
    executable = tmp_path / ".venv" / "bin" / "llmdbenchmark"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\n")
    monkeypatch.setenv("LLM_D_BENCHMARK_EXECUTABLE", str(executable))
    monkeypatch.setenv("LLM_D_BENCHMARK_ROOT", str(tmp_path))
    with pytest.raises(ValueError, match="Software Versions"):
        await router._prepare_benchmark_runtime()


@pytest.mark.asyncio
async def test_benchmark_runtime_uses_cluster_checkout(tmp_path):
    executable = tmp_path / ".venv" / "bin" / "llmdbenchmark"
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\n")
    template = tmp_path / "config/templates/jinja/20_harness_pod.yaml.j2"
    template.parent.mkdir(parents=True)
    template.write_text("{{ harness_command }}\n", encoding="utf-8")
    assert await router._prepare_benchmark_runtime({"resolved_repository": str(tmp_path)}) == (
        str(executable),
        tmp_path,
    )


@pytest.mark.asyncio
async def test_workflow_persists_deployment_failure_stage_before_clearing_active_case(monkeypatch):
    import copy

    workflow = {
        "kind": "workflow",
        "id": "stage-test",
        "status": "queued",
        "failed_stage": "benchmarking",
        "cases": [
            {"id": "case-1", "kind": "guide", "status": "queued", "failed_stage": "benchmarking"},
        ],
    }
    saved = []
    monkeypatch.setattr(router, "_get", lambda *_: workflow)
    monkeypatch.setattr(router, "_save", lambda value: saved.append(copy.deepcopy(value)))
    monkeypatch.setattr(router, "_ordered_evaluation_cases", lambda cases: cases)

    def invalid_configuration(*_):
        raise ValueError("deployment configuration rejected")

    monkeypatch.setattr(router, "_case_configuration", invalid_configuration)
    await router._execute_evaluation(workflow["id"])

    final = saved[-1]
    assert final["status"] == "failed"
    assert final["active_case_id"] is None
    assert final["failed_stage"] == "deploying"
    assert final["cases"][0]["failed_stage"] == "deploying"
    assert final["cases"][0]["error"] == "deployment configuration rejected"
    assert "failed_stage" not in saved[0]
    assert "failed_stage" not in saved[0]["cases"][0]


@pytest.mark.asyncio
@pytest.mark.parametrize("case_count", [1, 2])
@pytest.mark.parametrize("cleanup_error", [None, RuntimeError("cleanup unavailable")])
@pytest.mark.parametrize("shared_pods", [False, True])
async def test_workflow_completes_before_final_deployment_cleanup(monkeypatch, case_count, cleanup_error, shared_pods):
    import asyncio
    import copy

    workflow = {
        "kind": "workflow",
        "id": "completion-test",
        "status": "queued",
        "cases": [
            {"id": f"case-{index}", "kind": "guide", "status": "queued", "deployment_run_id": f"deployment-{index}"}
            for index in range(case_count)
        ],
    }
    saved = []
    if shared_pods:
        workflow["cases"].append(
            {
                "id": "shared-baseline",
                "kind": "baseline",
                "status": "queued",
                "baseline_type": "kubernetes-service",
                "dependent_guide_case_id": f"case-{case_count - 1}",
            }
        )
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    cleaned = []
    ready_case = SimpleNamespace(
        id="ready-case",
        status=SimpleNamespace(value="ready"),
        execution_id="execution",
        attempt=1,
        provider_ref="optimized-baseline",
    )
    execution = SimpleNamespace(
        status=router.DeploymentStatus.READY,
        namespace="test",
        endpoint=SimpleNamespace(url="http://routed", baseline_url="http://direct"),
    )
    monkeypatch.setattr(router, "_get", lambda *_: workflow)
    monkeypatch.setattr(router, "_save", lambda value: saved.append(copy.deepcopy(value)))
    monkeypatch.setattr(router, "_ordered_evaluation_cases", lambda cases: cases)
    monkeypatch.setattr(router, "_benchmark_specification", lambda *_: None)
    monkeypatch.setattr(router, "case_benchmark_request", lambda *_, **__: None)
    monkeypatch.setattr(router, "_comparison_report", lambda *_: {"ready": True})
    monkeypatch.setattr(router, "_has_pending_suite_scenario", lambda *_: False)
    monkeypatch.setattr(
        router,
        "_store",
        SimpleNamespace(
            get_run=lambda run_id: SimpleNamespace(id=run_id, cases=[ready_case]),
            get_execution=lambda *_: execution,
        ),
    )

    async def benchmark(_workflow, case, *_args, **_kwargs):
        case.update(status="succeeded", finished_at=router._now())

    class Worker:
        async def delete_case_execution(self, run_id, _case_id):
            cleaned.append(run_id)
            if len(cleaned) < case_count:
                assert saved[-1]["status"] == "running"
                return
            cleanup_started.set()
            await release_cleanup.wait()
            if cleanup_error:
                raise cleanup_error

    monkeypatch.setattr(router, "execute_case_benchmark", benchmark)
    monkeypatch.setattr(router, "deployment_run_manager", SimpleNamespace(worker_for_run=lambda *_: Worker()))
    task = asyncio.create_task(router._execute_evaluation(workflow["id"]))
    try:
        await asyncio.wait_for(cleanup_started.wait(), timeout=2)
        assert not task.done()
        completed = saved[-1]
        assert completed["status"] == "succeeded"
        assert completed["active_case_id"] is None
        assert completed["report"] == {"ready": True}
        assert completed["finished_at"]
    finally:
        release_cleanup.set()
        await asyncio.wait_for(task, timeout=2)
    assert saved[-1]["status"] == "succeeded"
    assert saved[-1]["finished_at"] == completed["finished_at"]
    assert saved[-1]["cases"][case_count - 1].get("cleanup_error") == (str(cleanup_error) if cleanup_error else None)


@pytest.mark.asyncio
async def test_delete_completed_workflow_waits_for_background_cleanup(monkeypatch):
    import asyncio

    workflow_id = "00000000-0000-4000-8000-000000000023"
    workflow = {"kind": "workflow", "id": workflow_id, "status": "succeeded", "cases": []}
    release_cleanup = asyncio.Event()
    delete_checked = asyncio.Event()

    async def cleanup():
        await release_cleanup.wait()
        router._save(workflow)

    original_get = router._get

    def get_record(kind, record_id):
        record = original_get(kind, record_id)
        delete_checked.set()
        return record

    router._save(workflow)
    monkeypatch.setattr(router, "_get", get_record)
    cleanup_task = asyncio.create_task(cleanup())
    monkeypatch.setitem(router._workflow_tasks, workflow_id, cleanup_task)
    deletion = asyncio.create_task(router.delete_workflow_run(workflow_id))
    try:
        await asyncio.wait_for(delete_checked.wait(), timeout=2)
        assert not deletion.done()
        assert original_get("workflow", workflow_id) is not None
    finally:
        release_cleanup.set()
        await asyncio.wait_for(asyncio.gather(cleanup_task, deletion), timeout=2)
    assert original_get("workflow", workflow_id) is None


def test_each_configuration_can_select_only_ablations_and_keeps_its_own_comparisons():
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 2, "tensorParallelSize": 1},
        "runtime": {"image": "vllm:xpu"},
    }
    config = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="helm",
        content=content,
        checksum=configuration_checksum(content),
    )
    a = "00000000-0000-4000-8000-000000000001"
    b = "00000000-0000-4000-8000-000000000002"
    request = EvaluationCreateRequest(
        cluster_session_id=a,
        benchmark_plans=[
            {
                "id": "a",
                "configuration_artifact_id": a,
                "include_configuration": False,
                "baseline_types": ["load-only", "affinity-only"],
            },
            {"id": "b", "configuration_artifact_id": b, "include_configuration": True, "baseline_types": ["load-only"]},
        ],
    )
    cases = router._evaluation_cases(
        request,
        {a: SimpleNamespace(deployable_configuration=config), b: SimpleNamespace(deployable_configuration=config)},
    )
    assert len(cases) == 4
    assert [(c["kind"], c["benchmark_plan_id"]) for c in cases] == [
        ("guide", "b"),
        ("baseline", "a"),
        ("baseline", "a"),
        ("baseline", "b"),
    ]
    assert cases[0]["baseline_case_ids"] == [cases[-1]["id"]]


def test_router_ablations_preserve_published_source_and_cluster_for_retry():
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "decode": {"replicaCount": 2, "tensorParallelSize": 1},
        "runtime": {"image": "vllm:xpu"},
        "officialGuide": {"renderedManifest": "saved-manifest", "deploymentBundle": {"saved": True}},
        "guideSettings": {"routerValues": "saved-router"},
    }
    source = DeployableConfiguration(
        type="baseline",
        provider_ref="optimized-baseline",
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
        provenance={"cluster_ref": {"id": "original-cluster"}},
    )
    for kind in ["router-neutral", "affinity-only", "load-only"]:
        baseline = router.baseline_configuration(source, kind, ["plan-a"], "artifact-a")
        assert baseline.content["officialGuide"] == content["officialGuide"]
        assert baseline.content["guideSettings"] == content["guideSettings"]
        assert baseline.provenance["cluster_ref"]["id"] == "original-cluster"
        assert baseline.content["routerProfile"] == kind
        assert "routerProfile" not in source.content
    direct = router.baseline_configuration(source, "direct-vllm", ["plan-a"], "artifact-a")
    assert direct.provenance["cluster_ref"]["id"] == "original-cluster"
    assert "officialGuide" not in direct.content


@pytest.mark.asyncio
async def test_execute_owned_e20cf405_fallback_standup_cm_cleanup_and_gaie_presets(monkeypatch, tmp_path):
    import base64
    import json
    from unittest.mock import AsyncMock

    import yaml

    kc = tmp_path / "kubeconfig"
    kc.write_text("apiVersion: v1\nkind: Config\n", encoding="utf-8")
    ns = "ns-e20cf405"
    router._standup_configmap_refs.clear()

    seen_session_ids = []
    applied = []
    deleted = []

    def fake_overrides(session_id):
        seen_session_ids.append(session_id)
        return {"KUBECONFIG": str(kc)}

    envoy_tls_yaml = (
        "static_resources:\n  clusters:\n"
        "  - name: ext_proc\n    transport_socket:\n      name: envoy.transport_sockets.tls\n"
    )
    epp_cfg_yaml = "apiVersion: inference.networking.x-k8s.io/v1alpha1\nkind: EndpointPickerConfig\nplugins:\n- type: queue-scorer\n"
    epp_dep = {
        "metadata": {"name": "optimized-baseline-epp"},
        "spec": {
            "replicas": 1,
            "template": {
                "metadata": {"labels": {"app": "optimized-baseline-epp"}},
                "spec": {
                    "containers": [
                        {
                            "name": "epp",
                            "args": [
                                "--pool-name=optimized-baseline",
                                "--secure-serving=false",
                                "--config-file=/config/epp.yaml",
                            ],
                            "ports": [{"containerPort": 9002}],
                            "volumeMounts": [{"name": "epp-cfg", "mountPath": "/config"}],
                        },
                        {
                            "name": "envoy-proxy",
                            "image": "envoyproxy/envoy:v1.31",
                            "ports": [{"containerPort": 8081}],
                            "volumeMounts": [{"name": "envoy-cfg", "mountPath": "/etc/envoy"}],
                        },
                    ],
                    "volumes": [
                        {"name": "envoy-cfg", "configMap": {"name": "envoy"}},
                        {"name": "epp-cfg", "configMap": {"name": "epp-presets"}},
                    ],
                },
            },
        },
        "status": {"availableReplicas": 1},
    }
    ms_dep = {
        "metadata": {"name": "optimized-baseline-epp-model-servers"},
        "spec": {
            "replicas": 1,
            "template": {
                "metadata": {"labels": {"llm-d.ai/role": "decode"}},
                "spec": {
                    "containers": [{"name": "modelserver", "command": ["vllm", "serve"], "args": ["Qwen/Qwen3-0.6B"]}]
                },
            },
        },
        "status": {"availableReplicas": 1},
    }
    services = [
        {
            "metadata": {"name": "optimized-baseline-epp"},
            "spec": {"selector": {"app": "optimized-baseline-epp"}, "ports": [{"port": 80, "targetPort": 8081}]},
        },
        {
            "metadata": {"name": "optimized-baseline-epp-model-servers"},
            "spec": {"selector": {"llm-d.ai/role": "decode"}, "ports": [{"port": 8000}]},
        },
    ]

    async def fake_k8s_json(args, _env):
        if args[:2] == ["get", "services"]:
            return {"items": services}
        if args[:2] == ["get", "deployments"]:
            return {"items": [epp_dep, ms_dep]}
        if args[:2] == ["get", "pods"]:
            return {"items": [{"spec": {"nodeName": "smc-22", "containers": [{"name": "modelserver"}]}}]}
        if args[:3] == ["get", "configmap", "envoy"]:
            return {"data": {"envoy.yaml": envoy_tls_yaml}}
        if args[:3] == ["get", "configmap", "epp-presets"]:
            return {"data": {"epp.yaml": epp_cfg_yaml}}
        if args[:3] == ["get", "configmap", router._STANDUP_CM_NAME]:
            return applied[-1] if applied else None
        return None

    async def fake_k8s_apply(manifest, _env):
        applied.append(manifest)
        return True

    async def fake_k8s_delete(resource, name, target_ns, _env):
        deleted.append((resource, name, target_ns))
        return True

    bench_root = tmp_path / "bench"
    (bench_root / "llmdbenchmark/run/steps").mkdir(parents=True)
    (bench_root / "llmdbenchmark/interface").mkdir(parents=True)
    (bench_root / "config/templates/jinja").mkdir(parents=True)
    (bench_root / "llmdbenchmark/cli.py").write_text("--non-admin --no-pvc --no-prism\n", encoding="utf-8")
    (bench_root / "llmdbenchmark/interface/run.py").write_text("--step\n", encoding="utf-8")
    (bench_root / "llmdbenchmark/run/steps/step_02b_deploy_prism.py").write_text("", encoding="utf-8")
    (bench_root / "config/templates/jinja/20_harness_pod.yaml.j2").write_text("no_pvc\n", encoding="utf-8")

    run = {
        "id": "run-e20cf405",
        "deployment_execution_id": "exec-1",
        "specification_file": "guides/optimized-baseline",
        "harness": "inference-perf",
        "workload": "sanity_random.yaml",
        "parallelism": 1,
        "wait_timeout_seconds": 60,
        "cluster_session_id": "run-level-should-not-override",
    }
    execution = SimpleNamespace(
        status=router.DeploymentStatus.READY,
        endpoint=SimpleNamespace(url=f"http://optimized-baseline-epp.{ns}.svc.cluster.local:80", baseline_url=None),
        namespace=ns,
        provenance={"cluster_session_id": "prov-session"},
        configuration_artifacts=[],
        artifact=None,
    )

    monkeypatch.setattr(router, "_get", lambda _kind, _id: run)
    monkeypatch.setattr(router, "_save", lambda _rec: None)
    monkeypatch.setattr(router, "_results_root", tmp_path / "results")
    monkeypatch.setattr(router, "_store", SimpleNamespace(get_execution=lambda _id: execution))
    monkeypatch.setattr(router, "_execution_model", lambda _exec: "Qwen/Qwen3-0.6B")
    monkeypatch.setattr(router, "_execution_accelerator_profile", lambda _exec, _p: None)
    monkeypatch.setattr(router, "deployment_runtime_overrides", fake_overrides)
    monkeypatch.setattr(router, "_eval_k8s_json", fake_k8s_json)
    monkeypatch.setattr(router, "_eval_k8s_apply", fake_k8s_apply)
    monkeypatch.setattr(router, "_eval_k8s_delete", fake_k8s_delete)
    monkeypatch.setattr(router, "_prepare_benchmark_runtime", AsyncMock(return_value=("llmdbenchmark", bench_root)))
    monkeypatch.setattr(router, "wait_for_deployment_metrics", AsyncMock(return_value=True))
    monkeypatch.setattr(router, "capture_benchmark_context", AsyncMock(return_value=None))
    monkeypatch.setattr(router, "verify_benchmark_context", AsyncMock(return_value=None))
    monkeypatch.setattr(router, "_kubernetes_resource_snapshot", AsyncMock(return_value=None))
    monkeypatch.setattr(
        router,
        "collect_benchmark_observability",
        AsyncMock(return_value={"status": "unavailable", "reason": "test", "window": {}, "summary": {}, "series": []}),
    )
    monkeypatch.setattr(router.KVTraceCollector, "discover", AsyncMock(side_effect=ValueError("skip")))

    captured_cmds = []

    class _FakeFailedProcess:
        returncode = 1

        async def communicate(self):
            return b"", b"simulated-failure"

        async def wait(self):
            return 1

    async def fake_exec(*args, **kwargs):
        del kwargs
        captured_cmds.append(list(args))
        return _FakeFailedProcess()

    async def fake_stream(proc, *_args, **_kwargs):
        return await proc.communicate()

    monkeypatch.setattr(router, "_stream_benchmark_process", fake_stream)
    monkeypatch.setattr(router.asyncio, "create_subprocess_exec", fake_exec)

    await router._execute_owned(run["id"])

    assert seen_session_ids == ["prov-session"]
    assert run["endpoint_used"] == f"http://optimized-baseline-epp-model-servers.{ns}.svc.cluster.local:8000"
    assert run["endpoint_fallback"]["reason"] == "envoy_ext_proc_tls_mismatch_epp_plaintext"
    assert len(applied) == 1
    assert applied[0]["metadata"]["labels"][router._STANDUP_CM_MANAGED_LABEL] == "true"
    assert deleted == [("configmap", router._STANDUP_CM_NAME, ns)]
    cmd = captured_cmds[0]
    assert f"http://optimized-baseline-epp-model-servers.{ns}.svc.cluster.local:8000" in cmd
    override = next(arg for arg in cmd if arg.startswith("harness.extraEnvVars="))
    env_map = {item["name"]: item["value"] for item in json.loads(override.split("=", 1)[1])}
    decoded_epp = yaml.safe_load(base64.b64decode(env_map["LLMDBENCH_VLLM_MODELSERVICE_GAIE_PRESETS_CONFIG"]).decode())
    assert decoded_epp["plugins"] == [{"type": "queue-scorer"}]


def test_a_case_that_failed_by_exception_does_not_block_its_own_cleanup(monkeypatch):
    from llm_d_lens.deploy import usage

    workflow = {
        "id": "w1",
        "status": "running",
        "cases": [{"id": "c1", "status": "benchmarking", "execution_id": "e1"}],
    }
    monkeypatch.setattr(router, "_records", lambda kind: [workflow] if kind == "workflow" else [])
    monkeypatch.setattr(usage, "_probes", {"evaluate": router._deployment_usage_reason})
    # The failure status is only written after the cleanup in `finally` has run.
    with pytest.raises(usage.DeploymentInUseError):
        usage.require_unused("e1")
    with router._deployment_cleanup_guard("e1"):
        usage.require_unused("e1")
    with pytest.raises(usage.DeploymentInUseError):
        usage.require_unused("e1")


def _install_capabilities_target_compat(monkeypatch):
    from llm_d_lens.deploy import capabilities

    if not hasattr(capabilities, "DeploymentPermissionTarget"):

        class _CompatPermissionTarget:
            def __init__(self, **kwargs):
                for key, value in kwargs.items():
                    setattr(self, key, value)

        monkeypatch.setattr(capabilities, "DeploymentPermissionTarget", _CompatPermissionTarget, raising=False)
    if "targets" not in capabilities.DeploymentPermissionCheckRequest.model_fields:

        class _CompatPermissionCheckRequest:
            def __init__(self, **kwargs):
                for key, value in kwargs.items():
                    setattr(self, key, value)

        monkeypatch.setattr(capabilities, "DeploymentPermissionCheckRequest", _CompatPermissionCheckRequest)
    return capabilities


def _sample_guide_config(
    provider_ref: str = "optimized-baseline",
    *,
    deployment_name: str = "shared-name",
    release_name: str | None = "guide-rel",
    disaggregated: bool = False,
):
    content = {
        "model": {"name": "Qwen/Qwen3-0.6B"},
        "runtime": {"image": "example/vllm:test", "imageMode": "use-upstream-image"},
    }
    if disaggregated:
        content["disaggregatedSet"] = {"slices": 2}
    else:
        content["decode"] = {"replicaCount": 1, "tensorParallelSize": 1}
    if release_name:
        content["officialGuide"] = {
            "renderedManifest": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: demo\n",
            "deploymentBundle": {"helm": {"releaseName": release_name}},
        }
    return DeployableConfiguration(
        type="pd" if disaggregated else "baseline",
        provider_ref=provider_ref,
        format="manifest",
        content=content,
        checksum=configuration_checksum(content),
        provenance={"deployment_name": deployment_name, "cluster_ref": {"id": "cluster-1"}},
    )


def _patch_create_evaluation_env(monkeypatch, tmp_path, artifacts_by_id, *, can_create_namespaces=False):
    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(router, "deployment_runtime_overrides", lambda *_: {})
    monkeypatch.setattr(
        router,
        "require_active_session",
        lambda session_id: SimpleNamespace(id=session_id, server_id="cluster-1"),
    )
    monkeypatch.setattr(router, "cluster_deployment_source", lambda *_: {})
    monkeypatch.setattr(router, "_cluster_benchmark_runtime", lambda *_: {})
    monkeypatch.setattr(router, "_validate_evaluation_capacity", lambda *_: None)
    monkeypatch.setattr(
        router,
        "get_configuration_artifact",
        lambda artifact_id: SimpleNamespace(deployable_configuration=artifacts_by_id[artifact_id]),
    )
    monkeypatch.setattr(
        router.cluster_registry,
        "get_cluster",
        lambda cluster_id: SimpleNamespace(id=cluster_id) if cluster_id == "cluster-1" else None,
    )
    saved = []
    tasks = {}

    async def execute_noop(_workflow_id):
        pass

    monkeypatch.setattr(router, "_save", lambda record: saved.append(record))
    monkeypatch.setattr(router, "_execute_evaluation", execute_noop)
    monkeypatch.setattr(router, "_workflow_tasks", tasks)
    return saved, tasks, can_create_namespaces


@pytest.mark.asyncio
async def test_create_evaluation_preflight_deduplicates_groups_returns_403_then_202(monkeypatch, tmp_path):
    import json

    capabilities = _install_capabilities_target_compat(monkeypatch)
    capabilities.clear_verified_namespaces()
    a1 = "00000000-0000-4000-8000-000000000101"
    a2 = "00000000-0000-4000-8000-000000000102"
    cfg1 = _sample_guide_config("precise-prefix-cache-routing", release_name="pcc-rel")
    cfg2 = _sample_guide_config("tiered-prefix-cache", release_name="tpc-rel")
    saved, tasks, _ = _patch_create_evaluation_env(monkeypatch, tmp_path, {a1: cfg1, a2: cfg2})

    recorded_targets = []
    sufficient_flag = {"value": False}

    async def fake_check(req):
        recorded_targets.append(list(req.targets))
        if not sufficient_flag["value"]:
            return {
                "status": "admin_required",
                "sufficient": False,
                "canCreateNamespaces": False,
                "clusterId": req.cluster_id,
                "namespace": "llmd-setup1",
                "namespaces": ["llmd-setup1", "llmd-setup1-vllm", "llmd-setup2"],
                "identity": "user:edit",
                "adminOperations": [],
                "userOperations": [],
                "missing": [],
                "warnings": [],
                "targets": [
                    {
                        "key": t.key,
                        "namespace": t.namespace or f"llmd-{idx}",
                        "sufficient": False,
                    }
                    for idx, t in enumerate(req.targets)
                ],
            }
        return {
            "status": "sufficient",
            "sufficient": True,
            "canCreateNamespaces": False,
            "clusterId": req.cluster_id,
            "namespace": req.targets[0].namespace,
            "namespaces": [t.namespace for t in req.targets],
            "targets": [{"key": t.key, "namespace": t.namespace, "sufficient": True} for t in req.targets],
        }

    monkeypatch.setattr(capabilities, "check_deployment_permissions", fake_check)

    request_body = {
        "cluster_session_id": "00000000-0000-4000-8000-000000000199",
        "benchmark_plans": [
            {
                "id": "setup-1",
                "configuration_artifact_id": a1,
                "baseline_types": ["kubernetes-service", "direct-vllm"],
                "scenarios": [
                    {"id": "s1", "name": "S1", "benchmark": {"matrix": [{"isl": 64, "osl": 32}]}},
                    {"id": "s2", "name": "S2", "benchmark": {"matrix": [{"isl": 128, "osl": 32}]}},
                ],
            },
            {
                "id": "setup-2",
                "configuration_artifact_id": a2,
                "include_baseline": False,
            },
        ],
    }

    resp = await router.create_evaluation(EvaluationCreateRequest(**request_body))
    assert resp.status_code == 403
    payload = json.loads(resp.body)
    assert payload["code"] == "deployment_admin_setup_required"
    assert saved == []
    assert tasks == {}
    # 3 distinct groups: setup-1:guide (2 scenarios deduplicated), setup-1:baseline:direct-vllm, setup-2:guide
    # (kubernetes-service excluded!)
    assert [t.key for t in recorded_targets[0]] == [
        "setup-1:guide",
        "setup-2:guide",
        "setup-1:baseline:direct-vllm",
    ]
    by_key = {t.key: t for t in recorded_targets[0]}
    assert by_key["setup-1:guide"].uses_router is True
    assert by_key["setup-1:guide"].epp_service_accounts == ["pcc-rel-epp"]
    assert by_key["setup-1:baseline:direct-vllm"].uses_router is False

    sufficient_flag["value"] = True
    verified_map = {
        "setup-1:guide": "llmd-setup-1",
        "setup-2:guide": "llmd-setup-2",
        "setup-1:baseline:direct-vllm": "llmd-setup-1-vllm",
    }
    workflow = await router.create_evaluation(
        EvaluationCreateRequest(**{**request_body, "target_namespaces": verified_map})
    )
    assert workflow["status"] == "queued"
    assert len(saved) == 1
    await tasks[workflow["id"]]

    guide_cases = [c for c in workflow["cases"] if c.get("deployment_group_id") == "setup-1:guide"]
    assert len(guide_cases) == 2
    assert all(c["target_namespace"] == "llmd-setup-1" for c in guide_cases)
    ks_cases = [c for c in workflow["cases"] if c.get("baseline_type") == "kubernetes-service"]
    assert all("target_namespace" not in c for c in ks_cases)
    direct_case = next(c for c in workflow["cases"] if c.get("deployment_group_id") == "setup-1:baseline:direct-vllm")
    assert direct_case["target_namespace"] == "llmd-setup-1-vllm"
    deploy_req = router._evaluation_deployment_request(workflow, direct_case)
    assert deploy_req.provenance["target_namespace"] == "llmd-setup-1-vllm"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target_namespaces", "expected_code"),
    [
        ({"unknown:guide": "llmd-valid-1"}, "invalid_target_namespace_key"),
        ({"setup-1:guide": "kube-system"}, "protected_namespace"),
        ({"setup-1:guide": "not-prefixed"}, "invalid_namespace"),
        ({"setup-1:guide": "llmd-same", "setup-2:guide": "llmd-same"}, "duplicate_namespace"),
    ],
)
async def test_create_evaluation_rejects_invalid_target_namespaces_422(
    monkeypatch, tmp_path, target_namespaces, expected_code
):
    import json

    capabilities = _install_capabilities_target_compat(monkeypatch)
    monkeypatch.setattr(capabilities, "_namespace_prefix", lambda: "llmd-")
    a1 = "00000000-0000-4000-8000-000000000111"
    a2 = "00000000-0000-4000-8000-000000000112"
    saved, tasks, _ = _patch_create_evaluation_env(
        monkeypatch, tmp_path, {a1: _sample_guide_config(), a2: _sample_guide_config()}
    )
    req = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000199",
        benchmark_plans=[
            {"id": "setup-1", "configuration_artifact_id": a1, "include_baseline": False},
            {"id": "setup-2", "configuration_artifact_id": a2, "include_baseline": False},
        ],
        target_namespaces=target_namespaces,
    )
    resp = await router.create_evaluation(req)
    assert resp.status_code == 422
    assert json.loads(resp.body)["code"] == expected_code
    assert saved == []
    assert tasks == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("exc_factory", "expected_status", "expected_code"),
    [
        (lambda c: c.DeploymentClusterAuthError("401 unauthorized"), 401, "kubeconfig_unauthorized"),
        (lambda _c: router.ClusterInventoryAuthError("401 inventory unauthorized"), 401, "kubeconfig_unauthorized"),
        (lambda c: c.DeploymentCapabilityUnavailableError("ssar unavailable"), 503, "deployment_preflight_unavailable"),
    ],
)
async def test_create_evaluation_propagates_401_and_503_without_handoff(
    monkeypatch, tmp_path, exc_factory, expected_status, expected_code
):
    import json

    capabilities = _install_capabilities_target_compat(monkeypatch)
    a1 = "00000000-0000-4000-8000-000000000121"
    saved, tasks, _ = _patch_create_evaluation_env(monkeypatch, tmp_path, {a1: _sample_guide_config()})

    async def failing_check(_req):
        raise exc_factory(capabilities)

    monkeypatch.setattr(capabilities, "check_deployment_permissions", failing_check)
    req = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000199",
        benchmark_plans=[{"id": "setup-1", "configuration_artifact_id": a1, "include_baseline": False}],
    )
    resp = await router.create_evaluation(req)
    assert resp.status_code == expected_status
    assert json.loads(resp.body)["code"] == expected_code
    assert saved == []
    assert tasks == {}


@pytest.mark.asyncio
async def test_create_evaluation_enforces_cluster_access(monkeypatch, tmp_path):
    from llm_d_lens.auth.contracts import Principal, cluster_binding
    from llm_d_lens.core.exceptions import ForbiddenError

    a1 = "00000000-0000-4000-8000-000000000131"
    _patch_create_evaluation_env(monkeypatch, tmp_path, {a1: _sample_guide_config()})
    monkeypatch.setattr(
        router,
        "current_principal",
        lambda _req: Principal(
            user_id="user-1",
            username="user-1",
            bindings=(cluster_binding("operator", "other-cluster"),),
        ),
    )
    req = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000199",
        benchmark_plans=[{"id": "setup-1", "configuration_artifact_id": a1, "include_baseline": False}],
    )
    with pytest.raises(ForbiddenError):
        await router.create_evaluation(req)


@pytest.mark.asyncio
async def test_confirm_evaluation_plans_preflights_frozen_ds_namespace_403_then_202(monkeypatch, tmp_path):
    import json

    from llm_d_lens.db.dao import deployment_plan as plan_dao_mod
    from llm_d_lens.evaluation.models import EvaluationPlanConfirmation

    capabilities = _install_capabilities_target_compat(monkeypatch)
    capabilities.clear_verified_namespaces()
    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))

    ds_cfg = _sample_guide_config("pd-disaggregation", release_name=None, disaggregated=True)
    frozen_ns = "llmd-ds-frozen"
    plan_obj = SimpleNamespace(
        id="plan-ds-1",
        digest="sha256:abc",
        owner_user_id=None,
        cluster_id="cluster-1",
        preflight={"status": "pass"},
        payload={
            "artifacts": [
                {
                    "context": {"namespace": frozen_ns, "runtime": {}},
                    "manifest": "apiVersion: leaderworkerset.x-k8s.io/v1\nkind: LeaderWorkerSet\nmetadata:\n  name: ds\n",
                    "artifact": {
                        "deployment_contract": {
                            "preparedNamespace": {"metadata": {"labels": {"lens.io/prepared-request": "req-1"}}},
                            "deploymentBundle": {"frozen": {"manifest": ""}, "resources": []},
                        }
                    },
                }
            ]
        },
    )

    class _FakePlanDao:
        def get(self, plan_id):
            return plan_obj if plan_id == "plan-ds-1" else None

    monkeypatch.setattr(plan_dao_mod, "DeploymentPlanDao", _FakePlanDao)
    monkeypatch.setattr(
        router.cluster_registry,
        "get_cluster",
        lambda cluster_id: SimpleNamespace(id=cluster_id) if cluster_id == "cluster-1" else None,
    )
    monkeypatch.setattr(router, "current_principal", lambda _req: None)
    monkeypatch.setattr(router, "owner_for_create", lambda _p: None)

    workflow = {
        "kind": "workflow",
        "id": "00000000-0000-4000-8000-000000000141",
        "status": "awaiting_review",
        "cluster_id": "cluster-1",
        "cluster_session_id": "00000000-0000-4000-8000-000000000199",
        "owner_user_id": None,
        "runtime": {},
        "prepared_plans": [{"id": "plan-ds-1", "digest": "sha256:abc"}],
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "setup-1:guide",
                "prepared_plan_id": "plan-ds-1",
                "prepared_plan_digest": "sha256:abc",
                "deployment_configuration": ds_cfg.model_dump(mode="json"),
            }
        ],
    }
    router._save(workflow)

    sufficient_flag = {"value": False}
    seen_targets = []

    async def fake_check(req):
        seen_targets.append(list(req.targets))
        if not sufficient_flag["value"]:
            return {
                "status": "admin_required",
                "sufficient": False,
                "canCreateNamespaces": False,
                "clusterId": req.cluster_id,
                "namespace": frozen_ns,
                "namespaces": [frozen_ns],
                "targets": [{"key": req.targets[0].key, "namespace": frozen_ns, "sufficient": False}],
            }
        return {
            "status": "sufficient",
            "sufficient": True,
            "canCreateNamespaces": False,
            "clusterId": req.cluster_id,
            "namespace": frozen_ns,
            "namespaces": [frozen_ns],
            "targets": [{"key": req.targets[0].key, "namespace": frozen_ns, "sufficient": True}],
        }

    monkeypatch.setattr(capabilities, "check_deployment_permissions", fake_check)
    tasks = {}
    monkeypatch.setattr(router, "_workflow_tasks", tasks)

    async def execute_noop(_wf_id):
        pass

    monkeypatch.setattr(router, "_execute_evaluation", execute_noop)

    resp = await router.confirm_evaluation_plans(
        workflow["id"],
        EvaluationPlanConfirmation(plan_digests={"plan-ds-1": "sha256:abc"}),
        None,
    )
    assert resp.status_code == 403
    assert json.loads(resp.body)["code"] == "deployment_admin_setup_required"
    assert seen_targets[0][0].namespace == frozen_ns
    assert seen_targets[0][0].uses_lws is True
    assert seen_targets[0][0].prepared_request_id == "req-1"
    assert router._get("workflow", workflow["id"])["status"] == "awaiting_review"

    sufficient_flag["value"] = True
    confirmed = await router.confirm_evaluation_plans(
        workflow["id"],
        EvaluationPlanConfirmation(
            plan_digests={"plan-ds-1": "sha256:abc"},
            target_namespaces={"setup-1:guide": frozen_ns},
        ),
        None,
    )
    assert confirmed["status"] == "queued"
    await tasks[workflow["id"]]
    assert confirmed["cases"][0]["target_namespace"] == frozen_ns
    assert capabilities.peek_verified_namespace("cluster-1", prepared_plan_id="plan-ds-1") == frozen_ns
    # Prepared cases never receive target_namespace or agentic_deployment_run_id in provenance
    ds_req = router._evaluation_deployment_request(confirmed, confirmed["cases"][0])
    assert "target_namespace" not in ds_req.provenance
    assert "agentic_deployment_run_id" not in ds_req.provenance


@pytest.mark.asyncio
async def test_execute_evaluation_binds_unique_eval_case_id_and_handles_cleanup_handoff(monkeypatch, tmp_path):
    capabilities = _install_capabilities_target_compat(monkeypatch)
    capabilities.clear_verified_namespaces()
    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))

    cfg_guide = _sample_guide_config("optimized-baseline", deployment_name="same-model-name")
    cfg_base = _sample_guide_config("baseline-vllm", deployment_name="same-model-name", release_name=None)

    workflow_id = "00000000-0000-4000-8000-000000000151"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "queued",
        "cluster_id": "cluster-1",
        "cluster_session_id": "00000000-0000-4000-8000-000000000199",
        "owner_user_id": "user-1",
        "runtime": {},
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "p1:guide",
                "target_namespace": "llmd-guide-ns",
                "preserve_deployment": False,
                "deployment_configuration": cfg_guide.model_dump(mode="json"),
            },
            {
                "id": "baseline-1",
                "kind": "baseline",
                "status": "queued",
                "deployment_group_id": "p1:baseline:direct-vllm",
                "target_namespace": "llmd-base-ns",
                "preserve_deployment": False,
                "deployment_configuration": cfg_base.model_dump(mode="json"),
            },
        ],
    }
    router._save(workflow)
    monkeypatch.setattr(
        router.cluster_registry,
        "get_cluster",
        lambda cluster_id: SimpleNamespace(id=cluster_id) if cluster_id == "cluster-1" else None,
    )
    monkeypatch.setattr(router, "_runtime_binding", lambda _wf: router.RuntimeBinding(cluster_session_id="s1"))
    monkeypatch.setattr(router, "_ordered_evaluation_cases", lambda cases: cases)
    monkeypatch.setattr(router, "_comparison_report", lambda _wf: {"ok": True})
    monkeypatch.setattr(router, "_has_pending_suite_scenario", lambda _wf, _c: False)

    # Guide has marker present; Baseline simulates expired >1h markerless namespace needing live SSAR
    async def fake_marker(cluster_id, ns):
        assert cluster_id == "cluster-1"
        return ns == "llmd-guide-ns"

    async def fake_live_check(req):
        assert req.targets[0].namespace == "llmd-base-ns"
        return {"sufficient": True}

    monkeypatch.setattr(capabilities, "is_bootstrap_marker_present", fake_marker)
    monkeypatch.setattr(capabilities, "check_deployment_permissions", fake_live_check)

    started_bindings = []
    ready_case_map = {
        "dep-guide-1": SimpleNamespace(
            id="dc-1",
            status=SimpleNamespace(value="ready"),
            execution_id="exec-1",
            attempt=1,
            provider_ref="optimized-baseline",
        ),
        "dep-baseline-1": SimpleNamespace(
            id="dc-2",
            status=SimpleNamespace(value="ready"),
            execution_id="exec-2",
            attempt=1,
            provider_ref="baseline-vllm",
        ),
    }
    executions = {
        "exec-1": SimpleNamespace(
            status=router.DeploymentStatus.READY,
            namespace="llmd-guide-ns",
            endpoint=SimpleNamespace(url="http://g", baseline_url=None),
        ),
        "exec-2": SimpleNamespace(
            status=router.DeploymentStatus.READY,
            namespace="llmd-base-ns",
            endpoint=SimpleNamespace(url="http://b", baseline_url=None),
        ),
    }

    async def fake_start_run(deploy_req, owner_user_id=None):
        case_id = deploy_req.provenance["evaluation_case_id"]
        binding_id = deploy_req.provenance["agentic_deployment_run_id"]
        ns = capabilities.consume_verified_namespace(
            "cluster-1",
            owner_user_id=owner_user_id,
            agentic_deployment_run_id=binding_id,
            deployment_name="same-model-name",
        )
        started_bindings.append((case_id, binding_id, deploy_req.provenance["target_namespace"], ns))
        dep_id = f"dep-{case_id}"
        return SimpleNamespace(id=dep_id, cases=[ready_case_map[dep_id]])

    async def fake_wait(dep_id):
        return SimpleNamespace(id=dep_id), ready_case_map[dep_id]

    async def fake_benchmark(_wf, case, _exec_id):
        case.update(status="succeeded", finished_at=router._now())

    class _CleanupWorker:
        async def delete_case_execution(self, _run_id, case_id):
            if case_id == "dc-1":
                raise router.DeploymentCleanupPermissionDenied(
                    "delete namespace forbidden",
                    payload={
                        "executionId": "exec-1",
                        "clusterId": "cluster-1",
                        "namespace": "llmd-guide-ns",
                        "phase1Completed": True,
                        "adminCleanup": {"cleanupDigest": "a" * 64},
                    },
                )

    monkeypatch.setattr(
        router,
        "_store",
        SimpleNamespace(
            get_run=lambda run_id: SimpleNamespace(id=run_id, cases=[ready_case_map[run_id]]),
            get_execution=lambda exec_id: executions[exec_id],
        ),
    )
    monkeypatch.setattr(
        router,
        "deployment_run_manager",
        SimpleNamespace(start_run=fake_start_run, worker_for_run=lambda *_: _CleanupWorker()),
    )
    monkeypatch.setattr(router, "_wait_for_deployment", fake_wait)
    monkeypatch.setattr(router, "_run_case_benchmark", fake_benchmark)

    await router._execute_evaluation(workflow_id)

    assert started_bindings == [
        ("guide-1", f"eval:{workflow_id}:guide-1", "llmd-guide-ns", "llmd-guide-ns"),
        ("baseline-1", f"eval:{workflow_id}:baseline-1", "llmd-base-ns", "llmd-base-ns"),
    ]
    final = router._get("workflow", workflow_id)
    assert final["status"] == "succeeded"
    assert final["cases"][0]["cleanup_status"] == "pending_admin_cleanup"
    assert final["cases"][0]["cleanup_handoff"]["executionId"] == "exec-1"
    assert final["cases"][0].get("cleanup_error") is None
    assert final["cases"][1]["status"] == "succeeded"
    assert len(final["pending_admin_cleanups"]) == 1
    assert final["pending_admin_cleanups"][0]["executionId"] == "exec-1"


@pytest.mark.asyncio
async def test_shared_pods_baseline_records_cleanup_handoff_and_excludes_phase1_from_ready(monkeypatch, tmp_path):
    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))
    workflow_id = "00000000-0000-4000-8000-000000000161"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "running",
        "cluster_id": "cluster-1",
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "succeeded",
                "deployment_run_id": "dep-1",
                "deployment_case_id": "dc-1",
                "execution_id": "exec-1",
                "preserve_deployment": False,
            },
            {
                "id": "baseline-ks",
                "kind": "baseline",
                "status": "queued",
                "baseline_type": "kubernetes-service",
                "dependent_guide_case_id": "guide-1",
            },
        ],
    }
    phase1_exec = SimpleNamespace(
        status=router.DeploymentStatus.READY,
        namespace="llmd-guide-ns",
        endpoint=SimpleNamespace(url="http://g", baseline_url="http://ks"),
        diagnostics=SimpleNamespace(value={"cleanup": {"phase1": {"phase1Completed": True}}}),
    )
    dep_run = SimpleNamespace(
        id="dep-1",
        created_at="2026-01-01T00:00:00Z",
        cases=[
            SimpleNamespace(
                id="dc-1",
                status=SimpleNamespace(value="ready"),
                execution_id="exec-1",
                attempt=1,
                create_request=SimpleNamespace(provenance={}),
            )
        ],
    )
    monkeypatch.setattr(
        router,
        "_store",
        SimpleNamespace(
            list_runs=lambda: [dep_run],
            get_run=lambda _id: dep_run,
            get_execution=lambda _id: phase1_exec,
        ),
    )
    # Phase-1-cleaned execution must never be reused by _ready_deployment_case
    assert router._ready_deployment_case(workflow_id, workflow["cases"][0]) == (None, None)

    async def fake_run_bench(_wf, case, _exec_id, use_baseline_endpoint=False):
        assert use_baseline_endpoint is True
        case.update(status="succeeded")

    class _CleanupWorker:
        async def delete_case_execution(self, _run_id, _case_id):
            raise router.DeploymentCleanupPermissionDenied(
                "namespace deletion requires admin",
                payload={"executionId": "exec-1", "namespace": "llmd-guide-ns", "phase1Completed": True},
            )

    monkeypatch.setattr(router, "_run_case_benchmark", fake_run_bench)
    monkeypatch.setattr(
        router,
        "deployment_run_manager",
        SimpleNamespace(worker_for_run=lambda *_: _CleanupWorker()),
    )

    await router._execute_shared_pods_baseline_case(workflow, workflow["cases"][1])
    assert workflow["cases"][0]["cleanup_status"] == "pending_admin_cleanup"
    assert workflow["cases"][0]["cleanup_handoff"]["executionId"] == "exec-1"
    assert workflow["pending_admin_cleanups"][0]["executionId"] == "exec-1"


@pytest.mark.asyncio
async def test_cancel_and_delete_workflow_handle_cleanup_permission_denied(monkeypatch, tmp_path):
    import json

    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))
    workflow_id = "00000000-0000-4000-8000-000000000171"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "running",
        "cluster_id": "cluster-1",
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "benchmarking",
                "deployment_run_id": "dep-1",
                "execution_id": "exec-1",
            }
        ],
    }
    router._save(workflow)
    monkeypatch.setattr(router, "_restore_deployment_links", lambda _wf: False)

    class _Worker:
        async def cancel_evaluation_deployment(self, _dep_id):
            raise router.DeploymentCleanupPermissionDenied(
                "admin namespace deletion required",
                payload={"executionId": "exec-1", "namespace": "llmd-guide-ns", "phase1Completed": True},
            )

        async def delete_run(self, _dep_id):
            raise router.DeploymentCleanupPermissionDenied(
                "admin namespace deletion required",
                payload={"executionId": "exec-1", "namespace": "llmd-guide-ns", "phase1Completed": True},
            )

    monkeypatch.setattr(router, "deployment_run_manager", SimpleNamespace(worker_for_run=lambda *_: _Worker()))
    monkeypatch.setattr(router, "_store", SimpleNamespace(get_run=lambda _id: object()))

    cancel_result = await router._cancel_evaluation(router._get("workflow", workflow_id))
    assert cancel_result["status"] == "cancelled"
    cancelled_wf = router._get("workflow", workflow_id)
    assert cancelled_wf["status"] == "cancelled"
    assert cancelled_wf["cases"][0]["status"] == "cancelled"
    assert cancelled_wf["cases"][0]["cleanup_status"] == "pending_admin_cleanup"
    assert cancelled_wf["pending_admin_cleanups"][0]["executionId"] == "exec-1"

    delete_resp = await router.delete_workflow_run(workflow_id)
    assert delete_resp.status_code == 409
    delete_payload = json.loads(delete_resp.body)
    assert delete_payload["code"] == "deployment_cleanup_permission_denied"
    assert delete_payload["executionId"] == "exec-1"
    assert router._get("workflow", workflow_id) is not None


@pytest.mark.asyncio
async def test_retry_workflow_run_clears_phase1_namespace_retains_unused_and_preflights(monkeypatch, tmp_path):
    import json

    from llm_d_lens.evaluation.models import EvaluationRetryRequest

    capabilities = _install_capabilities_target_compat(monkeypatch)
    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(capabilities, "_namespace_prefix", lambda: "llmd-")

    cfg = _sample_guide_config("optimized-baseline")
    workflow_id = "00000000-0000-4000-8000-000000000181"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "failed",
        "cluster_id": "cluster-1",
        "cluster_session_id": "00000000-0000-4000-8000-000000000199",
        "cases": [
            {
                "id": "guide-1-1",
                "kind": "guide",
                "status": "failed",
                "deployment_group_id": "plan-1:guide",
                "target_namespace": "llmd-case1",
                "cleanup_status": "pending_admin_cleanup",
                "cleanup_handoff": {"executionId": "exec-1"},
                "cleanup_error": "old error",
                "deployment_run_id": "dep-1",
                "execution_id": "exec-1",
                "deployment_configuration": cfg.model_dump(mode="json"),
            },
            {
                "id": "guide-1-2",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "plan-1:guide",
                "target_namespace": "llmd-case1",
                "cleanup_status": "pending_admin_cleanup",
                "cleanup_handoff": {"executionId": "exec-1"},
                "deployment_configuration": cfg.model_dump(mode="json"),
            },
            {
                "id": "guide-2",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "plan-2:guide",
                "target_namespace": "llmd-case2",
                "deployment_configuration": cfg.model_dump(mode="json"),
            },
        ],
    }
    router._save(workflow)
    monkeypatch.setattr(router, "deployment_runtime_overrides", lambda *_: {})
    monkeypatch.setattr(
        router.cluster_registry,
        "get_cluster",
        lambda cluster_id: SimpleNamespace(id=cluster_id) if cluster_id == "cluster-1" else None,
    )
    monkeypatch.setattr(
        router,
        "_store",
        SimpleNamespace(
            list_runs=lambda: [],
            get_run=lambda _id: None,
            get_execution=lambda _id: None,
            list_executions=lambda: [
                SimpleNamespace(namespace="llmd-case1", status=router.DeploymentStatus.FAILED),
            ],
        ),
    )

    observed_targets = []
    sufficient_flag = {"value": False}

    async def fake_check(req):
        observed_targets.append([(t.key, t.namespace) for t in req.targets])
        if not sufficient_flag["value"]:
            return {
                "status": "admin_required",
                "sufficient": False,
                "canCreateNamespaces": False,
                "clusterId": req.cluster_id,
                "namespace": "llmd-case1-2",
                "namespaces": ["llmd-case1-2", "llmd-case2"],
                "targets": [
                    {"key": "plan-1:guide", "namespace": "llmd-case1-2", "sufficient": False},
                    {"key": "plan-2:guide", "namespace": "llmd-case2", "sufficient": True},
                ],
            }
        return {
            "status": "sufficient",
            "sufficient": True,
            "canCreateNamespaces": False,
            "clusterId": req.cluster_id,
            "namespace": req.targets[0].namespace,
            "namespaces": [t.namespace for t in req.targets],
            "targets": [{"key": t.key, "namespace": t.namespace, "sufficient": True} for t in req.targets],
        }

    monkeypatch.setattr(capabilities, "check_deployment_permissions", fake_check)
    tasks = {}
    monkeypatch.setattr(router, "_workflow_tasks", tasks)

    async def execute_noop(_wf_id):
        pass

    monkeypatch.setattr(router, "_execute_evaluation", execute_noop)

    resp = await router.retry_workflow_run(workflow_id)
    assert resp.status_code == 403
    assert json.loads(resp.body)["code"] == "deployment_admin_setup_required"
    # Case 1 cleared its Phase-1 namespace (None -> auto-derive -2); Case 2 retained its unused namespace!
    assert observed_targets[0] == [("plan-1:guide", None), ("plan-2:guide", "llmd-case2")]

    sufficient_flag["value"] = True
    retried = await router.retry_workflow_run(
        workflow_id,
        EvaluationRetryRequest(target_namespaces={"plan-1:guide": "llmd-case1-2"}),
    )
    assert retried["status"] == "queued"
    await tasks[workflow_id]
    assert retried["cases"][0]["target_namespace"] == "llmd-case1-2"
    assert retried["cases"][1]["target_namespace"] == "llmd-case1-2"
    assert retried["cases"][2]["target_namespace"] == "llmd-case2"
    for case in retried["cases"][:2]:
        assert "cleanup_status" not in case
        assert "cleanup_handoff" not in case
        assert "cleanup_error" not in case


def test_mcp_catalog_retry_evaluation_workflow_keeps_workflow_id_only_required():
    from fastapi import FastAPI

    from llm_d_lens.assistant_tools.catalog import generate_catalog

    app = FastAPI()
    app.include_router(router.router, prefix="/api/v1/evaluate")
    tools = generate_catalog(app.openapi())
    retry_tool = next(tool for tool in tools if tool["name"] == "retry_evaluation_workflow")
    assert retry_tool["inputSchema"]["required"] == ["workflow_id"]
    assert "target_namespaces" in retry_tool["inputSchema"]["properties"]


@pytest.mark.asyncio
async def test_evaluation_cross_cluster_role_escalation_and_self_scope_blocked(monkeypatch, tmp_path):
    from fastapi import HTTPException

    from llm_d_lens.auth.contracts import Principal, RoleBinding, ScopeType
    from llm_d_lens.auth.permissions import BUILTIN_ROLE_PERMISSIONS
    from llm_d_lens.core.exceptions import ForbiddenError
    from llm_d_lens.evaluation.models import EvaluationPlanConfirmation

    monkeypatch.setenv("LENS_DATA_DIR", str(tmp_path))
    a1 = "00000000-0000-4000-8000-000000000201"
    cfg = _sample_guide_config("optimized-baseline")
    _patch_create_evaluation_env(monkeypatch, tmp_path, {a1: cfg})
    monkeypatch.setattr(
        router,
        "require_active_session",
        lambda session_id: SimpleNamespace(id=session_id, server_id="cluster-b"),
    )

    cross_cluster_principal = Principal(
        user_id="user-1",
        username="user-1",
        bindings=(
            RoleBinding("maintainer", ScopeType.CLUSTER, scope_cluster_id="cluster-a"),
            RoleBinding("end-user", ScopeType.CLUSTER, scope_cluster_id="cluster-b"),
        ),
        role_permissions=BUILTIN_ROLE_PERMISSIONS,
    )
    global_end_user_principal = Principal(
        user_id="user-1",
        username="user-1",
        bindings=(
            RoleBinding("maintainer", ScopeType.CLUSTER, scope_cluster_id="cluster-a"),
            RoleBinding("end-user", ScopeType.GLOBAL),
        ),
        role_permissions=BUILTIN_ROLE_PERMISSIONS,
    )

    req = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000299",
        benchmark_plans=[{"id": "setup-1", "configuration_artifact_id": a1, "include_baseline": False}],
    )
    for principal in (cross_cluster_principal, global_end_user_principal):
        monkeypatch.setattr(router, "current_principal", lambda _req, p=principal: p)
        with pytest.raises(ForbiddenError):
            await router.create_evaluation(req)

    # confirm_evaluation_plans rejects cross-cluster escalation even when caller owns the record
    stored_workflows = {}
    monkeypatch.setattr(router, "_get", lambda kind, wf_id: stored_workflows.get(wf_id) if kind == "workflow" else None)
    monkeypatch.setattr(router, "_save", lambda rec: stored_workflows.__setitem__(rec["id"], rec))
    confirm_wf = {
        "kind": "workflow",
        "id": "00000000-0000-4000-8000-000000000211",
        "status": "awaiting_review",
        "cluster_id": "cluster-b",
        "owner_user_id": "user-1",
        "prepared_plans": [{"id": "plan-1", "digest": "sha256:abc"}],
        "cases": [],
    }
    router._save(confirm_wf)
    monkeypatch.setattr(router, "current_principal", lambda _req: cross_cluster_principal)
    with pytest.raises(ForbiddenError):
        await router.confirm_evaluation_plans(
            confirm_wf["id"],
            EvaluationPlanConfirmation(plan_digests={"plan-1": "sha256:abc"}),
            SimpleNamespace(state=SimpleNamespace(principal=cross_cluster_principal)),
        )

    # retry_workflow_run rejects cross-cluster escalation on both explicit cluster_id and backfilled legacy records
    retry_wf = {
        "kind": "workflow",
        "id": "00000000-0000-4000-8000-000000000212",
        "status": "failed",
        "cluster_id": "cluster-b",
        "cluster_session_id": "00000000-0000-4000-8000-000000000299",
        "owner_user_id": "user-1",
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "failed",
                "deployment_configuration": cfg.model_dump(mode="json"),
            }
        ],
    }
    router._save(retry_wf)
    for principal in (cross_cluster_principal, global_end_user_principal):
        monkeypatch.setattr(router, "current_principal", lambda _req, p=principal: p)
        with pytest.raises(ForbiddenError):
            await router.retry_workflow_run(retry_wf["id"])

    # Legacy workflow with cluster_id=None must backfill cluster_id before enforcing action x cluster_scope
    legacy_wf = {**retry_wf, "id": "00000000-0000-4000-8000-000000000213", "cluster_id": None}
    router._save(legacy_wf)
    monkeypatch.setattr(
        router.sessions,
        "get_session",
        lambda sid: SimpleNamespace(id=sid, server_id="cluster-b") if sid == legacy_wf["cluster_session_id"] else None,
    )
    monkeypatch.setattr(router, "current_principal", lambda _req: cross_cluster_principal)
    with pytest.raises(ForbiddenError):
        await router.retry_workflow_run(legacy_wf["id"])

    # Self-scoped evaluate:run:retry user on cluster-b cannot retry another owner's workflow
    self_scoped_retry_principal = Principal(
        user_id="user-2",
        username="user-2",
        bindings=(RoleBinding("custom-eval", ScopeType.CLUSTER, scope_cluster_id="cluster-b"),),
        role_permissions={"custom-eval": frozenset({"evaluate:run:retry"})},
        role_self_scoped={"custom-eval": frozenset({"evaluate:run:retry"})},
    )
    monkeypatch.setattr(router, "current_principal", lambda _req: self_scoped_retry_principal)
    with pytest.raises(HTTPException) as err:
        await router.retry_workflow_run(retry_wf["id"])
    assert err.value.status_code == 403


@pytest.mark.asyncio
async def test_stale_bootstrap_marker_rejected_in_preflight_and_execute_without_recording(monkeypatch, tmp_path):
    import json

    capabilities = _install_capabilities_target_compat(monkeypatch)
    capabilities.clear_verified_namespaces()
    orig_execute_evaluation = router._execute_evaluation
    a1 = "00000000-0000-4000-8000-000000000301"
    cfg = _sample_guide_config("baseline-vllm")
    saved, tasks, _ = _patch_create_evaluation_env(monkeypatch, tmp_path, {a1: cfg})

    stale_report = {
        "status": "sufficient",
        "sufficient": True,
        "canCreateNamespaces": False,
        "clusterId": "cluster-1",
        "namespace": "llmd-stale-ns",
        "namespaces": ["llmd-stale-ns"],
        "marker": {"namespace": "llmd-stale-ns", "present": False, "status": "stale", "verified": False},
        "targets": [
            {
                "key": "setup-1:guide",
                "namespace": "llmd-stale-ns",
                "sufficient": True,
                "marker": {"namespace": "llmd-stale-ns", "present": False, "status": "stale", "verified": False},
            }
        ],
    }

    async def fake_check(_req):
        return stale_report

    recorded = []
    monkeypatch.setattr(capabilities, "check_deployment_permissions", fake_check)
    monkeypatch.setattr(capabilities, "record_verified_namespace", lambda *a, **kw: recorded.append((a, kw)))

    req = EvaluationCreateRequest(
        cluster_session_id="00000000-0000-4000-8000-000000000399",
        benchmark_plans=[{"id": "setup-1", "configuration_artifact_id": a1, "include_baseline": False}],
        target_namespaces={"setup-1:guide": "llmd-stale-ns"},
    )
    resp = await router.create_evaluation(req)
    assert resp.status_code == 403
    assert json.loads(resp.body)["code"] == "deployment_admin_setup_required"
    assert recorded == []
    assert saved == []
    assert tasks == {}

    # Also verify _execute_evaluation rejects a stale marker without calling record_verified_namespace or start_run
    workflow_id = "00000000-0000-4000-8000-000000000311"
    workflow = {
        "kind": "workflow",
        "id": workflow_id,
        "status": "queued",
        "cluster_id": "cluster-1",
        "cluster_session_id": "00000000-0000-4000-8000-000000000399",
        "owner_user_id": "alice",
        "runtime": {},
        "cases": [
            {
                "id": "guide-1",
                "kind": "guide",
                "status": "queued",
                "deployment_group_id": "setup-1:guide",
                "target_namespace": "llmd-stale-ns",
                "deployment_configuration": cfg.model_dump(mode="json"),
            }
        ],
    }
    stored_workflows = {workflow_id: workflow}
    monkeypatch.setattr(router, "_execute_evaluation", orig_execute_evaluation)
    monkeypatch.setattr(router, "_get", lambda kind, wf_id: stored_workflows.get(wf_id) if kind == "workflow" else None)
    monkeypatch.setattr(router, "_save", lambda rec: stored_workflows.__setitem__(rec["id"], rec))
    monkeypatch.setattr(router, "_restore_deployment_links", lambda _wf: False)
    monkeypatch.setattr(router, "deployment_runtime_overrides", lambda *_: {})

    async def fake_marker_present(_cid, _ns):
        return False

    start_calls = []

    async def fake_start_run(*_a, **_kw):
        start_calls.append(True)
        raise AssertionError("start_run must not be called when bootstrap marker is stale")

    monkeypatch.setattr(capabilities, "is_bootstrap_marker_present", fake_marker_present)
    monkeypatch.setattr(router, "deployment_run_manager", SimpleNamespace(start_run=fake_start_run))

    await router._execute_evaluation(workflow_id)

    final_wf = router._get("workflow", workflow_id)
    assert final_wf["status"] == "failed"
    assert "requires Orchestration administrator bootstrap" in final_wf["error"]
    assert recorded == []
    assert start_calls == []
