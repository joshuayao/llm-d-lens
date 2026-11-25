from llm_d_lens.deploy.slice_capacity import slice_capacity


def node(name, domain, devices):
    return {
        "metadata": {"name": name, "labels": {"example.com/fabric": domain}},
        "status": {
            "conditions": [{"type": "Ready", "status": "True"}],
            "allocatable": {"example.com/device": devices, "pods": 100},
        },
    }


def document(slices=2):
    return {
        "kind": "DisaggregatedSet",
        "metadata": {"name": "pd"},
        "spec": {
            "slices": slices,
            "placementPolicy": {"type": "ExclusiveSlice", "topology": "example.com/fabric"},
            "roles": [
                {
                    "name": role,
                    "spec": {
                        "replicas": replicas,
                        "leaderWorkerTemplate": {
                            "size": 1,
                            "workerTemplate": {
                                "spec": {"containers": [{"resources": {"requests": {"example.com/device": devices}}}]}
                            },
                        },
                    },
                }
                for role, replicas, devices in [("prefill", 2, 1), ("decode", 1, 4)]
            ],
        },
    }


def test_slice_capacity_reports_per_policy_ceilings_and_occupied_domains():
    nodes = [node("a1", "a", 6), node("b1", "b", 6), node("c1", "c", 3)]
    other = {
        "metadata": {"labels": {"disaggregatedset.x-k8s.io/name": "other"}},
        "spec": {"nodeName": "b1", "containers": []},
        "status": {"phase": "Running"},
    }
    capacity = slice_capacity([document(1)], nodes, [other])
    assert capacity["sliceRequests"] == {"example.com/device": 6}
    assert capacity["podsPerSlice"] == 3
    assert capacity["maxSlices"] == {"None": 2}
    fabric = capacity["topologyKeys"][0]
    assert fabric["key"] == "example.com/fabric" and fabric["wellKnown"] is False
    assert (fabric["feasibleDomains"], fabric["exclusiveTopologyDomains"]) == (2, 1)
    assert capacity["unmodeled"] == []


def test_slice_capacity_flags_dra_claims_as_unmodeled():
    claimed = document(1)
    for role in claimed["spec"]["roles"]:
        role["spec"]["leaderWorkerTemplate"]["workerTemplate"]["spec"] = {
            "containers": [{"resources": {"requests": {"cpu": "1"}}}],
            "resourceClaims": [{"name": "xpu", "resourceClaimTemplateName": "xpu-claim"}],
        }
    capacity = slice_capacity([claimed], [node("a1", "a", 6)], [])
    assert capacity["acceleratorResources"] == []
    assert capacity["unmodeled"] == ["DRA"]


def test_unschedulable_and_finished_pods_do_not_change_free_capacity():
    nodes = [node("a1", "a", 6), {**node("b1", "b", 6), "spec": {"unschedulable": True}}]
    finished = {
        "spec": {"nodeName": "a1", "containers": [{"resources": {"requests": {"example.com/device": 6}}}]},
        "status": {"phase": "Succeeded"},
    }
    capacity = slice_capacity([document(1)], nodes, [finished])
    assert capacity["schedulableNodes"] == 1
    assert capacity["maxSlices"] == {"None": 1}


def test_synthetic_inventory_from_prometheus_is_profile_driven_with_ki_memory():
    from llm_d_lens.cluster.service import PrometheusNodeInventory
    from llm_d_lens.deploy.slice_capacity import free_node_capacity, synthetic_inventory_from_prometheus

    inv = PrometheusNodeInventory(
        reachable=True,
        all_nodes=[
            {
                "name": "gpu-node-1",
                "role": "worker",
                "ready": True,
                "schedulingDisabled": False,
                "cpu": 32,
                "memoryBytes": 128 * 1024 * 1024 * 1024,
                "gpuByProfile": {"nvidia": 4},
                "gpuModelsByProfile": {"nvidia": ["NVIDIA-H100-80GB"]},
            },
            {
                "name": "cp-1",
                "role": "control-plane",
                "ready": True,
                "schedulingDisabled": False,
                "cpu": 8,
                "memoryBytes": 16 * 1024 * 1024 * 1024,
                "gpuByProfile": {},
                "gpuModelsByProfile": {},
            },
        ],
        allocatable_by_node={
            "gpu-node-1": {"cpu": 30, "memoryBytes": 120 * 1024 * 1024 * 1024, "gpuByProfile": {"nvidia": 4}},
            "cp-1": {"cpu": 8, "memoryBytes": 16 * 1024 * 1024 * 1024, "gpuByProfile": {}},
        },
        allocated_gpu_by_node={"gpu-node-1": 2},
    )

    nodes, pods = synthetic_inventory_from_prometheus(inv)
    gpu_node = next(item for item in nodes if item["metadata"]["name"] == "gpu-node-1")
    cp_node = next(item for item in nodes if item["metadata"]["name"] == "cp-1")
    assert gpu_node["status"]["allocatable"]["memory"] == f"{(120 * 1024 * 1024 * 1024) // 1024}Ki"
    assert gpu_node["status"]["allocatable"]["nvidia.com/gpu"] == "4"
    assert gpu_node["metadata"]["labels"]["nvidia.com/gpu.product"] == "NVIDIA-H100-80GB"
    assert cp_node["spec"]["taints"] == [{"key": "node-role.kubernetes.io/control-plane", "effect": "NoSchedule"}]

    free, _labels = free_node_capacity(nodes, pods)
    assert free["gpu-node-1"]["nvidia.com/gpu"] == 2.0


def test_fetch_cluster_nodes_and_pods_falls_back_on_403_and_surfaces_401(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from llm_d_lens.cluster.service import PrometheusNodeInventory
    from llm_d_lens.deploy import slice_capacity as module

    inv = PrometheusNodeInventory(
        reachable=True,
        all_nodes=[
            {
                "name": "worker-1",
                "role": "worker",
                "ready": True,
                "schedulingDisabled": False,
                "cpu": 16,
                "memoryBytes": 64 * 1024 * 1024 * 1024,
                "gpuByProfile": {"nvidia": 2},
                "gpuModelsByProfile": {},
            }
        ],
        allocatable_by_node={
            "worker-1": {"cpu": 16, "memoryBytes": 64 * 1024 * 1024 * 1024, "gpuByProfile": {"nvidia": 2}}
        },
        allocated_gpu_by_node={"worker-1": 1},
    )

    class Runner403:
        async def run(self, cmd, timeout=30):
            return SimpleNamespace(returncode=1, stdout="", stderr="nodes is forbidden: User cannot list resource")

    async def prom(_cluster_id):
        return inv

    monkeypatch.setattr(module, "scoped_runner", lambda _cid: Runner403())
    monkeypatch.setattr(module, "fetch_prometheus_node_inventory", prom)

    nodes, pods, source = asyncio.run(module.fetch_cluster_nodes_and_pods("cluster-1"))
    assert source == "prometheus"
    assert len(nodes) == 1 and len(pods) == 1

    class Runner401:
        async def run(self, cmd, timeout=30):
            return SimpleNamespace(
                returncode=1, stdout="", stderr="error: You must be logged in to the server (Unauthorized)"
            )

    async def fail_if_prom_called(_cluster_id):
        raise AssertionError("Prometheus fallback must not run on 401")

    monkeypatch.setattr(module, "scoped_runner", lambda _cid: Runner401())
    monkeypatch.setattr(module, "fetch_prometheus_node_inventory", fail_if_prom_called)

    import pytest

    with pytest.raises(module.ClusterInventoryAuthError):
        asyncio.run(module.fetch_cluster_nodes_and_pods("cluster-1"))

    async def unreachable_prom(_cluster_id):
        return PrometheusNodeInventory(reachable=False)

    monkeypatch.setattr(module, "scoped_runner", lambda _cid: Runner403())
    monkeypatch.setattr(module, "fetch_prometheus_node_inventory", unreachable_prom)
    with pytest.raises(module.ClusterInventoryForbiddenError):
        asyncio.run(module.fetch_cluster_nodes_and_pods("cluster-1"))


def test_redact_kubectl_error_strips_tokens_secrets_and_kubeconfig_paths():
    from llm_d_lens.deploy.slice_capacity import redact_kubectl_error

    raw = (
        "error: Authorization: Bearer eyJhbGciOi.secret.jwt token=my-secret-tok "
        "password: pw1 secret=s2 client-key-data: LS0tCg== "
        "--kubeconfig=/tmp/admin.kubeconfig open /var/lib/lens/c1.kubeconfig: denied"
    )
    redacted = redact_kubectl_error(raw)
    assert "eyJhbGciOi" not in redacted
    assert "my-secret-tok" not in redacted
    assert "pw1" not in redacted
    assert "s2" not in redacted
    assert "LS0tCg==" not in redacted
    assert "/tmp/admin.kubeconfig" not in redacted
    assert "/var/lib/lens/c1.kubeconfig" not in redacted
    assert "Bearer [REDACTED]" in redacted
    assert "--kubeconfig=[REDACTED]" in redacted
    assert "[KUBECONFIG_PATH]" in redacted
