"""Tests for orphan deployment namespace scan/cleanup."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from llm_d_lens.deploy import orphans


class _Result:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class _Runner:
    def __init__(self, *, namespaces=None, configmaps=None, per_namespace=None, delete=None) -> None:
        self.namespaces = namespaces or _Result(stdout=_namespaces_json())
        self.configmaps = configmaps or _Result(stdout=_configmaps_json())
        self.per_namespace = per_namespace or {}
        self.delete = delete or _Result()
        self.calls: list = []

    async def run(self, argv, *, cwd=None, env=None, input=None, timeout=10):  # noqa: A002
        self.calls.append(argv)
        if argv[:3] == ["kubectl", "get", "namespaces"]:
            return self.namespaces
        if argv[:3] == ["kubectl", "get", "configmaps"]:
            assert argv[-4:] == [
                "-l",
                "lens.llm-d.ai/role=inventory,app.kubernetes.io/managed-by=llm-d-lens",
                "-o",
                "json",
            ]
            result = self.configmaps if "-A" in argv else self.per_namespace[argv[4]]
            if isinstance(result, Exception):
                raise result
            return result
        if argv[:3] == ["kubectl", "delete", "namespace"]:
            return self.delete
        raise AssertionError(f"unexpected command: {argv}")


class _Store:
    def __init__(self, namespaces: list[str]) -> None:
        self._namespaces = namespaces

    def list_executions(self):
        return [SimpleNamespace(namespace=name) for name in self._namespaces]


def _namespaces_json(*names: str) -> str:
    items = [
        {
            "metadata": {"name": name, "creationTimestamp": f"2026-09-0{index + 1}T00:00:00Z"},
            "status": {"phase": "Active"},
        }
        for index, name in enumerate(names)
    ]
    return json.dumps({"items": items})


def _configmaps_json(*namespaces: str) -> str:
    return json.dumps({"items": [{"metadata": {"namespace": name}} for name in namespaces]})


@pytest.mark.asyncio
async def test_scan_returns_only_untracked_prefixed_namespaces(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        namespaces=_Result(
            stdout=_namespaces_json(
                "llmd-",
                "llmd-known",
                "llmd-orphan",
                "other-ns",
            )
        )
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    result = await orphans.scan_orphan_namespaces("cluster-a", store=_Store(["llmd-known"]))

    assert [orphan.name for orphan in result] == ["llmd-orphan"]
    assert result[0].phase == "Active"


@pytest.mark.asyncio
async def test_scan_raises_on_kubectl_failure(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: _Runner(namespaces=_Result(returncode=1, stderr="boom")))
    with pytest.raises(orphans.OrphanCleanupError, match="boom"):
        await orphans.scan_orphan_namespaces("cluster-a", store=_Store([]))


@pytest.mark.asyncio
async def test_clean_refuses_known_and_outside_prefix(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner()
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    cleaned, failed = await orphans.clean_orphan_namespaces(
        "cluster-a", ["llmd-orphan", "llmd-known", "other-ns"], store=_Store(["llmd-known"])
    )

    assert cleaned == ["llmd-orphan"]
    assert {row["name"] for row in failed} == {"llmd-known", "other-ns"}
    assert [argv[:4] for argv in runner.calls if argv[1] == "delete"] == [
        ["kubectl", "delete", "namespace", "llmd-orphan"]
    ]
    assert failed == [
        {"name": "llmd-known", "error": "namespace is still tracked by a Lens deployment"},
        {"name": "other-ns", "error": "namespace is outside the deployment prefix"},
    ]


@pytest.mark.asyncio
async def test_scan_excludes_engine_namespaces(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        namespaces=_Result(stdout=_namespaces_json("llmd-engine", "llmd-orphan")),
        configmaps=_Result(stdout=_configmaps_json("llmd-engine", "other-engine")),
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    result = await orphans.scan_orphan_namespaces("cluster-a", store=_Store([]))

    assert [orphan.name for orphan in result] == ["llmd-orphan"]
    assert len(runner.calls) == 2
    assert runner.calls[1][3] == "-A"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [_Result(returncode=1, stderr="forbidden"), TimeoutError("timed out"), _Result(stdout=None)]
)
async def test_scan_falls_back_to_namespace_queries(monkeypatch, failure):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        namespaces=_Result(stdout=_namespaces_json("llmd-engine", "llmd-orphan")),
        configmaps=failure,
        per_namespace={
            "llmd-engine": _Result(stdout=_configmaps_json("llmd-engine")),
            "llmd-orphan": _Result(stdout=_configmaps_json()),
        },
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    result = await orphans.scan_orphan_namespaces("cluster-a", store=_Store([]))

    assert [orphan.name for orphan in result] == ["llmd-orphan"]
    assert [argv[3:5] for argv in runner.calls[2:]] == [["-n", "llmd-engine"], ["-n", "llmd-orphan"]]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        _Result(returncode=1, stderr="forbidden"),
        OSError("unavailable"),
        _Result(stdout="invalid JSON"),
        _Result(stdout=None),
    ],
)
async def test_scan_raises_when_engine_check_fails(monkeypatch, failure):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        namespaces=_Result(stdout=_namespaces_json("llmd-unknown", "llmd-unqueried")),
        configmaps=_Result(returncode=1, stderr="forbidden"),
        per_namespace={"llmd-unknown": failure},
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    with pytest.raises(orphans.OrphanCleanupError, match="llmd-unknown"):
        await orphans.scan_orphan_namespaces("cluster-a", store=_Store([]))

    assert [argv[3:5] for argv in runner.calls[2:]] == [["-n", "llmd-unknown"]]


@pytest.mark.asyncio
async def test_clean_refuses_engine_namespace(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(configmaps=_Result(stdout=_configmaps_json("llmd-engine")))
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    cleaned, failed = await orphans.clean_orphan_namespaces(
        "cluster-a", ["llmd-engine", "llmd-orphan"], store=_Store([])
    )

    assert cleaned == ["llmd-orphan"]
    assert failed == [{"name": "llmd-engine", "error": "namespace holds a Lens engine instance"}]
    assert [argv[3] for argv in runner.calls if argv[1] == "delete"] == ["llmd-orphan"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [_Result(returncode=1, stderr="forbidden"), FileNotFoundError("kubectl")])
async def test_clean_refuses_namespace_when_engine_check_fails(monkeypatch, failure):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        configmaps=_Result(returncode=1, stderr="forbidden"),
        per_namespace={"llmd-unknown": failure, "llmd-orphan": _Result(stdout=_configmaps_json())},
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    cleaned, failed = await orphans.clean_orphan_namespaces(
        "cluster-a", ["llmd-unknown", "llmd-orphan"], store=_Store([])
    )

    assert cleaned == ["llmd-orphan"]
    assert len(failed) == 1
    assert failed[0]["name"] == "llmd-unknown"
    assert failed[0]["error"].startswith("could not check for Lens engine instances: ")
    assert [argv[3] for argv in runner.calls if argv[1] == "delete"] == ["llmd-orphan"]


@pytest.mark.asyncio
async def test_clean_checks_and_deletes_duplicate_candidate_only_once(monkeypatch):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    runner = _Runner(
        configmaps=_Result(returncode=1, stderr="forbidden"),
        per_namespace={"llmd-orphan": _Result(stdout=_configmaps_json())},
    )
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    cleaned, failed = await orphans.clean_orphan_namespaces(
        "cluster-a", ["llmd-orphan", "llmd-orphan"], store=_Store([])
    )

    assert cleaned == ["llmd-orphan"]
    assert failed == []
    assert [argv[3:5] for argv in runner.calls if "-n" in argv] == [["-n", "llmd-orphan"]]
    assert [argv[3] for argv in runner.calls if argv[1] == "delete"] == ["llmd-orphan"]


@pytest.mark.asyncio
@pytest.mark.parametrize("clean", [False, True])
async def test_no_engine_query_without_candidates(monkeypatch, clean):
    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    names = ["llmd-", "llmd-known", "other-ns"]
    runner = _Runner(namespaces=_Result(stdout=_namespaces_json(*names)))
    monkeypatch.setattr(orphans, "scoped_runner", lambda _cid: runner)

    if clean:
        cleaned, _failed = await orphans.clean_orphan_namespaces("cluster-a", names, store=_Store(["llmd-known"]))
        assert cleaned == []
    else:
        assert await orphans.scan_orphan_namespaces("cluster-a", store=_Store(["llmd-known"])) == []

    assert all(argv[:3] == ["kubectl", "get", "namespaces"] for argv in runner.calls)


@pytest.mark.asyncio
async def test_two_phase_cleanup_refuses_protected_and_non_prefixed_namespaces(monkeypatch):
    from llm_d_lens.cluster import registry as cluster_registry

    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    monkeypatch.setattr(
        cluster_registry,
        "get_cluster",
        lambda _cid: SimpleNamespace(
            hf_token_secret_namespace="custom-hf-ns",  # noqa: S106 - namespace name
            gateway_namespace="custom-gw",
        ),
    )
    for bad_ns in (
        "default",
        "kube-system",
        "lens-edit",
        "llm-d-monitoring",
        "llm-d-bench-storage",
        "custom-hf-ns",
        "custom-gw",
        "other-ns",
        "llmd-",
    ):
        assert not orphans.is_deletable_deployment_namespace(bad_ns, cluster_id="cluster-a")
        with pytest.raises(orphans.OrphanCleanupError, match="protected or non-prefixed"):
            await orphans.cleanup_in_namespace_resources("cluster-a", bad_ns)


@pytest.mark.asyncio
async def test_prepare_and_verify_two_phase_deployment_cleanup(monkeypatch):
    from llm_d_lens.cluster import registry as cluster_registry
    from llm_d_lens.deploy.capabilities import DeploymentClusterAuthError
    from llm_d_lens.infrastructure.process import CommandResult

    monkeypatch.setenv("LLM_D_BENCH_NAMESPACE_PREFIX", "llmd-")
    monkeypatch.setattr(cluster_registry, "cluster_kubeconfig_namespace", lambda _cid: "lens-edit")
    monkeypatch.setattr(
        cluster_registry,
        "get_cluster",
        lambda _cid: SimpleNamespace(
            hf_token_secret_namespace="lens-edit",  # noqa: S106 - namespace name
            gateway_namespace="lens-gateway",
        ),
    )

    class _PhaseRunner:
        def __init__(self, *, ssar_allowed=True, ns_get=None, marker_get=None, pods_get=None, unauthorized=False):
            self.ssar_allowed = ssar_allowed
            self.ns_get = ns_get or CommandResult(("kubectl",), 1, "", "namespaces is forbidden")
            self.marker_get = marker_get or CommandResult(("kubectl",), 0, "", "")
            self.pods_get = pods_get or CommandResult(("kubectl",), 1, "", "pods is forbidden")
            self.unauthorized = unauthorized
            self.deleted_resources: list[str] = []

        async def run(self, argv, *, input=None, timeout=15):  # noqa: A002
            if self.unauthorized:
                return CommandResult(tuple(argv), 1, "", "Unauthorized")
            if argv[:2] == ["kubectl", "delete"]:
                self.deleted_resources.append(argv[2])
                return CommandResult(tuple(argv), 0, "", "")
            if argv[:3] == ["kubectl", "get", "pv"]:
                return CommandResult(tuple(argv), 1, "", "persistentvolumes is forbidden")
            if argv[:4] == ["kubectl", "create", "-o", "json"] and input:
                return CommandResult(tuple(argv), 0, json.dumps({"status": {"allowed": self.ssar_allowed}}), "")
            if argv[:3] == ["kubectl", "get", "namespace"]:
                return self.ns_get
            if argv[:3] == ["kubectl", "get", "configmap"]:
                return self.marker_get
            if argv[:3] == ["kubectl", "get", "pods"]:
                return self.pods_get
            return CommandResult(tuple(argv), 0, "", "")

    phase1_runner = _PhaseRunner(ssar_allowed=True)
    handoff = await orphans.prepare_deployment_cleanup_handoff(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        runner=phase1_runner,
    )
    assert handoff["phase1Completed"] is True
    assert "deployments.apps" in handoff["deletedInNamespace"]
    admin = handoff["adminCleanup"]
    assert admin["canVerifyMarker"] is True
    assert admin["confirmRequired"] is False
    assert admin["marker"]["namespace"] == "lens-edit"
    assert "llm-d-prism-epp-auth-delegator-llmd-qwen-1" in admin["script"]
    assert "kubectl delete namespace llmd-qwen-1 --ignore-not-found=true" in admin["script"]

    # When SSAR denies configmaps get in lens-edit, canVerifyMarker must be False
    no_ssar_runner = _PhaseRunner(ssar_allowed=False)
    handoff_no_marker = await orphans.prepare_deployment_cleanup_handoff(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        runner=no_ssar_runner,
    )
    assert handoff_no_marker["adminCleanup"]["canVerifyMarker"] is False
    assert handoff_no_marker["adminCleanup"]["confirmRequired"] is True

    # Phase 2 verification via marker ConfigMap + pods gone
    marker_name = orphans.deployment_cleanup_marker_name("exec-1", "llmd-qwen-1")
    marker_doc = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": marker_name, "namespace": "lens-edit"},
        "data": {
            "status": "completed",
            "namespace": "llmd-qwen-1",
            "cleanupDigest": admin["cleanupDigest"],
        },
    }
    verify_runner = _PhaseRunner(
        ssar_allowed=True,
        ns_get=CommandResult(("kubectl",), 1, "", "namespaces is forbidden"),
        marker_get=CommandResult(("kubectl",), 0, json.dumps(marker_doc), ""),
        pods_get=CommandResult(("kubectl",), 1, "", "pods is forbidden"),
    )
    verified = await orphans.verify_deployment_cleanup(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        cleanup_digest=admin["cleanupDigest"],
        runner=verify_runner,
    )
    assert verified["verified"] is True

    # 401 never masked
    with pytest.raises(DeploymentClusterAuthError):
        await orphans.verify_deployment_cleanup(
            execution_id="exec-1",
            cluster_id="cluster-a",
            namespace="llmd-qwen-1",
            runner=_PhaseRunner(unauthorized=True),
        )


@pytest.mark.asyncio
async def test_cleanup_security_hardening_and_marker_validation(monkeypatch):
    from llm_d_lens.cluster import registry as cluster_registry
    from llm_d_lens.deploy import capabilities as caps
    from llm_d_lens.deploy import orphans
    from llm_d_lens.infrastructure.process import CommandResult

    # CRDs deleted before pods
    assert orphans._IN_NAMESPACE_RESOURCE_TYPES.index("leaderworkersets.leaderworkerset.x-k8s.io") < (
        orphans._IN_NAMESPACE_RESOURCE_TYPES.index("pods")
    )
    assert orphans._IN_NAMESPACE_RESOURCE_TYPES.index("disaggregatedsets.disaggregatedset.x-k8s.io") < (
        orphans._IN_NAMESPACE_RESOURCE_TYPES.index("pods")
    )

    # Newline injection & secret leak checks in cleanup script renderer
    with pytest.raises(orphans.OrphanCleanupError):
        orphans.render_deployment_cleanup_script(
            execution_id="exec-1\nrm -rf /",
            cluster_id="cluster-a",
            namespace="llmd-qwen-1",
            operations=[],
        )
    with pytest.raises(orphans.OrphanCleanupError):
        orphans.render_deployment_cleanup_script(
            execution_id="exec-1",
            cluster_id="cluster-a",
            namespace="llmd-qwen-1",
            operations=[{"kind": "namespace", "name": "llmd-qwen-1", "title": "bad\ntitle"}],
        )
    with pytest.raises(caps.DeploymentCapabilityValidationError):
        orphans.render_deployment_cleanup_script(
            execution_id="exec-1",
            cluster_id="cluster-a",
            namespace="llmd-qwen-1",
            operations=[{"kind": "namespace", "name": "llmd-qwen-1", "title": "Delete HF_TOKEN secret"}],
        )
    script_payload = orphans.render_deployment_cleanup_script(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        operations=[],
        marker_namespace="lens-edit",
    )
    assert "set -f\n" in script_payload["script"]

    # Protected kubeconfig namespace is blocked from clean_orphan_namespaces
    monkeypatch.setattr(cluster_registry, "get_cluster", lambda _cid: None)
    monkeypatch.setattr(cluster_registry, "cluster_kubeconfig_namespace", lambda _cid: "llmd-kubeconfig-protected")
    monkeypatch.setattr(
        orphans,
        "scoped_runner",
        lambda _cid: SimpleNamespace(run=lambda *_a, **_kw: CommandResult(("kubectl",), 0, '{"items":[]}', "")),
    )
    assert "llmd-kubeconfig-protected" in orphans.protected_deployment_namespaces("cluster-a")
    cleaned, failed = await orphans.clean_orphan_namespaces(
        "cluster-a",
        ["outside-ns", "llmd-kubeconfig-protected"],
        store=type("S", (), {"list_executions": lambda self: []})(),
    )
    assert cleaned == []
    assert failed == [
        {"name": "outside-ns", "error": "namespace is outside the deployment prefix"},
        {"name": "llmd-kubeconfig-protected", "error": "namespace is protected"},
    ]

    # Stale executionId / clusterId & malformed pods JSON never verify
    marker_name = orphans.deployment_cleanup_marker_name("exec-1", "llmd-qwen-1")
    stale_marker_doc = {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": marker_name, "namespace": "lens-edit"},
        "data": {
            "status": "completed",
            "namespace": "llmd-qwen-1",
            "executionId": "exec-other",
            "clusterId": "cluster-a",
            "cleanupDigest": script_payload["cleanupDigest"],
        },
    }

    class _VerifyRunner:
        def __init__(self, marker_doc, pods_stdout):
            self.marker_doc = marker_doc
            self.pods_stdout = pods_stdout

        async def run(self, argv, *, input=None, timeout=15):  # noqa: A002
            if argv[:4] == ["kubectl", "create", "-o", "json"]:
                return CommandResult(tuple(argv), 0, json.dumps({"status": {"allowed": True}}), "")
            if argv[:3] == ["kubectl", "get", "namespace"]:
                return CommandResult(tuple(argv), 1, "", "namespaces is forbidden")
            if argv[:3] == ["kubectl", "get", "configmap"]:
                return CommandResult(tuple(argv), 0, json.dumps(self.marker_doc), "")
            if argv[:3] == ["kubectl", "get", "pods"]:
                return CommandResult(tuple(argv), 0, self.pods_stdout, "")
            return CommandResult(tuple(argv), 0, "", "")

    stale_res = await orphans.verify_deployment_cleanup(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        cleanup_digest=script_payload["cleanupDigest"],
        runner=_VerifyRunner(stale_marker_doc, '{"items":[]}'),
    )
    assert stale_res["verified"] is False
    assert stale_res["marker"]["status"] == "stale"

    valid_marker_doc = {**stale_marker_doc, "data": {**stale_marker_doc["data"], "executionId": "exec-1"}}
    bad_pods_res = await orphans.verify_deployment_cleanup(
        execution_id="exec-1",
        cluster_id="cluster-a",
        namespace="llmd-qwen-1",
        cleanup_digest=script_payload["cleanupDigest"],
        runner=_VerifyRunner(valid_marker_doc, '{"items": null}'),
    )
    assert bad_pods_res["verified"] is False
