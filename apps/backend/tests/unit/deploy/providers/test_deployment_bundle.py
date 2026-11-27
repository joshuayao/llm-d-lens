"""Behavioral tests for immutable Guide deployment bundles."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import yaml

from llm_d_lens.deploy import capabilities
from llm_d_lens.deploy.providers import deployment_bundle
from llm_d_lens.deploy.providers.deployment_bundle import (
    HelmPostRenderer,
    _helm_major_version,
    _is_metrics_auth_binding,
    _is_metrics_auth_role,
    active_helm_post_renderer_plugins_dir,
    filter_helm_manifest_yaml,
    freeze_deployment_bundle,
    helm_metrics_auth_post_renderer,
    helm_post_renderer_root,
    install_deployment_bundle,
    resolve_helm_rbac_mode,
    strip_validated_metrics_auth_rbac,
    subprocess_bundle_runner,
    validate_deployment_bundle,
    validate_frozen_bundle,
)
from llm_d_lens.infrastructure.process import CommandResult


def _asset(name: str, content: str) -> dict[str, str]:
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return {"name": name, "content": content, "checksum": f"sha256:{digest}"}


def _bundle(*, guide: str = "optimized-baseline", commit: str = "a" * 40) -> dict:
    return {
        "schemaVersion": "guide-deployment-bundle.v1",
        "guide": guide,
        "sourceCommit": commit,
        "helm": {
            "chart": "oci://example.invalid/router",
            "version": "v1.2.3",
            "releaseName": guide,
            "values": [
                _asset("router-base.yaml", "base: true\n"),
                _asset("router-effective.yaml", "router:\n  setting: saved\n"),
            ],
        },
        "resources": [_asset("saved-service.yaml", "apiVersion: v1\nkind: Service\nmetadata:\n  name: saved\n")],
    }


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update(schemaVersion="v2"), "schemaVersion"),
        (lambda value: value.update(guide="pd-disaggregation"), "Guide"),
        (lambda value: value.update(sourceCommit="b" * 40), "source commit"),
        (lambda value: value["resources"].append(_asset("../escape.yaml", "kind: Service\n")), "safe file name"),
        (lambda value: value["resources"].append(_asset("saved-service.yaml", "kind: Service\n")), "unique"),
        (lambda value: value["helm"]["values"][-1].update(content="router: changed\n"), "checksum"),
        (
            lambda value: value["helm"]["values"][-1].update(
                content="- invalid\n", checksum=_asset("x", "- invalid\n")["checksum"]
            ),
            "mapping",
        ),
        (
            lambda value: value["resources"][0].update(
                content="kind: Namespace\n", checksum=_asset("x", "kind: Namespace\n")["checksum"]
            ),
            "namespace-neutral",
        ),
        (
            lambda value: value["resources"][0].update(
                content="kind: Service\nmetadata:\n  name: x\n  namespace: fixed\n",
                checksum=_asset("x", "kind: Service\nmetadata:\n  name: x\n  namespace: fixed\n")["checksum"],
            ),
            "namespace-neutral",
        ),
    ],
)
def test_validation_rejects_bundle_integrity_breaks(mutate, message):
    bundle = _bundle()
    mutate(bundle)

    with pytest.raises(ValueError, match=message):
        validate_deployment_bundle(bundle, "optimized-baseline", "a" * 40)


@pytest.mark.asyncio
async def test_install_uses_only_saved_effective_values_and_saved_resources(tmp_path: Path):
    commands: list[list[str]] = []

    async def runner(command: list[str]) -> tuple[int, str, str]:
        commands.append(command)
        if command[1] == "template":
            return 0, "kind: Deployment\nmetadata:\n  name: template-only\n", ""
        if command[1:3] == ["get", "manifest"]:
            return 0, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: rendered-router\n", ""
        return 0, "ok", ""

    result = await install_deployment_bundle(
        _bundle(),
        guide="optimized-baseline",
        source_commit="a" * 40,
        namespace="llmd-run",
        command_runner=runner,
        output_root=tmp_path,
    )

    template, apply_resource, install, get_manifest = commands
    effective_path = Path(template[template.index("--values") + 1])
    assert effective_path.read_text(encoding="utf-8") == "router:\n  setting: saved\n"
    assert "router-base.yaml" not in " ".join(template + install)
    assert apply_resource[:5] == ["kubectl", "apply", "--namespace", "llmd-run", "--filename"]
    assert Path(apply_resource[-1]).read_text(encoding="utf-8").endswith("name: saved\n")
    assert install[:7] == [
        "helm",
        "upgrade",
        "--install",
        "optimized-baseline",
        "oci://example.invalid/router",
        "--namespace",
        "llmd-run",
    ]
    assert get_manifest == ["helm", "get", "manifest", "optimized-baseline", "--namespace", "llmd-run"]
    assert result["router_effective_values"] == "router:\n  setting: saved\n"
    assert result["router_effective_values_checksum"].startswith("sha256:")
    assert result["router_rendered_manifest"].endswith("name: rendered-router\n")
    assert result["router_rendered_manifest_checksum"].startswith("sha256:")


@pytest.mark.asyncio
async def test_install_fails_before_cluster_changes_when_helm_rendering_fails(tmp_path: Path):
    commands: list[list[str]] = []

    async def runner(command: list[str]) -> tuple[int, str, str]:
        commands.append(command)
        return 1, "", "chart unavailable"

    with pytest.raises(RuntimeError, match="chart unavailable"):
        await install_deployment_bundle(
            _bundle(),
            guide="optimized-baseline",
            source_commit="a" * 40,
            namespace="llmd-run",
            command_runner=runner,
            output_root=tmp_path,
        )

    assert len(commands) == 1
    assert commands[0][1] == "template"


@pytest.mark.asyncio
async def test_install_rejects_empty_installed_helm_manifest(tmp_path: Path):
    async def runner(command: list[str]) -> tuple[int, str, str]:
        if command[1:3] == ["get", "manifest"]:
            return 0, "", ""
        return 0, "kind: Deployment\n", ""

    with pytest.raises(RuntimeError, match="empty"):
        await install_deployment_bundle(
            _bundle(),
            guide="optimized-baseline",
            source_commit="a" * 40,
            namespace="llmd-run",
            command_runner=runner,
            output_root=tmp_path,
        )


def _metrics_auth_role(name: str = "router-epp-metrics", *, with_prometheus: bool = False) -> dict:
    rules: list[dict] = [
        {"apiGroups": ["authentication.k8s.io"], "resources": ["tokenreviews"], "verbs": ["create"]},
        {"apiGroups": ["authorization.k8s.io"], "resources": ["subjectaccessreviews"], "verbs": ["create"]},
    ]
    if with_prometheus:
        rules.append({"nonResourceURLs": ["/metrics"], "verbs": ["get"]})
    return {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRole",
        "metadata": {"name": name},
        "rules": rules,
    }


def _metrics_auth_binding(
    name: str = "router-epp-metrics-binding",
    *,
    role_name: str = "router-epp-metrics",
    namespace: str = "llmd-run",
    sa_name: str = "router-epp",
    extra_subject: dict | None = None,
) -> dict:
    subjects = [{"kind": "ServiceAccount", "name": sa_name, "namespace": namespace}]
    if extra_subject is not None:
        subjects.append(extra_subject)
    return {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRoleBinding",
        "metadata": {"name": name},
        "roleRef": {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": role_name,
        },
        "subjects": subjects,
    }


def test_metrics_auth_predicates_and_strip_fail_closed():
    assert _is_metrics_auth_role(_metrics_auth_role())
    assert _is_metrics_auth_role(_metrics_auth_role(with_prometheus=True))
    assert not _is_metrics_auth_role(
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": "metrics-only"},
            "rules": [{"nonResourceURLs": ["/metrics"], "verbs": ["get"]}],
        }
    )
    assert not _is_metrics_auth_role(
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": "too-broad"},
            "rules": [
                {"apiGroups": [""], "resources": ["secrets"], "verbs": ["get"]},
                {"apiGroups": ["authentication.k8s.io"], "resources": ["tokenreviews"], "verbs": ["create"]},
            ],
        }
    )

    roles = {"router-epp-metrics"}
    assert _is_metrics_auth_binding(_metrics_auth_binding(), "llmd-run", roles)
    assert _is_metrics_auth_binding(
        _metrics_auth_binding(
            extra_subject={"kind": "ServiceAccount", "apiGroup": "", "name": "other-epp", "namespace": "llmd-run"}
        ),
        "llmd-run",
        roles,
    )
    assert not _is_metrics_auth_binding(
        _metrics_auth_binding(
            extra_subject={
                "kind": "ServiceAccount",
                "apiGroup": "rbac.authorization.k8s.io",
                "name": "other-epp",
                "namespace": "llmd-run",
            }
        ),
        "llmd-run",
        roles,
    )
    assert not _is_metrics_auth_binding(_metrics_auth_binding(namespace="other-ns"), "llmd-run", roles)

    docs = [
        None,
        _metrics_auth_role(with_prometheus=True),
        _metrics_auth_binding(),
        {
            "kind": "List",
            "items": [
                {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "epp", "namespace": "llmd-run"}},
                {
                    "apiVersion": "llm-d.ai/v1alpha2",
                    "kind": "InferenceObjective",
                    "metadata": {"name": "obj"},
                },
                {"apiVersion": "coordination.k8s.io/v1", "kind": "Lease", "metadata": {"name": "epp-lease"}},
                {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "epp-token"}},
            ],
        },
    ]
    kept, stripped = strip_validated_metrics_auth_rbac(docs, "llmd-run")
    assert [item["kind"] for item in stripped] == ["ClusterRole", "ClusterRoleBinding"]
    assert [item["kind"] for item in kept] == ["Service", "InferenceObjective", "Lease", "Secret"]


@pytest.mark.parametrize(
    "bad_doc",
    [
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRole",
            "metadata": {"name": "evil"},
            "rules": [{"apiGroups": [""], "resources": ["secrets"], "verbs": ["get"]}],
        },
        {
            "apiVersion": "rbac.authorization.k8s.io/v1",
            "kind": "ClusterRoleBinding",
            "metadata": {"name": "evil-crb"},
            "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin"},
            "subjects": [{"kind": "ServiceAccount", "name": "epp", "namespace": "llmd-run"}],
        },
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "llmd-other"}},
        {
            "apiVersion": "apiextensions.k8s.io/v1",
            "kind": "CustomResourceDefinition",
            "metadata": {"name": "foo.example.com"},
        },
        {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "svc", "namespace": "other-ns"}},
    ],
)
def test_filter_helm_manifest_yaml_rejects_unexpected_or_cross_namespace_resources(bad_doc):
    manifest = yaml.safe_dump_all(
        [{"apiVersion": "v1", "kind": "Service", "metadata": {"name": "ok"}}, bad_doc],
        sort_keys=False,
    )
    with pytest.raises(ValueError):
        filter_helm_manifest_yaml(manifest, "llmd-run")


def test_filter_helm_manifest_yaml_rejects_empty_after_stripping():
    manifest = yaml.safe_dump_all([_metrics_auth_role(), _metrics_auth_binding()], sort_keys=False)
    with pytest.raises(ValueError, match="no remaining resources"):
        filter_helm_manifest_yaml(manifest, "llmd-run")


def test_helm_major_version_detection_and_caching(monkeypatch):
    _helm_major_version.cache_clear()
    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        if cmd == ["/opt/helm3/helm", "version", "--template={{.Version}}"]:
            return SimpleNamespace(returncode=0, stdout="v3.19.0\n", stderr="")
        if cmd == ["/opt/helm4/helm", "version", "--template={{.Version}}"]:
            return SimpleNamespace(returncode=0, stdout="v4.0.0\n", stderr="")
        if cmd == ["/opt/helm4-build/helm", "version", "--template={{.Version}}"]:
            return SimpleNamespace(returncode=0, stdout="v4.1.2+g1234\n", stderr="")
        if cmd == ["/opt/fallback/helm", "version", "--template={{.Version}}"]:
            return SimpleNamespace(returncode=1, stdout="", stderr="unknown flag")
        if cmd == ["/opt/fallback/helm", "version", "--short"]:
            return SimpleNamespace(returncode=0, stdout="v4.0.1+gabcd\n", stderr="")
        if cmd == ["/opt/garbage/helm", "version", "--template={{.Version}}"]:
            return SimpleNamespace(returncode=0, stdout="unparseable", stderr="")
        if cmd == ["/opt/garbage/helm", "version", "--short"]:
            return SimpleNamespace(returncode=0, stdout="still-weird", stderr="")
        if cmd[0] == "/opt/missing/helm":
            raise FileNotFoundError("no such binary")
        if cmd[0] == "/opt/timeout/helm":
            raise subprocess.TimeoutExpired(cmd, 5)
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    monkeypatch.setattr(deployment_bundle.subprocess, "run", fake_run)
    try:
        assert _helm_major_version("/opt/helm3/helm") == 3
        assert _helm_major_version(Path("/opt/helm3/helm")) == 3  # normalized cache hit
        assert calls == [["/opt/helm3/helm", "version", "--template={{.Version}}"]]

        assert _helm_major_version("/opt/helm4/helm") == 4
        assert _helm_major_version("/opt/helm4-build/helm") == 4
        assert _helm_major_version("/opt/fallback/helm") == 4
        assert _helm_major_version("/opt/garbage/helm") == 3
        assert _helm_major_version("/opt/missing/helm") == 3
        assert _helm_major_version("/opt/timeout/helm") == 3
    finally:
        _helm_major_version.cache_clear()


def test_helm_post_renderer_permissions_and_cleanup(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "post-renderers")
    monkeypatch.setattr(deployment_bundle, "_helm_major_version", lambda _helm_bin="helm": 3)
    with helm_metrics_auth_post_renderer("llmd-run") as post_renderer:
        assert isinstance(post_renderer, HelmPostRenderer)
        wrapper = post_renderer.script_path
        assert str(post_renderer) == str(wrapper)
        assert post_renderer.helm_args() == ["--post-renderer", str(wrapper)]
        assert post_renderer.plugins_dir is None
        assert post_renderer.subprocess_env() is None
        assert post_renderer.subprocess_env({"KUBECONFIG": "/k"}) == {"KUBECONFIG": "/k"}
        assert active_helm_post_renderer_plugins_dir() is None
        assert wrapper.name == "strip-metrics-auth-rbac"
        assert wrapper.is_file()
        assert wrapper.parent.is_relative_to(helm_post_renderer_root())
        assert stat.S_IMODE(wrapper.stat().st_mode) == 0o700
        assert stat.S_IMODE(wrapper.parent.stat().st_mode) == 0o700
        filter_py = wrapper.parent / "filter.py"
        assert stat.S_IMODE(filter_py.stat().st_mode) == 0o600
        parent_dir = wrapper.parent
    assert not parent_dir.exists()

    with pytest.raises(ValueError, match="DNS-1123"), helm_metrics_auth_post_renderer("INVALID_NS"):
        pass


def test_helm_v4_post_renderer_plugin_manifest_env_and_context_cleanup(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "post-renderers")
    monkeypatch.setattr(deployment_bundle, "_helm_major_version", lambda _helm_bin="helm": 4)
    monkeypatch.setenv("HELM_PLUGINS", "/ambient/evil-plugins")
    base_env = {"KUBECONFIG": "/tmp/kubeconfig", "HELM_PLUGINS": "/external/plugins"}

    assert active_helm_post_renderer_plugins_dir() is None
    with helm_metrics_auth_post_renderer("llmd-run", helm_bin="/opt/helm4") as post_renderer:
        assert str(post_renderer) == "strip-metrics-auth-rbac"
        assert post_renderer.helm_args() == ["--post-renderer", "strip-metrics-auth-rbac"]
        plugins_dir = post_renderer.plugins_dir
        assert plugins_dir is not None
        assert active_helm_post_renderer_plugins_dir() == plugins_dir
        assert plugins_dir.parent == post_renderer.script_path.parent
        assert stat.S_IMODE(plugins_dir.stat().st_mode) == 0o700
        plugin_dir = plugins_dir / "strip-metrics-auth-rbac"
        assert stat.S_IMODE(plugin_dir.stat().st_mode) == 0o700
        plugin_yaml = plugin_dir / "plugin.yaml"
        assert stat.S_IMODE(plugin_yaml.stat().st_mode) == 0o600
        manifest = yaml.safe_load(plugin_yaml.read_text(encoding="utf-8"))
        assert "description" not in manifest
        assert set(manifest.keys()) == {"apiVersion", "type", "name", "version", "runtime", "runtimeConfig"}
        assert manifest == {
            "apiVersion": "v1",
            "type": "postrenderer/v1",
            "name": "strip-metrics-auth-rbac",
            "version": "0.1.0",
            "runtime": "subprocess",
            "runtimeConfig": {"platformCommand": [{"command": str(post_renderer.script_path)}]},
        }

        scoped_env = post_renderer.subprocess_env(base_env)
        assert scoped_env == {"KUBECONFIG": "/tmp/kubeconfig", "HELM_PLUGINS": str(plugins_dir)}
        assert base_env["HELM_PLUGINS"] == "/external/plugins"
        default_env = post_renderer.subprocess_env()
        assert default_env is not None
        assert default_env["HELM_PLUGINS"] == str(plugins_dir)
        assert os.environ["HELM_PLUGINS"] == "/ambient/evil-plugins"

        parent_dir = post_renderer.script_path.parent
    assert not parent_dir.exists()
    assert active_helm_post_renderer_plugins_dir() is None

    # ContextVar also resets when an exception escapes the context block
    with pytest.raises(RuntimeError, match="boom"), helm_metrics_auth_post_renderer("llmd-run"):
        assert active_helm_post_renderer_plugins_dir() is not None
        raise RuntimeError("boom")
    assert active_helm_post_renderer_plugins_dir() is None


def test_post_renderer_preserves_helm4_postrender_filename_annotation(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "post-renderers")
    monkeypatch.setattr(deployment_bundle, "_helm_major_version", lambda _helm_bin="helm": 4)

    role = _metrics_auth_role()
    role["metadata"]["annotations"] = {"postrenderer.helm.sh/postrender-filename": "templates/rbac.yaml"}
    binding = _metrics_auth_binding()
    binding["metadata"]["annotations"] = {"postrenderer.helm.sh/postrender-filename": "templates/rbac.yaml"}
    service = {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {
            "name": "epp",
            "namespace": "llmd-run",
            "annotations": {
                "postrenderer.helm.sh/postrender-filename": "templates/service.yaml",
                "custom.io/keep": "yes",
            },
        },
    }
    raw_yaml = yaml.safe_dump_all([role, binding, service], sort_keys=False)

    filtered_py = filter_helm_manifest_yaml(raw_yaml, "llmd-run")
    kept_py = [doc for doc in yaml.safe_load_all(filtered_py) if doc is not None]
    assert kept_py == [service]

    with helm_metrics_auth_post_renderer("llmd-run") as post_renderer:
        completed = subprocess.run(
            [str(post_renderer.script_path)],
            input=raw_yaml,
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0, completed.stderr
        kept_script = [doc for doc in yaml.safe_load_all(completed.stdout) if doc is not None]
        assert kept_script == [service]


def _write_local_router_chart(chart_dir: Path) -> None:
    templates = chart_dir / "templates"
    templates.mkdir(parents=True)
    (chart_dir / "Chart.yaml").write_text(
        "apiVersion: v2\nname: llm-d-router-standalone\nversion: 1.0.0\n",
        encoding="utf-8",
    )
    (chart_dir / "values.yaml").write_text(
        yaml.safe_dump(
            {
                "router": {
                    "monitoring": {
                        "prometheus": {
                            "enabled": False,
                            "auth": {"enabled": True},
                        },
                        "prometheusoperator": False,
                    },
                    "extraUnexpected": False,
                }
            }
        ),
        encoding="utf-8",
    )
    (templates / "_helpers.tpl").write_text(
        '{{- define "llm-d-router.name" -}}{{ .Release.Name | default "default-pool" | lower | trim | trunc 40 }}-epp{{- end -}}\n'
        '{{- define "llm-d-router.cluster-rbac-name" -}}{{ printf "%s-%s-epp" (include "llm-d-router.name" . | trunc 40) (.Release.Namespace | trunc 40) | trunc 84 }}{{- end -}}\n',
        encoding="utf-8",
    )
    (templates / "rbac.yaml").write_text(
        """{{- if .Values.router.monitoring.prometheus.auth.enabled }}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "llm-d-router.cluster-rbac-name" . }}
rules:
  - apiGroups: ["authentication.k8s.io"]
    resources: ["tokenreviews"]
    verbs: ["create"]
  - apiGroups: ["authorization.k8s.io"]
    resources: ["subjectaccessreviews"]
    verbs: ["create"]
{{- if and .Values.router.monitoring.prometheus.enabled .Values.router.monitoring.prometheusoperator }}
  - nonResourceURLs: ["/metrics"]
    verbs: ["get"]
{{- end }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ include "llm-d-router.cluster-rbac-name" . }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ include "llm-d-router.cluster-rbac-name" . }}
subjects:
  - kind: ServiceAccount
    name: {{ include "llm-d-router.name" . }}
    namespace: {{ .Release.Namespace }}
{{- end }}
""",
        encoding="utf-8",
    )
    (templates / "deployment.yaml").write_text(
        """apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "llm-d-router.name" . }}
  namespace: {{ .Release.Namespace }}
spec:
  template:
    spec:
      serviceAccountName: {{ include "llm-d-router.name" . }}
      containers:
        - name: epp
          args:
            {{- if not .Values.router.monitoring.prometheus.auth.enabled }}
            - --metrics-endpoint-auth=false
            {{- end }}
            - --grpc-port=9002
""",
        encoding="utf-8",
    )
    (templates / "service.yaml").write_text(
        """apiVersion: v1
kind: Service
metadata:
  name: {{ include "llm-d-router.name" . }}
  namespace: {{ .Release.Namespace }}
spec:
  ports:
    - name: grpc
      port: 9002
""",
        encoding="utf-8",
    )
    (templates / "unexpected.yaml").write_text(
        """{{- if .Values.router.extraUnexpected }}
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: unexpected-secrets-reader
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
{{- end }}
""",
        encoding="utf-8",
    )


@pytest.mark.parametrize("with_prometheus", [False, True])
def test_real_helm_post_renderer_strips_metrics_auth_rbac_and_preserves_epp_auth(
    tmp_path: Path, monkeypatch, with_prometheus: bool
):
    helm_bin = shutil.which("helm")
    if not helm_bin:
        pytest.skip("helm binary not installed")
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "post-renderers")
    chart_dir = tmp_path / "chart"
    _write_local_router_chart(chart_dir)
    release = "very-long-release-name-that-exceeds-forty-chars"

    raw_cmd = [helm_bin, "template", release, str(chart_dir), "--namespace", "llmd-run"]
    if with_prometheus:
        raw_cmd.extend(
            [
                "--set",
                "router.monitoring.prometheus.enabled=true",
                "--set",
                "router.monitoring.prometheusoperator=true",
            ]
        )
    raw = subprocess.run(raw_cmd, capture_output=True, text=True, check=False)
    assert raw.returncode == 0, raw.stderr
    raw_docs = [doc for doc in yaml.safe_load_all(raw.stdout) if doc is not None]
    assert [doc["kind"] for doc in raw_docs] == ["ClusterRole", "ClusterRoleBinding", "Service", "Deployment"]

    with helm_metrics_auth_post_renderer("llmd-run", helm_bin=helm_bin) as post_renderer:
        cmd = [*raw_cmd, *post_renderer.helm_args()]
        env = post_renderer.subprocess_env()
        completed = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
        assert completed.returncode == 0, completed.stderr
        docs = [doc for doc in yaml.safe_load_all(completed.stdout) if doc is not None]
        assert [doc["kind"] for doc in docs] == ["Service", "Deployment"]
        deployment = next(doc for doc in docs if doc["kind"] == "Deployment")
        args = deployment["spec"]["template"]["spec"]["containers"][0]["args"]
        assert "--metrics-endpoint-auth=false" not in args

        failing = subprocess.run(
            [*cmd, "--set", "router.extraUnexpected=true"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        assert failing.returncode != 0
        assert "unexpected cluster-scoped RBAC" in failing.stderr


def _ssar_response(allowed_map: dict[tuple[str, str], bool]) -> str:
    items = []
    for resource in ("clusterroles", "clusterrolebindings"):
        for verb in ("get", "create", "patch", "delete"):
            items.append(
                {
                    "apiVersion": "authorization.k8s.io/v1",
                    "kind": "SelfSubjectAccessReview",
                    "spec": {
                        "resourceAttributes": {
                            "verb": verb,
                            "group": "rbac.authorization.k8s.io",
                            "resource": resource,
                        }
                    },
                    "status": {"allowed": allowed_map.get((verb, resource), True)},
                }
            )
    return json.dumps({"apiVersion": "v1", "kind": "List", "items": items})


@pytest.mark.asyncio
async def test_resolve_helm_rbac_mode_admin_non_admin_and_failures():
    class _FakeRunner:
        def __init__(self, allowed_map: dict[tuple[str, str], bool], marker_data: dict | None):
            self.allowed_map = allowed_map
            self.marker_data = marker_data

        async def run(self, argv, *, input=None, timeout=15):  # noqa: A002 - CommandRunner contract
            if argv[:2] == ["kubectl", "create"]:
                return CommandResult(tuple(argv), 0, _ssar_response(self.allowed_map), "")
            if argv[:3] == ["kubectl", "get", "configmap"]:
                if self.marker_data is None:
                    return CommandResult(tuple(argv), 0, "", "")
                return CommandResult(
                    tuple(argv),
                    0,
                    json.dumps({"apiVersion": "v1", "kind": "ConfigMap", "data": self.marker_data}),
                    "",
                )
            raise AssertionError(f"unexpected command: {argv}")

    assert not await resolve_helm_rbac_mode("llmd-run", ssar_runner=_FakeRunner({}, None))

    non_admin_denied = {("create", "clusterrolebindings"): False}
    assert await resolve_helm_rbac_mode(
        "llmd-run",
        ssar_runner=_FakeRunner(
            non_admin_denied,
            {"status": "completed", "namespace": "llmd-run", "eppAuthDelegator": "applied"},
        ),
    )

    with pytest.raises(RuntimeError, match="eppAuthDelegator=applied"):
        await resolve_helm_rbac_mode("llmd-run", ssar_runner=_FakeRunner(non_admin_denied, None))

    with pytest.raises(RuntimeError, match="eppAuthDelegator=applied"):
        await resolve_helm_rbac_mode(
            "llmd-run",
            ssar_runner=_FakeRunner(
                non_admin_denied,
                {"status": "completed", "namespace": "llmd-run", "eppAuthDelegator": "not_required"},
            ),
        )


@pytest.mark.asyncio
async def test_resolve_helm_rbac_mode_propagates_auth_and_unavailable_and_ignores_ambient_env(monkeypatch):
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("KUBECONFIG", "/nonexistent/ambient")
    assert not await resolve_helm_rbac_mode("llmd-run", cluster_id=None, environment=None)

    class _AuthFailRunner:
        async def run(self, argv, *, input=None, timeout=15):  # noqa: A002 - CommandRunner contract
            return CommandResult(tuple(argv), 1, "", "error: You must be logged in to the server (Unauthorized)")

    with pytest.raises(capabilities.DeploymentClusterAuthError):
        await resolve_helm_rbac_mode("llmd-run", ssar_runner=_AuthFailRunner())

    class _UnavailableRunner:
        async def run(self, argv, *, input=None, timeout=15):  # noqa: A002 - CommandRunner contract
            return CommandResult(tuple(argv), 1, "", "connection refused")

    with pytest.raises(capabilities.DeploymentCapabilityUnavailableError):
        await resolve_helm_rbac_mode("llmd-run", ssar_runner=_UnavailableRunner())

    called = {}

    async def _fake_shell_run(command, *, env=None, input=None, timeout=None):  # noqa: A002 - CommandRunner contract
        called["command"] = command
        called["env"] = env
        return CommandResult(tuple(command), 0, _ssar_response({}), "")

    monkeypatch.setattr(deployment_bundle.shell, "run", _fake_shell_run)
    assert not await resolve_helm_rbac_mode(
        "llmd-run",
        environment={"KUBECONFIG": "/tmp/explicit-kubeconfig"},
        kubectl_path=Path("/opt/bin/kubectl"),
    )
    assert called["command"][0] == "/opt/bin/kubectl"
    assert called["env"] == {"KUBECONFIG": "/tmp/explicit-kubeconfig"}


@pytest.mark.asyncio
async def test_install_and_validate_frozen_bundle_attach_post_renderer_when_stripping(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "scratch")
    monkeypatch.setattr(deployment_bundle, "_helm_major_version", lambda _helm_bin="helm": 3)
    rendered_with_rbac = yaml.safe_dump_all(
        [
            _metrics_auth_role(),
            _metrics_auth_binding(),
            {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "epp"}},
        ],
        sort_keys=False,
    )
    rendered_without_rbac = "---\napiVersion: v1\nkind: Service\nmetadata:\n  name: epp\n---\n"
    commands: list[list[str]] = []
    seen_exists: list[bool] = []

    async def runner(command: list[str]) -> tuple[int, str, str]:
        commands.append(command)
        if "--post-renderer" in command:
            script = Path(command[command.index("--post-renderer") + 1])
            seen_exists.append(script.is_file() and stat.S_IMODE(script.stat().st_mode) == 0o700)
        if command[1] == "pull":
            (Path(command[-1]) / "router.tgz").write_bytes(b"frozen")
            return 0, "", ""
        if command[1] == "template":
            return 0, rendered_with_rbac, ""
        if command[1] == "install":
            return 0, json.dumps({"manifest": rendered_without_rbac}), ""
        if command[1:3] == ["get", "manifest"]:
            return 0, rendered_without_rbac, ""
        return 0, "ok", ""

    frozen = await freeze_deployment_bundle(
        _bundle(),
        guide="optimized-baseline",
        source_commit="a" * 40,
        namespace="llmd-run",
        command_runner=runner,
        effective_values="router:\n  setting: saved\n",
    )

    await validate_frozen_bundle(
        frozen,
        guide="optimized-baseline",
        source_commit="a" * 40,
        namespace="llmd-run",
        command_runner=runner,
        strip_metrics_auth_rbac=True,
    )
    dry_run_cmd = next(cmd for cmd in commands if cmd[1] == "install")
    assert "--post-renderer" in dry_run_cmd

    commands.clear()
    await install_deployment_bundle(
        frozen,
        guide="optimized-baseline",
        source_commit="a" * 40,
        namespace="llmd-run",
        command_runner=runner,
        output_root=tmp_path / "out",
        strip_metrics_auth_rbac=True,
    )
    template_cmd = next(cmd for cmd in commands if cmd[1] == "template")
    upgrade_cmd = next(cmd for cmd in commands if cmd[1] == "upgrade")
    get_cmd = next(cmd for cmd in commands if cmd[1:3] == ["get", "manifest"])
    assert "--post-renderer" not in template_cmd
    assert "--post-renderer" in upgrade_cmd
    assert "--post-renderer" not in get_cmd
    assert seen_exists == [True, True]
    assert not Path(upgrade_cmd[upgrade_cmd.index("--post-renderer") + 1]).exists()

    # Drift in a kept document still fails even with strip_metrics_auth_rbac=True
    async def drifted_runner(command: list[str]) -> tuple[int, str, str]:
        return 0, json.dumps({"manifest": "apiVersion: v1\nkind: Service\nmetadata:\n  name: changed\n"}), ""

    with pytest.raises(ValueError, match="differs from the reviewed plan"):
        await validate_frozen_bundle(
            frozen,
            guide="optimized-baseline",
            source_commit="a" * 40,
            namespace="llmd-run",
            command_runner=drifted_runner,
            strip_metrics_auth_rbac=True,
        )


@pytest.mark.asyncio
async def test_subprocess_bundle_runner_helm_v4_env_isolation(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(deployment_bundle, "prism_temp_root", lambda *args: tmp_path / "scratch")
    detected_helm_bins: list[str | Path] = []

    def fake_major(helm_bin="helm"):
        detected_helm_bins.append(helm_bin)
        return 4

    monkeypatch.setattr(deployment_bundle, "_helm_major_version", fake_major)

    spawned: list[tuple[list[str], dict[str, str] | None]] = []
    rendered_with_rbac = yaml.safe_dump_all(
        [
            _metrics_auth_role(),
            _metrics_auth_binding(),
            {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "epp"}},
        ],
        sort_keys=False,
    )
    rendered_without_rbac = "---\napiVersion: v1\nkind: Service\nmetadata:\n  name: epp\n---\n"

    async def fake_spawn(command, **kwargs):
        spawned.append((command, kwargs.get("env")))
        if command[1] == "template":
            out = rendered_with_rbac.encode()
        elif command[1] == "install":
            out = json.dumps({"manifest": rendered_without_rbac}).encode()
        elif command[1:3] == ["get", "manifest"]:
            out = rendered_without_rbac.encode()
        else:
            out = b"ok"
        return SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(out, b"")))

    monkeypatch.setattr(deployment_bundle, "spawn", fake_spawn)

    monkeypatch.delenv("HELM_PLUGINS", raising=False)
    base_env = {"KUBECONFIG": "/tmp/kubeconfig"}
    runner = subprocess_bundle_runner(Path("/opt/helm4/helm"), Path("/opt/kubectl"), base_env)
    assert runner._helm_path == Path("/opt/helm4/helm")

    await install_deployment_bundle(
        _bundle(),
        guide="optimized-baseline",
        source_commit="a" * 40,
        namespace="llmd-run",
        command_runner=runner,
        output_root=tmp_path / "out",
        strip_metrics_auth_rbac=True,
    )
    assert detected_helm_bins == [Path("/opt/helm4/helm")]
    template_call = next(item for item in spawned if item[0][:2] == ["/opt/helm4/helm", "template"])
    upgrade_call = next(item for item in spawned if item[0][:2] == ["/opt/helm4/helm", "upgrade"])
    get_call = next(item for item in spawned if item[0][:3] == ["/opt/helm4/helm", "get", "manifest"])
    assert template_call[1] == base_env
    assert get_call[1] == base_env
    assert upgrade_call[0][-2:] == ["--post-renderer", "strip-metrics-auth-rbac"]
    assert upgrade_call[1] is not None
    assert upgrade_call[1]["KUBECONFIG"] == "/tmp/kubeconfig"
    assert "HELM_PLUGINS" in upgrade_call[1]
    assert "HELM_PLUGINS" not in base_env
    assert "HELM_PLUGINS" not in os.environ
