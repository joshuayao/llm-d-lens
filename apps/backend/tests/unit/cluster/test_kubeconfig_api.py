"""Kubeconfig replacement, import egress and version egress behavior."""

from __future__ import annotations

import base64
import importlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from llm_d_lens.api.main import app
from llm_d_lens.auth.contracts import Principal
from llm_d_lens.auth.records import UserRecord
from llm_d_lens.cluster import registry, service, sessions
from llm_d_lens.cluster.errors import ClusterOverviewError
from llm_d_lens.db.dao.user import UserDao
from llm_d_lens.infrastructure.process import CommandResult

cluster_router = importlib.import_module("llm_d_lens.cluster.router")

METADATA_SERVER = "https://169.254.169.254:6443"


def _kubeconfig(server: str, *, ca_data: str | None = None) -> str:
    lines = [
        "apiVersion: v1",
        "kind: Config",
        "clusters:",
        "- name: target",
        "  cluster:",
        f"    server: {server}",
    ]
    if ca_data is not None:
        lines.append(f"    certificate-authority-data: {ca_data}")
    lines += ["contexts: []", 'current-context: ""', "users: []"]
    return "\n".join(lines) + "\n"


def _plan_data() -> dict:
    return {
        "gateway": {"provider": "gke", "namespace": "lens-gateway", "name": "lens-gateway"},
        "accelerators": [],
        "storage": {"kind": "none"},
        "hfTokenSecret": {"tokenSource": "create-secret", "secretNamespace": "lens-gateway"},
        "modelCache": {"enabled": False},
        "stack": {"lwsEnabled": False, "crdsEnabled": False, "imagePrepullEnabled": False},
        "runtime": {"inotifyEnabled": False},
        "spec": {"replicas": 1},
    }


def _cluster(
    *,
    server: str = "https://10.0.0.9:6443",
    draft: bool = True,
    ca_data: str | None = None,
    owner_user_id: str | None = None,
) -> registry.Cluster:
    return registry.create_cluster(
        "kubeconfig-api-cluster",
        "",
        _kubeconfig(server, ca_data=ca_data),
        draft=draft,
        owner_user_id=owner_user_id,
    )


class _FakeRunner:
    """Answer the replacement probes from the KUBECONFIG file content."""

    def __init__(self, uid_by_host: dict[str, str | None], env: dict[str, str]) -> None:
        self._uid_by_host = uid_by_host
        self._env = env

    async def run(self, argv, *, input=None, timeout=None, env=None, **_kwargs):  # noqa: A002
        text = Path(self._env["KUBECONFIG"]).read_text()
        host = next(
            (line.split("server:", 1)[1].strip() for line in text.splitlines() if "server:" in line),
            "",
        )
        host = host.removeprefix("https://").split(":", 1)[0]
        if "version" in argv:
            return CommandResult(tuple(argv), 0, '{"serverVersion": {"major": "1", "minor": "30"}}', "")
        if "--raw=/readyz" in argv:
            return CommandResult(tuple(argv), 0, "ok", "")
        uid = self._uid_by_host.get(host)
        if uid is None:
            return CommandResult(tuple(argv), 1, "", "Error from server (Forbidden): forbidden")
        return CommandResult(tuple(argv), 0, uid, "")


def _install_fake_runner(monkeypatch, uid_by_host: dict[str, str | None]) -> None:
    def factory(env):
        return _FakeRunner(uid_by_host, env)

    monkeypatch.setattr(cluster_router, "ScopedCommandRunner", factory)


def _put(client: TestClient, cluster_id: str, text: str, *, confirm: bool = False):
    data = {"confirm": "true"} if confirm else {}
    return client.put(
        f"/api/cluster/clusters/{cluster_id}/kubeconfig",
        files={"file": ("kubeconfig.yaml", text.encode(), "application/yaml")},
        data=data,
    )


def test_draft_replacement_succeeds_and_reports_an_endpoint_change(monkeypatch):
    cluster = _cluster(draft=True)
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})
    candidate = _kubeconfig("https://10.0.0.1:6443")

    with TestClient(app) as client:
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["targetMatchedBy"] == "uid"
    assert body["endpointChanged"] is True
    assert body["warning"]
    assert body["planHash"] is None
    assert "report" not in body
    assert registry.read_kubeconfig(cluster.id) == candidate


def test_active_replacement_requires_confirm(monkeypatch):
    cluster = _cluster(draft=False)
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})
    candidate = _kubeconfig("https://10.0.0.1:6443")

    with TestClient(app) as client:
        refused = _put(client, cluster.id, candidate)
        assert refused.status_code == 409, refused.text
        assert refused.json()["code"] == "kubeconfig_confirmation_required"
        assert registry.read_kubeconfig(cluster.id) != candidate

        accepted = _put(client, cluster.id, candidate, confirm=True)

    assert accepted.status_code == 200, accepted.text
    assert registry.read_kubeconfig(cluster.id) == candidate


def test_target_mismatch_is_rejected(monkeypatch):
    cluster = _cluster()
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-b", "10.0.0.9": "uid-a"})
    candidate = _kubeconfig("https://10.0.0.1:6443")

    with TestClient(app) as client:
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "kubeconfig_target_mismatch"
    assert registry.read_kubeconfig(cluster.id) != candidate


def test_ca_fingerprint_is_the_fallback_when_uid_is_unreadable(monkeypatch):
    cluster = _cluster(ca_data="Y2EtYQ==")
    _install_fake_runner(monkeypatch, {"10.0.0.9": None, "10.0.0.1": None})
    candidate = _kubeconfig("https://10.0.0.9:6443", ca_data="Y2EtYg==")

    with TestClient(app) as client:
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "kubeconfig_target_mismatch"


def test_ca_fingerprint_match_allows_the_same_endpoint(monkeypatch):
    cluster = _cluster(ca_data="Y2EtYQ==")
    _install_fake_runner(monkeypatch, {"10.0.0.9": None, "10.0.0.1": None})
    candidate = _kubeconfig("https://10.0.0.9:6443", ca_data="Y2EtYQ==")

    with TestClient(app) as client:
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["targetMatchedBy"] == "server_ca"
    assert body["endpointChanged"] is False


def test_egress_blocked_candidate_is_rejected_before_dialing():
    cluster = _cluster()
    candidate = _kubeconfig(METADATA_SERVER)

    with TestClient(app) as client:
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 400, response.text
    body = response.json()
    assert body["code"] == "kubeconfig_egress_blocked"
    assert body["reason"] == "metadata"
    assert registry.read_kubeconfig(cluster.id) != candidate


def test_rotation_does_not_run_a_capability_check_or_fail_on_plan_permissions(monkeypatch):
    cluster = _cluster()
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("rotation must not run a capability check")

    monkeypatch.setattr(cluster_router, "evaluate_capabilities", forbidden, raising=False)
    candidate = _kubeconfig("https://10.0.0.1:6443")

    with TestClient(app) as client:
        stored = client.put(f"/api/cluster/clusters/{cluster.id}/plan", json=_plan_data())
        assert stored.status_code == 200, stored.text
        response = _put(client, cluster.id, candidate)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["planHash"] == stored.json()["planHash"]
    assert "report" not in body
    assert "sufficient" not in body
    assert registry.read_kubeconfig(cluster.id) == candidate


def test_successful_rotation_does_not_change_the_plan_or_return_a_report(monkeypatch):
    cluster = _cluster()
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})

    with TestClient(app) as client:
        stored = client.put(f"/api/cluster/clusters/{cluster.id}/plan", json=_plan_data())
        state = stored.json()
        candidate = _kubeconfig("https://10.0.0.1:6443")
        response = _put(client, cluster.id, candidate)

        unchanged = client.get(f"/api/cluster/clusters/{cluster.id}/plan")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["planHash"] == state["planHash"]
    assert "report" not in body
    assert "sufficient" not in body
    assert unchanged.status_code == 200, unchanged.text
    assert unchanged.json()["planHash"] == state["planHash"]
    assert registry.read_kubeconfig(cluster.id) == candidate


def test_success_closes_sessions_and_clears_the_capability_cache(monkeypatch, tmp_path):
    cluster = _cluster()
    old = registry.read_kubeconfig(cluster.id) or ""
    stale_session = tmp_path / "01234567-0000-0000-0000-000000000000.yaml"
    stale_session.write_text(old)
    unrelated = tmp_path / "01234567-1111-1111-1111-111111111111.yaml"
    unrelated.write_text("another kubeconfig")
    monkeypatch.setattr(sessions, "_SESSION_DIRECTORY", tmp_path)
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})
    cleared: list[bool] = []
    closed: list[str] = []

    monkeypatch.setattr(cluster_router, "clear_capability_cache", lambda: cleared.append(True))
    original_close = sessions.close_session_for_server

    def record_close(server_id: str) -> None:
        closed.append(server_id)
        original_close(server_id)

    monkeypatch.setattr(sessions, "close_session_for_server", record_close)

    with TestClient(app) as client:
        response = _put(client, cluster.id, _kubeconfig("https://10.0.0.1:6443"))

    assert response.status_code == 200, response.text
    assert not stale_session.exists()
    assert unrelated.exists()
    assert cleared == [True]
    assert closed == [cluster.id]


def test_owner_access_is_allowed_and_other_principals_are_rejected(monkeypatch):
    owner = UserDao().create(UserRecord(username="kubeconfig-owner"))
    cluster = _cluster(owner_user_id=owner.id)
    _install_fake_runner(monkeypatch, {"10.0.0.1": "uid-a", "10.0.0.9": "uid-a"})
    candidate = _kubeconfig("https://10.0.0.1:6443")

    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id=owner.id, username="kubeconfig-owner"),
    )
    with TestClient(app) as client:
        allowed = _put(client, cluster.id, candidate)
    assert allowed.status_code == 200, allowed.text

    monkeypatch.setattr(
        cluster_router,
        "current_principal",
        lambda _request: Principal(user_id="not-the-owner", username="not-the-owner"),
    )
    with TestClient(app) as client:
        denied = _put(client, cluster.id, candidate)
    assert denied.status_code == 403, denied.text


def test_permission_check_maps_a_blocked_egress_target_to_400():
    cluster = _cluster(server=METADATA_SERVER)

    with TestClient(app) as client:
        stored = client.put(f"/api/cluster/clusters/{cluster.id}/plan", json=_plan_data())
        assert stored.status_code == 200, stored.text
        response = client.post(f"/api/cluster/clusters/{cluster.id}/permission-check")

    assert response.status_code == 400, response.text
    body = response.json()
    assert body["code"] == "kubeconfig_egress_blocked"
    assert body["reason"] == "metadata"


def test_kubernetes_version_reports_a_blocked_egress_reason():
    cluster = _cluster(server=METADATA_SERVER)

    with TestClient(app) as client:
        response = client.get(f"/api/cluster/clusters/{cluster.id}/kubernetes-version")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reachable"] is False
    assert body["reason"] == "egress_blocked"
    assert body["egress_reason"] == "metadata"
    assert body["message"]


class _VersionProbe:
    """Fake ``kubectl version`` runner that fails with a chosen classification."""

    def __init__(self, *, returncode: int = 0, stderr: str = "", error: Exception | None = None) -> None:
        self._returncode = returncode
        self._stderr = stderr
        self._error = error

    async def run(self, argv, **_kwargs):
        if self._error is not None:
            raise self._error
        stdout = '{"serverVersion": {"major": "1", "minor": "30"}}' if self._returncode == 0 else ""
        return CommandResult(tuple(argv), self._returncode, stdout, self._stderr)


def _probe_version(monkeypatch, probe: _VersionProbe) -> None:
    version_module = importlib.import_module("llm_d_lens.hardware.version")
    monkeypatch.setattr(version_module.k8s, "scoped_runner", lambda _cluster_id: probe)


@pytest.mark.parametrize(
    ("probe", "expected_reason"),
    [
        (_VersionProbe(returncode=1, stderr="Error from server (Unauthorized): Unauthorized"), "unauthorized"),
        (_VersionProbe(returncode=1, stderr="Error from server (Forbidden): forbidden"), "forbidden"),
        (_VersionProbe(error=TimeoutError("timed out")), "timeout"),
        (_VersionProbe(returncode=1, stderr="dial tcp 10.0.0.9:6443: connect: connection refused"), "unreachable"),
        (_VersionProbe(error=FileNotFoundError("kubectl not found")), "unreachable"),
    ],
)
def test_kubernetes_version_classifies_failures(monkeypatch, probe, expected_reason):
    cluster = _cluster()
    _probe_version(monkeypatch, probe)

    with TestClient(app) as client:
        response = client.get(f"/api/cluster/clusters/{cluster.id}/kubernetes-version")

    assert response.status_code == 200, response.text
    body = response.json()
    # ``forbidden`` reached the API with an authenticated identity, so the
    # wizard treats it as a warning rather than a hard block.
    assert body["reachable"] is (expected_reason == "forbidden")
    assert body["reason"] == expected_reason
    assert body["message"]
    assert body["version"] is None
    assert body["supported"] is None


def test_kubernetes_version_reports_ok(monkeypatch):
    cluster = _cluster()
    _probe_version(monkeypatch, _VersionProbe())

    with TestClient(app) as client:
        response = client.get(f"/api/cluster/clusters/{cluster.id}/kubernetes-version")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["reachable"] is True
    assert body["reason"] == "ok"
    assert body["version"] == "1.30"
    assert "supported" in body
    assert body["message"] is None


def test_create_cluster_rejects_a_blocked_import_before_storing():
    with pytest.raises(ClusterOverviewError) as excinfo:
        service.create_cluster("blocked-import", "", _kubeconfig(METADATA_SERVER))

    assert excinfo.value.status_code == 400
    assert excinfo.value.code == "kubeconfig_egress_blocked"
    assert excinfo.value.extra["reason"] == "metadata"
    assert registry.list_clusters(include_drafts=True) == []


def _fake_jwt(claims: dict) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').decode("ascii").rstrip("=")
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode("utf-8")).decode("ascii").rstrip("=")
    return f"{header}.{payload}.sig"


def _sa_kubeconfig(
    *,
    token: str | None = None,
    token_file: str | None = None,
    context_namespace: str | None = None,
    current_context: str = "edit-ctx",
    extra_context: bool = False,
) -> str:
    ctx_lines = [
        "contexts:",
        "- name: edit-ctx",
        "  context:",
        "    cluster: target",
        "    user: edit-sa",
    ]
    if context_namespace is not None:
        ctx_lines.append(f"    namespace: {context_namespace}")
    if extra_context:
        ctx_lines.extend(
            [
                "- name: other-ctx",
                "  context:",
                "    cluster: target",
                "    user: other-sa",
                "    namespace: other-ns",
            ]
        )
    user_lines = ["users:", "- name: edit-sa", "  user:"]
    if token is not None:
        user_lines.append(f"    token: {token}")
    if token_file is not None:
        user_lines.append(f"    tokenFile: {token_file}")
    if token is None and token_file is None:
        user_lines[-1] = "  user: {}"
    lines = [
        "apiVersion: v1",
        "kind: Config",
        "clusters:",
        "- name: target",
        "  cluster:",
        "    server: https://10.0.0.9:6443",
        *ctx_lines,
        f'current-context: "{current_context}"',
        *user_lines,
    ]
    return "\n".join(lines) + "\n"


def test_kubeconfig_namespace_hint_resolves_context_and_jwt_claims_safely(tmp_path):
    # Priority 1: active context.namespace wins over JWT claim.
    both = _sa_kubeconfig(
        context_namespace="ctx-ns",
        token=_fake_jwt({"kubernetes.io/serviceaccount/namespace": "jwt-ns"}),
    )
    assert registry.kubeconfig_namespace_hint(both) == "ctx-ns"

    # Priority 2a: legacy SA claim.
    legacy = _sa_kubeconfig(token=_fake_jwt({"kubernetes.io/serviceaccount/namespace": "lens-legacy"}))
    assert registry.kubeconfig_namespace_hint(legacy) == "lens-legacy"

    # Priority 2b: projected TokenRequest claim.
    projected = _sa_kubeconfig(token=_fake_jwt({"kubernetes.io": {"namespace": "lens-projected"}}))
    assert registry.kubeconfig_namespace_hint(projected) == "lens-projected"

    # Priority 2c: sub fallback.
    sub_only = _sa_kubeconfig(token=_fake_jwt({"sub": "system:serviceaccount:lens-edit:lens-edit"}))
    assert registry.kubeconfig_namespace_hint(sub_only) == "lens-edit"

    # Single context with empty current-context uses contexts[0]; ambiguous multi-context returns None.
    single_no_current = _sa_kubeconfig(
        token=_fake_jwt({"sub": "system:serviceaccount:lens-single:sa"}),
        current_context="",
    )
    assert registry.kubeconfig_namespace_hint(single_no_current) == "lens-single"
    ambiguous = _sa_kubeconfig(
        token=_fake_jwt({"sub": "system:serviceaccount:lens-single:sa"}),
        current_context="",
        extra_context=True,
    )
    assert registry.kubeconfig_namespace_hint(ambiguous) is None

    # Unknown current-context never falls back to another context.
    missing_ctx = _sa_kubeconfig(
        token=_fake_jwt({"sub": "system:serviceaccount:lens-edit:sa"}),
        current_context="unknown-ctx",
        extra_context=True,
    )
    assert registry.kubeconfig_namespace_hint(missing_ctx) is None

    # Never reads local tokenFile paths and rejects invalid DNS-1123 labels or oversized inputs.
    secret_file = tmp_path / "token"
    secret_file.write_text(_fake_jwt({"kubernetes.io/serviceaccount/namespace": "from-disk"}))
    assert registry.kubeconfig_namespace_hint(_sa_kubeconfig(token_file=str(secret_file))) is None
    assert (
        registry.kubeconfig_namespace_hint(
            _sa_kubeconfig(context_namespace="INVALID_NS", token=_fake_jwt({"sub": "system:serviceaccount:../bad:sa"}))
        )
        is None
    )
    assert registry.kubeconfig_namespace_hint("a" * 1_048_577) is None
    assert registry.kubeconfig_namespace_hint(_sa_kubeconfig(token="x." + ("a" * 16_385) + ".y")) is None


def test_single_cluster_and_version_endpoints_expose_kubeconfig_namespace_hint(monkeypatch):
    _probe_version(monkeypatch, _VersionProbe(returncode=1, stderr="Error from server (Forbidden): forbidden"))
    kubeconfig_text = _sa_kubeconfig(token=_fake_jwt({"sub": "system:serviceaccount:lens-edit:lens-edit"}))

    with TestClient(app) as client:
        created = client.post(
            "/api/cluster/clusters",
            files={"file": ("kubeconfig.yaml", kubeconfig_text.encode("utf-8"), "application/yaml")},
            data={"name": "sa-hint-cluster", "draft": "true"},
        )
        assert created.status_code == 201, created.text
        cluster_id = created.json()["cluster"]["id"]
        assert created.json()["cluster"]["kubeconfigNamespace"] == "lens-edit"

        detail = client.get(f"/api/cluster/clusters/{cluster_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["cluster"]["kubeconfigNamespace"] == "lens-edit"

        patched = client.patch(
            f"/api/cluster/clusters/{cluster_id}",
            json={"description": "updated"},
        )
        assert patched.status_code == 200, patched.text
        assert patched.json()["cluster"]["kubeconfigNamespace"] == "lens-edit"

        version = client.get(f"/api/cluster/clusters/{cluster_id}/kubernetes-version")
        assert version.status_code == 200, version.text
        assert version.json()["kubeconfig_namespace"] == "lens-edit"

        listed = client.get("/api/cluster/clusters?includeDrafts=true")
        assert listed.status_code == 200, listed.text
        matched = next(item for item in listed.json()["items"] if item["id"] == cluster_id)
        assert matched["kubeconfigNamespace"] == "lens-edit"


def test_kubeconfig_namespace_hint_inspects_sa_jwt_when_context_namespace_is_default(tmp_path):
    sa_jwt = _fake_jwt({"sub": "system:serviceaccount:lens-edit:lens-edit"})
    assert registry.kubeconfig_namespace_hint(_sa_kubeconfig(context_namespace="default", token=sa_jwt)) == "lens-edit"

    secret_file = tmp_path / "token"
    secret_file.write_text(sa_jwt)
    missing_user = _sa_kubeconfig(context_namespace="default", token=sa_jwt).replace(
        "- name: edit-sa", "- name: other-user"
    )
    for kubeconfig_text in (
        _sa_kubeconfig(context_namespace="default"),
        _sa_kubeconfig(context_namespace="default", token=_fake_jwt({"sub": "user@example.com"})),
        missing_user,
        _sa_kubeconfig(context_namespace="default", token_file=str(secret_file)),
    ):
        assert registry.kubeconfig_namespace_hint(kubeconfig_text) == "default"
