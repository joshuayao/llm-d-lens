"""Bounded Slice capacity estimates over a complete, read-only cluster snapshot."""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from kubernetes.utils.quantity import parse_quantity

from llm_d_lens.configuration.disaggregated_set import resource_requests, workload_pods
from llm_d_lens.hardware.registry import all_profiles
from llm_d_lens.hardware.resolver import deployment_mode
from llm_d_lens.infrastructure.kubernetes import scoped_runner

if TYPE_CHECKING:
    from llm_d_lens.cluster.service import PrometheusNodeInventory

DS_NAME_LABEL = "disaggregatedset.x-k8s.io/name"
HOSTNAME_LABEL = "kubernetes.io/hostname"
WELL_KNOWN_TOPOLOGY_KEYS = frozenset({"topology.kubernetes.io/region", "topology.kubernetes.io/zone", HOSTNAME_LABEL})
SYSTEM_RESOURCES = frozenset({"cpu", "memory", "pods", "ephemeral-storage"})
MAX_COUNTED_SLICES = 16

# Populated lazily to avoid circular imports while allowing unit tests to monkeypatch.
fetch_prometheus_node_inventory: Any = None


class ClusterInventoryAuthError(ValueError):
    """Raised when cluster kubeconfig credentials fail authentication (401)."""


class ClusterInventoryForbiddenError(ValueError):
    """Raised when cluster inventory is 403 Forbidden and no Prometheus fallback is available."""


_BEARER_RE = re.compile(r"(?i)\bbearer\s+\S+")
_SECRET_KV_RE = re.compile(
    r"(?i)\b(token|password|secret|authorization|client-key-data)\s*[:=]\s*(?!Bearer\s+\[REDACTED\])\S+"
)
_KUBECONFIG_FLAG_RE = re.compile(r"--kubeconfig(?:=|\s+)\S+")
_KUBECONFIG_PATH_RE = re.compile(r"(?:/[^\s'\":]+)+\.kubeconfig\b")


def redact_kubectl_error(text: str | None) -> str:
    """Strip credentials, tokens, and kubeconfig file paths from kubectl error output."""
    redacted = str(text or "")
    redacted = _BEARER_RE.sub("Bearer [REDACTED]", redacted)
    redacted = _SECRET_KV_RE.sub(r"\1=[REDACTED]", redacted)
    redacted = _KUBECONFIG_FLAG_RE.sub("--kubeconfig=[REDACTED]", redacted)
    return _KUBECONFIG_PATH_RE.sub("[KUBECONFIG_PATH]", redacted)


def _result_namespace(stdout: str | None, stderr: str | None) -> SimpleNamespace:
    return SimpleNamespace(stdout=stdout or "", stderr=stderr or "")


def is_unauthorized_output(stdout: str | None, stderr: str | None) -> bool:
    """True when command output indicates Kubernetes 401 authentication failure."""
    from llm_d_lens.cluster.service import _is_unauthorized_output

    return _is_unauthorized_output(_result_namespace(stdout, stderr))


def is_forbidden_output(stdout: str | None, stderr: str | None) -> bool:
    """True when command output indicates Kubernetes 403 RBAC denial."""
    from llm_d_lens.cluster.service import _is_forbidden_output

    return _is_forbidden_output(_result_namespace(stdout, stderr))


def is_unauthorized_result(result: Any) -> bool:
    return is_unauthorized_output(getattr(result, "stdout", ""), getattr(result, "stderr", ""))


def is_forbidden_result(result: Any) -> bool:
    return is_forbidden_output(getattr(result, "stdout", ""), getattr(result, "stderr", ""))


def _resolve_cluster_id(cluster_or_session_id: str) -> str:
    from llm_d_lens.cluster.sessions import get_session

    session = get_session(cluster_or_session_id)
    if session is not None and session.server_id:
        return session.server_id
    return cluster_or_session_id


def classify_kubectl_failure(result: Any, *, resource: str) -> str:
    """Classify a failed kubectl result; never masks 401 as 403."""
    if is_unauthorized_result(result):
        raise ClusterInventoryAuthError(f"Cluster kubeconfig is unauthorized (401) while reading {resource}.")
    if is_forbidden_result(result):
        return "forbidden"
    raise ValueError(f"Cluster inventory unavailable for {resource}; verify access and installed APIs")


def _profile_extended_resource_name(profile: Any) -> str | None:
    if profile.deployment.resource_name:
        return str(profile.deployment.resource_name)
    try:
        names = deployment_mode(profile, request_model="extended-resource").get("resource_names") or []
    except ValueError:
        names = []
    if names:
        return str(names[0])
    if profile.resource_prefixes:
        return str(profile.resource_prefixes[0]).rstrip("/")
    return None


def synthetic_inventory_from_prometheus(inv: PrometheusNodeInventory) -> tuple[list[dict], list[dict]]:
    """Build K8s-shaped node and virtual pod dicts from PrometheusNodeInventory."""
    profiles_by_id = {profile.id: profile for profile in all_profiles()}
    nodes: list[dict] = []
    pods: list[dict] = []

    for node_summary in inv.all_nodes:
        node_name = str(node_summary.get("name") or "").strip()
        if not node_name:
            continue
        alloc_info = (inv.allocatable_by_node or {}).get(node_name) or {}
        labels: dict[str, str] = {HOSTNAME_LABEL: node_name}
        allocatable: dict[str, str] = {"pods": "110"}

        cpu = alloc_info.get("cpu") if "cpu" in alloc_info else node_summary.get("cpu")
        if cpu is not None and float(cpu) > 0:
            allocatable["cpu"] = f"{float(cpu):g}"

        memory_bytes = alloc_info.get("memoryBytes") if "memoryBytes" in alloc_info else node_summary.get("memoryBytes")
        if memory_bytes is not None and int(memory_bytes) > 0:
            allocatable["memory"] = f"{int(memory_bytes) // 1024}Ki"

        gpu_by_profile = alloc_info.get("gpuByProfile") or node_summary.get("gpuByProfile") or {}
        gpu_models_by_profile = node_summary.get("gpuModelsByProfile") or {}
        node_resources: list[tuple[str, int]] = []
        for profile_id, count in gpu_by_profile.items():
            profile = profiles_by_id.get(profile_id)
            if profile is None:
                continue
            for key, value in (profile.node_label_selector or {}).items():
                labels[str(key)] = str(value)
            models = gpu_models_by_profile.get(profile_id) or []
            if models and profile.planning.model_label_keys:
                labels[str(profile.planning.model_label_keys[0])] = str(models[0])
            resource_name = _profile_extended_resource_name(profile)
            if resource_name and int(count) > 0:
                allocatable[resource_name] = str(int(count))
                node_resources.append((resource_name, int(count)))

        spec: dict[str, Any] = {"unschedulable": bool(node_summary.get("schedulingDisabled", False))}
        if node_summary.get("role") == "control-plane":
            labels["node-role.kubernetes.io/control-plane"] = ""
            spec["taints"] = [{"key": "node-role.kubernetes.io/control-plane", "effect": "NoSchedule"}]

        ready = bool(node_summary.get("ready", False))
        nodes.append(
            {
                "metadata": {"name": node_name, "labels": labels},
                "spec": spec,
                "status": {
                    "conditions": [{"type": "Ready", "status": "True" if ready else "False"}],
                    "allocatable": allocatable,
                },
            }
        )

        allocated = int((inv.allocated_gpu_by_node or {}).get(node_name) or 0)
        if allocated > 0 and node_resources:
            requests: dict[str, str] = {}
            remaining = allocated
            for index, (resource_name, cap) in enumerate(node_resources):
                take = remaining if index == len(node_resources) - 1 else min(remaining, cap)
                if take > 0:
                    requests[resource_name] = str(take)
                    remaining -= take
            if requests:
                pods.append(
                    {
                        "metadata": {"name": f"prometheus-allocated-{node_name}", "namespace": "default"},
                        "spec": {
                            "nodeName": node_name,
                            "containers": [{"name": "allocated", "resources": {"requests": requests}}],
                        },
                        "status": {"phase": "Running"},
                    }
                )

    return nodes, pods


async def prometheus_inventory_nodes_and_pods(cluster_id: str) -> tuple[list[dict], list[dict]]:
    """Fetch synthetic nodes and pods from Prometheus; raise 403 error if unavailable."""
    fetcher = fetch_prometheus_node_inventory
    if fetcher is None:
        from llm_d_lens.cluster.service import fetch_prometheus_node_inventory as fetcher

    inv = await fetcher(_resolve_cluster_id(cluster_id))
    if not inv.reachable or not inv.all_nodes:
        raise ClusterInventoryForbiddenError(
            "Cluster node inventory is restricted (403) and Prometheus inventory is unavailable."
        )
    return synthetic_inventory_from_prometheus(inv)


def _parse_inventory_items(stdout: str, *, resource: str) -> list[dict]:
    response = json.loads(stdout)
    if not isinstance(response.get("items"), list) or response.get("metadata", {}).get("continue"):
        raise ValueError(f"Cluster inventory incomplete for {resource}")
    return response["items"]


async def fetch_cluster_nodes_and_pods(cluster_id: str) -> tuple[list[dict], list[dict], str]:
    """Fetch nodes and pods via kubectl, falling back to Prometheus on 403 while surfacing 401."""
    runner = scoped_runner(cluster_id)
    nodes_result = await runner.run(["kubectl", "get", "nodes", "-o", "json"], timeout=30)
    if nodes_result.returncode:
        classify_kubectl_failure(nodes_result, resource="nodes")
        nodes, pods = await prometheus_inventory_nodes_and_pods(cluster_id)
        return nodes, pods, "prometheus"
    nodes = _parse_inventory_items(nodes_result.stdout, resource="nodes")

    pods_result = await runner.run(["kubectl", "get", "pods", "--all-namespaces", "-o", "json"], timeout=30)
    if pods_result.returncode:
        classify_kubectl_failure(pods_result, resource="pods")
        nodes, pods = await prometheus_inventory_nodes_and_pods(cluster_id)
        return nodes, pods, "prometheus"
    pods = _parse_inventory_items(pods_result.stdout, resource="pods")
    return nodes, pods, "kubernetes"


async def inventory(cluster_id: str, resource: str) -> list[dict]:
    command = ["kubectl", "get", resource, "-o", "json"]
    if resource != "nodes":
        command.append("--all-namespaces")
    result = await scoped_runner(cluster_id).run(command, timeout=30)
    if result.returncode:
        classify_kubectl_failure(result, resource=resource)
        if resource in {"nodes", "pods"}:
            nodes, pods, _source = await fetch_cluster_nodes_and_pods(cluster_id)
            return nodes if resource == "nodes" else pods
        raise ClusterInventoryForbiddenError(f"Cluster inventory access denied (403) for {resource}")
    return _parse_inventory_items(result.stdout, resource=resource)


def _quantity_map(values: dict) -> dict[str, float]:
    return {name: float(parse_quantity(value)) for name, value in values.items()}


def free_node_capacity(nodes: list[dict], pods: list[dict]) -> tuple[dict, dict]:
    """Free allocatable resources and labels of Ready, schedulable nodes."""
    free, labels = {}, {}
    for node in nodes:
        metadata, spec, status = node.get("metadata") or {}, node.get("spec") or {}, node.get("status") or {}
        ready = any(
            condition.get("type") == "Ready" and condition.get("status") == "True"
            for condition in status.get("conditions") or []
        )
        if spec.get("unschedulable") or not ready or not metadata.get("name"):
            continue
        free[metadata["name"]] = _quantity_map(status.get("allocatable") or {})
        labels[metadata["name"]] = metadata.get("labels") or {}
    for pod in pods:
        node = (pod.get("spec") or {}).get("nodeName")
        if node not in free or (pod.get("status") or {}).get("phase") in {"Succeeded", "Failed"}:
            continue
        for resource, quantity in resource_requests(pod.get("spec") or {}).items():
            free[node][resource] = free[node].get(resource, 0) - quantity
    return free, labels


def fit_slice(capacity: dict, demands: list[dict]) -> dict | None:
    """First-fit-decreasing estimate; not a scheduler simulation or reservation."""
    remaining = {name: dict(values) for name, values in capacity.items()}
    for item in sorted(demands, key=lambda entry: -sum(entry["requests"].values())):
        for values in remaining.values():
            if all(values.get(resource, 0) >= quantity for resource, quantity in item["requests"].items()):
                for resource, quantity in item["requests"].items():
                    values[resource] = values.get(resource, 0) - quantity
                break
        else:
            return None
    return remaining


def _topology_keys(free: dict, labels: dict, demands: list[dict], occupied: set[str]) -> list[dict]:
    resources = {resource for item in demands for resource in item["requests"] if resource != "pods"}
    result = []
    for key in {key for name in free for key in labels[name]}:
        domains: dict[str, list[str]] = {}
        for name in free:
            value = labels[name].get(key)
            if value:
                domains.setdefault(value, []).append(name)
        if len(domains) < 2 and key not in WELL_KNOWN_TOPOLOGY_KEYS:
            continue
        details = []
        for value, members in domains.items():
            available = {
                resource: sum(max(0.0, free[name].get(resource, 0)) for name in members) for resource in resources
            }
            details.append(
                {
                    "value": value,
                    "nodeCount": len(members),
                    "nodes": sorted(members)[:8],
                    "freeResources": available,
                    "fitsSlice": fit_slice({name: free[name] for name in members}, demands) is not None,
                    "occupied": any(name in occupied for name in members),
                }
            )
        feasible = sum(1 for item in details if item["fitsSlice"])
        if not feasible and key not in WELL_KNOWN_TOPOLOGY_KEYS:
            continue
        details.sort(key=lambda item: (not item["fitsSlice"], item["value"]))
        result.append(
            {
                "key": key,
                "wellKnown": key in WELL_KNOWN_TOPOLOGY_KEYS,
                "labeledNodes": sum(len(members) for members in domains.values()),
                "domainCount": len(domains),
                "domains": {value: len(members) for value, members in sorted(domains.items())},
                "domainDetails": details[:32],
                "feasibleDomains": feasible,
                "exclusiveTopologyDomains": sum(1 for item in details if item["fitsSlice"] and not item["occupied"]),
            }
        )
    result.sort(
        key=lambda item: (
            not item["key"].startswith("topology.kubernetes.io/"),
            item["key"] == HOSTNAME_LABEL,
            -item["feasibleDomains"],
            item["key"],
        )
    )
    return result[:12]


def slice_capacity(documents: list[dict[str, Any]], nodes: list[dict], pods: list[dict]) -> dict[str, Any]:
    """Per-placement Slice ceilings from current free resources; an estimate, not a reservation."""
    demands = [item for item in workload_pods(documents) if item["kind"] == "DisaggregatedSet" and item["slice"] == 0]
    per_slice: dict[str, float] = {}
    for item in demands:
        for resource, quantity in item["requests"].items():
            per_slice[resource] = per_slice.get(resource, 0) + quantity
    free, labels = free_node_capacity(nodes, pods)
    occupied = {
        (pod.get("spec") or {}).get("nodeName")
        for pod in pods
        if ((pod.get("metadata") or {}).get("labels") or {}).get(DS_NAME_LABEL)
        and (pod.get("status") or {}).get("phase") not in {"Succeeded", "Failed"}
    }
    count, remaining = 0, free
    while count < MAX_COUNTED_SLICES:
        packed = fit_slice(remaining, demands)
        if packed is None:
            break
        remaining, count = packed, count + 1
    return {
        "podsPerSlice": len(demands),
        "sliceRequests": {resource: value for resource, value in per_slice.items() if resource != "pods"},
        "acceleratorResources": sorted(
            resource
            for resource in per_slice
            if resource not in SYSTEM_RESOURCES and not resource.startswith("hugepages-")
        ),
        "maxSlices": {"None": count},
        "maxSlicesCapped": count >= MAX_COUNTED_SLICES,
        "unmodeled": ["DRA"] if any(item["pod"].get("resourceClaims") for item in demands) else [],
        "schedulableNodes": len(free),
        "topologyKeys": _topology_keys(free, labels, demands, occupied),
    }
