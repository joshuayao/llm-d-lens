"""Tests for mapping Agentic candidates to existing Deploy configurations."""

import pytest

from llm_d_lens.agentic.configuration import build_agentic_configuration
from llm_d_lens.agentic.planner import PlannedCandidate
from llm_d_lens.configuration.models import ModelSecretConfiguration
from llm_d_lens.deploy.configuration_adapter import DeploymentConfigurationPlanner
from llm_d_lens.deploy.standard_kubernetes_service import StandardKubernetesServiceRequest


@pytest.mark.parametrize(
    ("provider_ref", "configuration_type"),
    [
        ("optimized-baseline", "baseline"),
        ("pd-disaggregation", "pd"),
        ("tiered-prefix-cache", "tiered_cache"),
        ("precise-prefix-cache-routing", "baseline"),
    ],
)
def test_registered_guide_candidate_maps_to_deployable_configuration(provider_ref, configuration_type):
    request = StandardKubernetesServiceRequest(
        model="Qwen/Qwen3-8B",
        deployment_name="agentic",
        cluster_session_id="a" * 36,
        replicas=1,
        tensor_parallel_size=1,
        storage_volume_id="storage-model-cache",
    )
    candidate = PlannedCandidate(
        id=f"{provider_ref}-tp1-r1",
        provider_ref=provider_ref,
        replicas=1,
        tensor_parallel_size=1,
        prefill_replicas=1,
        prefill_tensor_parallel_size=1,
        guide_variant="native/cpu/base" if provider_ref == "tiered-prefix-cache" else "vllm",
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=2 if provider_ref == "pd-disaggregation" else 1,
        deployable=True,
    )

    configuration = build_agentic_configuration(request, candidate)

    assert configuration.provider_ref == provider_ref
    assert configuration.type == configuration_type
    assert configuration.content["decode"]["tensorParallelSize"] == 1
    assert configuration.content["decode"]["gpuMemoryUtilization"] == 0.9
    assert "modelSecret" not in configuration.content
    cases = DeploymentConfigurationPlanner().plan([configuration], run_id="run-1")
    assert cases[0].provider_ref == provider_ref
    if provider_ref == "pd-disaggregation":
        assert configuration.content["prefill"]["replicaCount"] == 1
    if provider_ref == "tiered-prefix-cache":
        assert configuration.content["guideVariant"] == "native/cpu"


@pytest.mark.parametrize("max_model_len", [32768, 40960, 262144, 1048576])
def test_runtime_vllm_parameters_override_candidate_placeholders_after_approval(max_model_len):
    request = StandardKubernetesServiceRequest(
        model="Qwen/Qwen3-8B",
        deployment_name="agentic",
        cluster_session_id="a" * 36,
        replicas=1,
        tensor_parallel_size=1,
        storage_volume_id="storage-model-cache",
        max_model_len=max_model_len,
        gpu_memory_utilization=0.72,
        max_num_seqs=64,
        max_num_batched_tokens=4096,
    )
    candidate = PlannedCandidate(
        id="pd-disaggregation-p1-d1-tp1",
        provider_ref="pd-disaggregation",
        replicas=1,
        tensor_parallel_size=1,
        prefill_replicas=1,
        prefill_tensor_parallel_size=1,
        guide_variant="vllm",
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=2,
        deployable=True,
    )

    configuration = build_agentic_configuration(request, candidate)

    assert configuration.content["decode"]["maxModelLen"] == max_model_len
    assert configuration.content["decode"]["gpuMemoryUtilization"] == 0.72
    assert configuration.content["prefill"]["maxModelLen"] == max_model_len
    parameters = {item["name"]: item["value"] for item in configuration.content["customParameters"]}
    assert parameters["gpu-memory-utilization"] == "0.72"
    assert (
        next(
            item["target"]
            for item in configuration.content["customParameters"]
            if item["name"] == "gpu-memory-utilization"
        )
        == "both"
    )
    assert parameters["max-num-batched-tokens"] == "4096"


def test_agentic_configuration_propagates_model_cache_host_token_policy():
    """Guard the planning-to-deployment boundary that originally dropped credentials."""
    request = StandardKubernetesServiceRequest(
        model="google/gemma-4-12B-it-qat-w4a16-ct",
        deployment_name="agentic",
        cluster_session_id="a" * 36,
        replicas=1,
        tensor_parallel_size=1,
        storage_volume_id="storage-model-cache",
    )
    candidate = PlannedCandidate(
        id="optimized-baseline-tp1-r1",
        provider_ref="optimized-baseline",
        replicas=1,
        tensor_parallel_size=1,
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=1,
        deployable=True,
    )

    configuration = build_agentic_configuration(
        request,
        candidate,
        ModelSecretConfiguration(mode="host"),
    )
    case = DeploymentConfigurationPlanner().plan([configuration], run_id="run-1")[0]

    assert configuration.content["modelSecret"] == {
        "mode": "host",
        "sourceNamespace": None,
        "sourceName": None,
    }
    assert case.create_request.deployment_policy.value["model_secret"]["mode"] == "host"


@pytest.mark.parametrize(
    "model_secret",
    [
        ModelSecretConfiguration(mode="host"),
        ModelSecretConfiguration(
            mode="existing-secret",
            sourceNamespace="models",
            sourceName="hf-token",
        ),
    ],
    ids=["host", "existing-secret"],
)
def test_agentic_baseline_vllm_propagates_model_secret_policy(model_secret):
    """Baseline candidates must retain the Model Cache credential policy."""
    request = StandardKubernetesServiceRequest(
        model="Qwen/Qwen3-8B",
        deployment_name="agentic",
        cluster_session_id="a" * 36,
        replicas=1,
        tensor_parallel_size=1,
        storage_volume_id="storage-model-cache",
    )
    candidate = PlannedCandidate(
        id="baseline-vllm-tp1-r1",
        provider_ref="baseline-vllm",
        replicas=1,
        tensor_parallel_size=1,
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=1,
        deployable=True,
    )

    configuration = build_agentic_configuration(request, candidate, model_secret)
    case = DeploymentConfigurationPlanner().plan([configuration], run_id="run-1")[0]

    assert configuration.content["modelSecret"] == model_secret.model_dump(mode="json", by_alias=True)
    assert case.create_request.deployment_policy.value["model_secret"] == model_secret.model_dump(
        mode="json",
        by_alias=True,
    )


@pytest.mark.parametrize("provider_ref", ["baseline-vllm", "optimized-baseline", "pd-disaggregation"])
def test_agentic_configuration_inherits_cluster_vllm_image_when_set(provider_ref):
    from llm_d_lens.deploy.providers.hardware_profile import runtime_image

    request = StandardKubernetesServiceRequest(
        model="Qwen/Qwen3-8B",
        deployment_name="agentic",
        cluster_session_id="a" * 36,
        replicas=1,
        tensor_parallel_size=1,
        storage_volume_id="storage-model-cache",
    )
    candidate = PlannedCandidate(
        id=f"{provider_ref}-tp1-r1",
        provider_ref=provider_ref,
        replicas=1,
        tensor_parallel_size=1,
        prefill_replicas=1,
        prefill_tensor_parallel_size=1,
        guide_variant="vllm",
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=2 if provider_ref == "pd-disaggregation" else 1,
        deployable=True,
    )

    custom_cfg = build_agentic_configuration(
        request,
        candidate,
        accelerator="nvidia",
        cluster_vllm_image="registry.internal:5000/org/vllm:cluster-1",
    )
    assert custom_cfg.content["runtime"]["image"] == "registry.internal:5000/org/vllm:cluster-1"

    default_cfg = build_agentic_configuration(
        request,
        candidate,
        accelerator="nvidia",
        cluster_vllm_image=None,
    )
    assert default_cfg.content["runtime"]["image"] == runtime_image(accelerator="nvidia")


def test_agentic_service_refresh_configuration_plan_uses_cluster_vllm_image(monkeypatch):
    from types import SimpleNamespace

    from llm_d_lens.agentic.configuration import planning_resource_request
    from llm_d_lens.agentic.service import AgenticDeploymentService

    monkeypatch.setattr(
        "llm_d_lens.agentic.service.resolve_cluster_vllm_image",
        lambda cid: "registry.internal:5000/org/vllm:cluster-2" if cid == "cluster-custom" else None,
    )
    candidate = PlannedCandidate(
        id="optimized-baseline-tp1-r1",
        provider_ref="optimized-baseline",
        replicas=1,
        tensor_parallel_size=1,
        max_model_len=4096,
        gpu_memory_utilization=0.9,
        required_gpus=1,
        deployable=True,
    )
    run = SimpleNamespace(
        request=SimpleNamespace(
            model="Qwen/Qwen3-8B",
            deployment_name="agentic",
            description="",
            cluster_session_id="a" * 36,
            replicas=1,
            tensor_parallel_size=1,
            storage_type="model-cache",
            storage_volume_id="storage-model-cache",
            model_cache_path="/cache",
            pvc_name="",
            max_model_len=4096,
            gpu_memory_utilization=0.9,
            max_num_seqs=256,
            max_num_batched_tokens=8192,
            enable_prefix_caching=True,
            enforce_eager=False,
            vllm_arguments=[],
            use_cluster_proxy=False,
            http_proxy="",
            https_proxy="",
            no_proxy="",
            planning_mode="manual",
            requirements=SimpleNamespace(cluster_id="cluster-custom"),
            model_copy=lambda update: StandardKubernetesServiceRequest(
                model="Qwen/Qwen3-8B",
                deployment_name="agentic",
                cluster_session_id="a" * 36,
                replicas=update["replicas"],
                tensor_parallel_size=update["tensor_parallel_size"],
                storage_volume_id="storage-model-cache",
            ),
        ),
        candidates=[candidate],
        selected_candidate=candidate,
        model_secret=ModelSecretConfiguration(),
        planning_cluster_snapshot={"hardware": {"accelerators": [{"id": "nvidia", "gpuCount": 2}]}},
        configuration_plan=None,
    )
    monkeypatch.setattr(
        "llm_d_lens.agentic.service.resolved_plan",
        lambda _run, cfg: SimpleNamespace(
            configuration=cfg,
            requirements=SimpleNamespace(hard_constraints={}, workload={}, forbidden_features=[], required_features=[]),
        ),
    )

    AgenticDeploymentService._refresh_configuration_plan(run)

    assert run.configuration_plan.configuration["content"]["runtime"]["image"] == (
        "registry.internal:5000/org/vllm:cluster-2"
    )
    body = planning_resource_request(run)
    assert body["runtimeImage"] == "registry.internal:5000/org/vllm:cluster-2"

    # Guard optional run.request.requirements=None by falling back to cluster_session_id
    monkeypatch.setattr(
        "llm_d_lens.agentic.service.require_active_session",
        lambda _sid: SimpleNamespace(server_id="cluster-custom"),
    )
    run.request.requirements = None
    AgenticDeploymentService._refresh_configuration_plan(run)
    assert run.configuration_plan.configuration["content"]["runtime"]["image"] == (
        "registry.internal:5000/org/vllm:cluster-2"
    )
