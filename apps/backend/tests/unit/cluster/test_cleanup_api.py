"""Namespace cleanup API: temporary admin kubeconfig and fail-closed behavior."""

from __future__ import annotations

import importlib
import json
import stat
from pathlib import Path

from fastapi.testclient import TestClient

from llm_d_lens.api.main import app
from llm_d_lens.auth.contracts import Principal
from llm_d_lens.auth.records import UserRecord
from llm_d_lens.cluster import registry, service
from llm_d_lens.db.dao.user import UserDao
from llm_d_lens.infrastructure.process import CommandResult

cluster_router = importlib.import_module("llm_d_lens.cluster.router")
kubernetes = importlib.import_module("llm_d_lens.infrastructure.kubernetes")

METADATA_SERVER = "https://169.254.169.254:6443"


def _kubeconfig(server: str = "https://10.0.0.9:6443") -> str:
    return (
        "apiVersion: v1\nkind: Config\nclusters:\n- name: target\n  cluster:\n"
        f'    server: {server}\ncontexts: []\ncurrent-context: ""\nusers: []\n'
    )


def _cluster(*, draft: bool = True, owner_user_id: str | None = None) -> registry.Cluster:
    return registry.create_cluster(
        "cleanup-api-cluster",
        "",
        _kubeconfig(),
        draft=draft,
        owner_user_id=owner_user_id,
    )


def _target_namespaces(cluster: registry.Cluster) -> set[str]:
    return {
        registry.gateway_namespace_for(cluster.id, cluster.gateway_namespace),
        f"llm-d-bench-storage-{cluster.id}",
    }


class _CleanupRunner:
    """Scripted kubectl runner for discovery, listing and deletes."""

    def __init__(
        self,
        *,
        existing: set[str] | None = None,
        blocked: set[str] | None = None,
        items: dict[str, list[dict]] | None = None,
        labels: dict[str, dict[str, str]] | None = None,
        fail_discovery: bool = False,
    ) -> None:
        self.commands: list[list[str]] = []
        self.existing = existing or set()
        self.blocked = blocked or set()
        self.items = items or {}
        self.labels = labels or {}
        self.fail_discovery = fail_discovery

    async def run(self, argv, *, input=None, timeout=None, env=None, **_kwargs):  # noqa: A002
        command = [str(argument) for argument in argv]
        self.commands.append(command)
        if "api-resources" in command:
            if self.fail_discovery:
                return CommandResult(tuple(command), 1, "", "Error from server (Forbidden): forbidden")
            return CommandResult(tuple(command), 0, "configmaps\nsecrets\npods\n", "")
        if command[1] == "get" and command[2] == "namespace":
            namespace = command[3]
            if command[-1] == "name":
                output = f"namespace/{namespace}" if namespace in self.existing else ""
                return CommandResult(tuple(command), 0, output, "")
            labels = self.labels.get(namespace, {})
            return CommandResult(tuple(command), 0, json.dumps({"metadata": {"labels": labels}}), "")
        if command[1] == "get" and "," in command[2]:
            namespace = command[command.index("-n") + 1]
            if namespace in self.blocked:
                return CommandResult(tuple(command), 1, "", "Error from server (Forbidden): forbidden")
            return CommandResult(tuple(command), 0, json.dumps({"items": self.items.get(namespace, [])}), "")
        return CommandResult(tuple(command), 0, "", "")

    def deleted_namespaces(self) -> list[str]:
        return [command[3] for command in self.commands if command[1:3] == ["delete", "namespace"]]


def _install_stored_runner(monkeypatch, runner: _CleanupRunner) -> None:
    monkeypatch.setattr(service, "scoped_runner", lambda _cluster_id: runner)
    monkeypatch.setattr(kubernetes, "scoped_runner", lambda _cluster_id: runner)


def _post_cleanup(client: TestClient, cluster_id: str, *, kubeconfig: str | None = None):
    if kubeconfig is None:
        return client.post(f"/api/cluster/clusters/{cluster_id}/cleanup")
    return client.post(
        f"/api/cluster/clusters/{cluster_id}/cleanup",
        files={"file": ("kubeconfig.yaml", kubeconfig.encode(), "application/yaml")},
    )


def test_cleanup_uses_the_stored_kubeconfig_and_retains_the_record(monkeypatch):
    cluster = _cluster(draft=True)
    runner = _CleanupRunner(existing=_target_namespaces(cluster))
    _install_stored_runner(monkeypatch, runner)

    def no_temporary_runner(_env):
        raise AssertionError("cleanup must not create a temporary runner without an uploaded kubeconfig")

    monkeypatch.setattr(cluster_router, "ScopedCommandRunner", no_temporary_runner)

    with TestClient(app) as client:
        response = _post_cleanup(client, cluster.id)

    assert response.status_code == 204, response.text
    assert registry.get_cluster(cluster.id) is not None
    assert set(runner.deleted_namespaces()) == _target_namespaces(cluster)
    assert any("api-resources" in command for command in runner.commands)


def test_cleanup_uses_a_temporary_admin_kubeconfig_and_removes_it(monkeypatch):
    cluster = _cluster(draft=True)
    runner = _CleanupRunner(existing=_target_namespaces(cluster))
    captured: dict[str, object] = {}

    def factory(env):
        captured["env"] = env
        kubeconfig_path = Path(env["KUBECONFIG"])
        captured["file_mode"] = stat.S_IMODE(kubeconfig_path.stat().st_mode)
        captured["directory_mode"] = stat.S_IMODE(kubeconfig_path.parent.stat().st_mode)
        return runner

    monkeypatch.setattr(cluster_router, "ScopedCommandRunner", factory)

    with TestClient(app) as client:
        response = _post_cleanup(client, cluster.id, kubeconfig=_kubeconfig())

    assert response.status_code == 204, response.text
    env = captured["env"]
    assert isinstance(env, dict)
    temporary = Path(env["KUBECONFIG"])
    assert captured["file_mode"] == 0o600
    assert captured["directory_mode"] == 0o700
    assert not temporary.exists()
    assert not temporary.parent.exists()
    # The temporary credential is used for both discovery/list and deletion.
    assert any("api-resources" in command for command in runner.commands)
    assert runner.deleted_namespaces()
    # It is never persisted as the cluster kubeconfig.
    assert registry.read_kubeconfig(cluster.id) == _kubeconfig()
    assert registry.get_cluster(cluster.id) is not None


def test_unlistable_namespace_fails_closed_and_keeps_every_namespace(monkeypatch):
    cluster = _cluster(draft=True)
    gateway_namespace = registry.gateway_namespace_for(cluster.id, cluster.gateway_namespace)
    runner = _CleanupRunner(existing=_target_namespaces(cluster), blocked={gateway_namespace})
    _install_stored_runner(monkeypatch, runner)

    with TestClient(app) as client:
        response = _post_cleanup(client, cluster.id)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "cleanup_permission_denied"
    assert body["namespace"] == gateway_namespace
    assert runner.deleted_namespaces() == []
    assert registry.get_cluster(cluster.id) is not None


def test_cleanup_rejects_a_blocked_temporary_kubeconfig_before_dialing(monkeypatch):
    cluster = _cluster(draft=True)

    async def must_not_run(*_args, **_kwargs):
        raise AssertionError("blocked kubeconfig must not run cleanup")

    monkeypatch.setattr(service, "cleanup_cluster", must_not_run)

    with TestClient(app) as client:
        response = _post_cleanup(client, cluster.id, kubeconfig=_kubeconfig(METADATA_SERVER))

    assert response.status_code == 400, response.text
    body = response.json()
    assert body["code"] == "kubeconfig_egress_blocked"
    assert body["reason"] == "metadata"


def test_cleanup_allows_the_owner_and_rejects_other_principals(monkeypatch):
    owner = UserDao().create(UserRecord(username="cleanup-owner"))
    cluster = _cluster(draft=True, owner_user_id=owner.id)

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(service, "cleanup_cluster", noop)
    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id=owner.id, username="cleanup-owner"),
    )
    with TestClient(app) as client:
        allowed = _post_cleanup(client, cluster.id)
    assert allowed.status_code == 204, allowed.text

    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id="not-the-owner", username="not-the-owner"),
    )
    with TestClient(app) as client:
        denied = _post_cleanup(client, cluster.id)
    assert denied.status_code == 403, denied.text


def test_delete_returns_409_and_retains_the_record_when_cleanup_cannot_list(monkeypatch):
    cluster = _cluster(draft=False)
    registry.update_cluster(
        cluster.id,
        hf_token_secret_namespace="team-tokens",  # noqa: S106 -- Kubernetes resource name, not a credential.
        hf_token_secret_name="hf-token-1",  # noqa: S106 -- Kubernetes resource name, not a credential.
    )
    runner = _CleanupRunner(existing={"team-tokens"}, blocked={"team-tokens"})
    _install_stored_runner(monkeypatch, runner)
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cluster_id: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cluster_id: False)
    deleted_namespaces: list[str] = []

    async def fake_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        deleted_namespaces.append(namespace)
        return CommandResult((), 0, "", "")

    async def fake_delete_secret(name, *, namespace, cluster_id=None, timeout=None):
        return CommandResult((), 0, "", "")

    monkeypatch.setattr(kubernetes, "delete_namespace", fake_delete_namespace)
    monkeypatch.setattr(kubernetes, "delete_secret", fake_delete_secret)

    with TestClient(app) as client:
        response = client.delete(f"/api/cluster/clusters/{cluster.id}")

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["code"] == "cleanup_permission_denied"
    assert body["namespace"] == "team-tokens"
    assert "team-tokens" not in deleted_namespaces
    assert registry.get_cluster(cluster.id) is not None


def test_cleanup_route_is_registered_for_delete_permission():
    from llm_d_lens.auth import routes

    assert ("POST", "/api/cluster/clusters/{cluster_id}/cleanup") in {
        (entry.method, entry.path) for entry in routes.ROUTE_PERMISSIONS
    }
    entry = next(
        entry
        for entry in routes.ROUTE_PERMISSIONS
        if entry.method == "POST" and entry.path == "/api/cluster/clusters/{cluster_id}/cleanup"
    )
    assert entry.permission == "cluster:cluster:delete"


def test_delete_still_removes_the_record_after_cleanup_already_deleted_the_namespace(monkeypatch):
    """Once an admin cleanup removed the namespace, the stored identity must not
    need discovery again just to remove the retained cluster row."""
    cluster = _cluster(draft=False)
    registry.update_cluster(
        cluster.id,
        hf_token_secret_namespace="team-tokens",  # noqa: S106 -- Kubernetes resource name, not a credential.
        hf_token_secret_name="hf-token-1",  # noqa: S106 -- Kubernetes resource name, not a credential.
    )
    runner = _CleanupRunner(existing=set(), fail_discovery=True)
    _install_stored_runner(monkeypatch, runner)
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cluster_id: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cluster_id: False)

    with TestClient(app) as client:
        response = client.delete(f"/api/cluster/clusters/{cluster.id}")

    assert response.status_code == 204, response.text
    assert registry.get_cluster(cluster.id) is None


def test_delete_api_two_phase_admin_handoff_and_marker_verification(monkeypatch):
    from llm_d_lens.cluster.plan import normalize_plan
    from llm_d_lens.db.dao.cluster import ClusterDao

    cluster = _cluster(draft=False)
    plan = normalize_plan(
        {
            "gateway": {
                "provider": "istio",
                "namespace": f"lens-gateway-{cluster.id}",
                "namespaceMode": "create",
                "name": "lens-inference-gateway",
            },
            "accelerators": [],
            "storage": {"kind": "none"},
            "hfTokenSecret": {
                "tokenSource": "create-secret",
                "secretNamespace": "lens-edit",
                "secretNamespaceMode": "existing",
                "secretName": f"hf-token-{cluster.id}",
            },
            "modelCache": {"enabled": False},
            "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
            "runtime": {"inotifyEnabled": False},
            "handoff": {"namespace": "lens-edit"},
            "monitoring": {"mode": "existing", "prometheusUrl": "http://10.0.0.5:9090"},
        },
        cluster_id=cluster.id,
    )
    ClusterDao().set_provisioning_plan(cluster.id, plan.model_dump(mode="json", by_alias=True))
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cid: False)
    monkeypatch.setattr(registry, "cluster_kubeconfig_namespace", lambda _cid: "lens-edit")

    marker_store: dict[str, dict] = {}

    async def fake_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        return CommandResult((), 1, "", "Error from server (Forbidden): namespaces is forbidden")

    async def fake_delete_secret(name, *, namespace, cluster_id=None, timeout=None):
        return CommandResult((), 0, f"secret/{name} delete succeeded", "")

    class _ApiRunner:
        async def run(self, argv, *, input=None, timeout=None):  # noqa: A002
            cmd = [str(x) for x in argv]
            if cmd[:3] == ["kubectl", "delete", "configmap"]:
                return CommandResult(tuple(cmd), 0, "configmap delete succeeded", "")
            if cmd[:3] == ["kubectl", "get", "namespace"]:
                return CommandResult(tuple(cmd), 1, "", "Forbidden")
            if cmd[:3] == ["kubectl", "get", "configmap"]:
                name = cmd[3]
                if name in marker_store:
                    return CommandResult(tuple(cmd), 0, json.dumps({"data": marker_store[name]}), "")
                return CommandResult(tuple(cmd), 1, "", "NotFound")
            return CommandResult(tuple(cmd), 0, "", "")

    monkeypatch.setattr(kubernetes, "delete_namespace", fake_delete_namespace)
    monkeypatch.setattr(kubernetes, "delete_secret", fake_delete_secret)
    _install_stored_runner(monkeypatch, _ApiRunner())

    with TestClient(app) as client:
        first = client.delete(f"/api/cluster/clusters/{cluster.id}")
        assert first.status_code == 409, first.text
        body = first.json()
        assert body["code"] == "cluster_admin_cleanup_required"
        assert body["title"] == "Orchestration administrator cleanup required"
        assert "Orchestration administrator cleanup is required" in body["detail"]
        assert "Ask an Orchestration administrator" in body["instructions"]
        assert "# Lens Orchestration administrator cluster cleanup script." in body["script"]
        assert body["clusterId"] == cluster.id
        assert [op["id"] for op in body["operations"]] == ["gateway.namespace"]
        assert {op["id"] for op in body["completedOperations"]} == {"hf-secret.secret", "handoff.marker"}
        assert body["marker"]["status"] == "missing"
        assert body["canVerifyMarker"] is True
        assert body["confirmRequired"] is False
        assert registry.get_cluster(cluster.id) is not None

        # Simulate Orchestration administrator executing the cleanup script and writing the marker ConfigMap.
        marker_store[body["marker"]["name"]] = {
            "clusterId": cluster.id,
            "cleanupDigest": body["cleanupDigest"],
            "operations": "gateway.namespace",
            "status": "completed",
            "completedAt": "2026-11-23T00:00:00Z",
        }
        second = client.delete(f"/api/cluster/clusters/{cluster.id}")
        assert second.status_code == 204, second.text
        assert registry.get_cluster(cluster.id) is None


def test_delete_api_confirm_admin_cleanup_query_param_and_authz(monkeypatch):
    owner = UserDao().create(UserRecord(username="delete-owner"))
    cluster = _cluster(draft=False, owner_user_id=owner.id)
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cid: False)

    async def fake_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        return CommandResult((), 1, "", "Forbidden")

    monkeypatch.setattr(kubernetes, "delete_namespace", fake_delete_namespace)
    _install_stored_runner(monkeypatch, _CleanupRunner())

    # Unauthorized principal is rejected with 403 even with confirmAdminCleanup=true
    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id="other-user", username="other-user"),
    )
    with TestClient(app) as client:
        denied = client.delete(f"/api/cluster/clusters/{cluster.id}?confirmAdminCleanup=true")
    assert denied.status_code == 403, denied.text
    assert registry.get_cluster(cluster.id) is not None

    # Owner with deployments present still hits 409 even with confirmAdminCleanup=true
    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id=owner.id, username="delete-owner"),
    )
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: True)
    with TestClient(app) as client:
        blocked = client.delete(f"/api/cluster/clusters/{cluster.id}?confirmAdminCleanup=true")
    assert blocked.status_code == 409, blocked.text
    assert blocked.json()["code"] == "cluster_has_available_deployments"

    # Owner with no deployments/volumes succeeds with 204
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    with TestClient(app) as client:
        allowed = client.delete(f"/api/cluster/clusters/{cluster.id}?confirmAdminCleanup=true")
    assert allowed.status_code == 204, allowed.text
    assert registry.get_cluster(cluster.id) is None


def test_delete_and_cleanup_enforce_per_cluster_delete_role_against_cross_cluster_escalation(monkeypatch):
    from llm_d_lens.auth.contracts import RoleBinding, ScopeType

    other_owner = UserDao().create(UserRecord(username="other-owner"))
    cluster_a = registry.create_cluster("cleanup-api-cluster-a", "", _kubeconfig(), draft=False)
    cluster_b = registry.create_cluster(
        "cleanup-api-cluster-b",
        "",
        _kubeconfig(),
        draft=False,
        owner_user_id=other_owner.id,
    )
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cid: False)

    async def fake_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        return CommandResult((), 0, "", "")

    monkeypatch.setattr(kubernetes, "delete_namespace", fake_delete_namespace)
    _install_stored_runner(monkeypatch, _CleanupRunner())

    # User is maintainer on cluster_a (can delete) and end-user on cluster_b (cannot delete).
    cross_cluster_principal = Principal(
        user_id="mixed-role-user",
        username="mixed-role-user",
        bindings=(
            RoleBinding(role="maintainer", scope_type=ScopeType.CLUSTER, scope_cluster_id=cluster_a.id),
            RoleBinding(role="end-user", scope_type=ScopeType.CLUSTER, scope_cluster_id=cluster_b.id),
        ),
        role_permissions={
            "maintainer": frozenset({"cluster:cluster:delete"}),
            "end-user": frozenset({"cluster:cluster:read"}),
        },
        role_self_scoped={},
        authz_version=0,
    )
    monkeypatch.setattr(cluster_router, "current_principal", lambda _request: cross_cluster_principal)

    with TestClient(app) as client:
        denied_delete = client.delete(f"/api/cluster/clusters/{cluster_b.id}?confirmAdminCleanup=true")
        assert denied_delete.status_code == 403, denied_delete.text
        assert registry.get_cluster(cluster_b.id) is not None

        denied_cleanup = client.post(f"/api/cluster/clusters/{cluster_b.id}/cleanup")
        assert denied_cleanup.status_code == 403, denied_cleanup.text
        assert registry.get_cluster(cluster_b.id) is not None

        allowed_delete = client.delete(f"/api/cluster/clusters/{cluster_a.id}")
        assert allowed_delete.status_code == 204, allowed_delete.text
        assert registry.get_cluster(cluster_a.id) is None


def test_delete_and_cleanup_block_stored_kubeconfig_ssrf_egress_before_dialing(monkeypatch):
    cluster = registry.create_cluster(
        "ssrf-cluster",
        "",
        _kubeconfig(METADATA_SERVER),
        draft=False,
    )
    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cid: False)

    def must_not_dial(*_args, **_kwargs):
        raise AssertionError("blocked stored kubeconfig must not dial kubernetes")

    monkeypatch.setattr(kubernetes, "delete_namespace", must_not_dial)
    monkeypatch.setattr(service, "scoped_runner", must_not_dial)

    with TestClient(app) as client:
        cleanup_res = client.post(f"/api/cluster/clusters/{cluster.id}/cleanup")
        assert cleanup_res.status_code == 400, cleanup_res.text
        assert cleanup_res.json()["code"] == "kubeconfig_egress_blocked"
        assert cleanup_res.json()["reason"] == "metadata"

        delete_res = client.delete(f"/api/cluster/clusters/{cluster.id}")
        assert delete_res.status_code == 400, delete_res.text
        assert delete_res.json()["code"] == "kubeconfig_egress_blocked"
        assert delete_res.json()["reason"] == "metadata"
        assert registry.get_cluster(cluster.id) is not None

        confirmed_res = client.delete(f"/api/cluster/clusters/{cluster.id}?confirmAdminCleanup=true")
        assert confirmed_res.status_code == 204, confirmed_res.text
        assert registry.get_cluster(cluster.id) is None


def test_delete_api_managed_monitoring_two_phase_cleanup_and_existing_isolation(monkeypatch):
    from llm_d_lens.cluster.plan import normalize_plan
    from llm_d_lens.db.dao.cluster import ClusterDao

    monkeypatch.setattr(service, "_has_available_deployments", lambda _cid: False)
    monkeypatch.setattr(service, "_has_storage_volumes", lambda _cid: False)
    monkeypatch.setattr(registry, "cluster_kubeconfig_namespace", lambda _cid: "lens-edit")

    # 1. Existing monitoring mode never triggers monitoring cleanup.
    existing_cluster = _cluster(draft=False)
    existing_plan = normalize_plan(
        {
            "gateway": {
                "provider": "istio",
                "namespace": f"lens-gateway-{existing_cluster.id}",
                "namespaceMode": "create",
                "name": "lens-inference-gateway",
            },
            "accelerators": [],
            "storage": {"kind": "none"},
            "hfTokenSecret": {
                "tokenSource": "existing-secret:hf",
                "secretNamespace": "lens-edit",
                "secretNamespaceMode": "existing",
                "secretName": "hf",
            },
            "modelCache": {"enabled": False},
            "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
            "runtime": {"inotifyEnabled": False},
            "handoff": {"namespace": "lens-edit"},
            "monitoring": {
                "mode": "existing",
                "namespace": "obs-existing",
                "prometheusUrl": "http://10.0.0.5:9090",
            },
        },
        cluster_id=existing_cluster.id,
    )
    ClusterDao().set_provisioning_plan(existing_cluster.id, existing_plan.model_dump(mode="json", by_alias=True))

    deleted_namespaces: list[str] = []

    async def ok_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        deleted_namespaces.append(namespace)
        return CommandResult((), 0, f"namespace/{namespace} deleted", "")

    class _ExistingRunner:
        async def run(self, argv, *, input=None, timeout=None):  # noqa: A002
            return CommandResult(tuple(str(x) for x in argv), 0, "", "")

    monkeypatch.setattr(kubernetes, "delete_namespace", ok_delete_namespace)
    _install_stored_runner(monkeypatch, _ExistingRunner())
    with TestClient(app) as client:
        res_existing = client.delete(f"/api/cluster/clusters/{existing_cluster.id}")
        assert res_existing.status_code == 204, res_existing.text
    assert deleted_namespaces == [f"lens-gateway-{existing_cluster.id}"]

    # 2. Managed monitoring mode -> Step A hits 403 -> returns ordered 409 admin cleanup -> Step B marker -> 204
    managed_cluster = _cluster(draft=False)
    managed_plan = normalize_plan(
        {
            "gateway": {
                "provider": "istio",
                "namespace": f"lens-gateway-{managed_cluster.id}",
                "namespaceMode": "create",
                "name": "lens-inference-gateway",
            },
            "accelerators": [],
            "storage": {"kind": "none"},
            "hfTokenSecret": {
                "tokenSource": "existing-secret:hf",
                "secretNamespace": "lens-edit",
                "secretNamespaceMode": "existing",
                "secretName": "hf",
            },
            "modelCache": {"enabled": False},
            "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
            "runtime": {"inotifyEnabled": False},
            "handoff": {"namespace": "lens-edit"},
            "monitoring": {"mode": "managed", "namespace": "obs-managed"},
        },
        cluster_id=managed_cluster.id,
    )
    ClusterDao().set_provisioning_plan(managed_cluster.id, managed_plan.model_dump(mode="json", by_alias=True))

    marker_store: dict[str, dict] = {}

    async def forbidden_delete_namespace(namespace, *, cluster_id=None, timeout=None):
        return CommandResult((), 1, "", f"Error from server (Forbidden): namespaces {namespace!r} is forbidden")

    class _ManagedRunner:
        async def run(self, argv, *, input=None, timeout=None):  # noqa: A002
            cmd = [str(x) for x in argv]
            if cmd[:3] == ["kubectl", "delete", "configmap"]:
                return CommandResult(tuple(cmd), 0, "configmap delete succeeded", "")
            if cmd[:3] == ["kubectl", "get", "secret"]:
                return CommandResult(tuple(cmd), 1, "", "Forbidden")
            if cmd[:3] == ["kubectl", "delete", "clusterrolebinding"] or cmd[:3] == [
                "kubectl",
                "delete",
                "clusterrole",
            ]:
                return CommandResult(tuple(cmd), 1, "", "Forbidden")
            if cmd[:3] == ["kubectl", "get", "clusterrolebinding"] or cmd[:3] == [
                "kubectl",
                "get",
                "clusterrole",
            ]:
                return CommandResult(tuple(cmd), 1, "", "Forbidden")
            if cmd[:3] == ["kubectl", "get", "namespace"]:
                return CommandResult(tuple(cmd), 1, "", "Forbidden")
            if cmd[:3] == ["kubectl", "get", "configmap"]:
                name = cmd[3]
                if name in marker_store:
                    return CommandResult(tuple(cmd), 0, json.dumps({"data": marker_store[name]}), "")
                return CommandResult(tuple(cmd), 1, "", "NotFound")
            return CommandResult(tuple(cmd), 0, "", "")

    monkeypatch.setattr(kubernetes, "delete_namespace", forbidden_delete_namespace)
    _install_stored_runner(monkeypatch, _ManagedRunner())

    from llm_d_lens.monitoring.cluster_stack.service import monitoring_namespace_hash

    obs_managed_hash = monitoring_namespace_hash("obs-managed")
    assert obs_managed_hash is not None

    with TestClient(app) as client:
        first = client.delete(f"/api/cluster/clusters/{managed_cluster.id}")
        assert first.status_code == 409, first.text
        body = first.json()
        assert body["code"] == "cluster_admin_cleanup_required"
        op_ids = [op["id"] for op in body["operations"]]
        assert op_ids == [
            "monitoring.release.llmd",
            f"monitoring.rbac.binding.{obs_managed_hash}",
            "monitoring.rbac.binding",
            "monitoring.rbac.role",
            "gateway.namespace",
            "monitoring.namespace",
        ]
        assert f"kubectl delete clusterrolebinding llm-d-prism-metrics-reader-{obs_managed_hash}" in body["script"]
        assert "helm uninstall llmd --namespace obs-managed" in body["script"]
        assert body["script"].index("helm uninstall llmd --namespace obs-managed") < body["script"].index(
            "kubectl delete namespace obs-managed"
        )

        marker_store[body["marker"]["name"]] = {
            "clusterId": managed_cluster.id,
            "cleanupDigest": body["cleanupDigest"],
            "operations": ",".join(op_ids),
            "status": "completed",
            "completedAt": "2026-11-23T00:00:00Z",
        }
        second = client.delete(f"/api/cluster/clusters/{managed_cluster.id}")
        assert second.status_code == 204, second.text
        assert registry.get_cluster(managed_cluster.id) is None
