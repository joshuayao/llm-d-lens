"""Validate and consume immutable deployment inputs saved by Guide planning."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import shlex
import sys
import tempfile
from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from llm_d_lens.configuration.router_compatibility import compatible_router_values
from llm_d_lens.infrastructure.process import CommandResult, shell, spawn
from llm_d_lens.infrastructure.storage.paths import prism_temp_root

CommandRunner = Callable[[list[str]], Awaitable[tuple[int, str, str]]]
_SCHEMA_VERSION = "guide-deployment-bundle.v1"
_SAFE_ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
_DNS1123_LABEL = re.compile(r"^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$")
_CLUSTER_RBAC_SSAR_KEYS: tuple[tuple[str, str, str, str, str], ...] = tuple(
    (verb, "rbac.authorization.k8s.io", resource, "", "")
    for resource in ("clusterroles", "clusterrolebindings")
    for verb in ("get", "create", "patch", "delete")
)


@dataclass(frozen=True)
class MaterializedDeploymentBundle:
    chart: str
    version: str
    release_name: str
    effective_values: Path
    resources: tuple[Path, ...]
    calibration: Path | None


_METRICS_AUTH_RULES = {
    ("authentication.k8s.io", "tokenreviews"),
    ("authorization.k8s.io", "subjectaccessreviews"),
}

_REVIEW_ALLOWED_NAMESPACED: dict[str, set[str]] = {
    "v1": {"Pod", "Service", "ServiceAccount", "ConfigMap", "PersistentVolumeClaim", "Endpoints"},
    "apps/v1": {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet"},
    "batch/v1": {"Job", "CronJob"},
    "rbac.authorization.k8s.io/v1": {"Role", "RoleBinding"},
    "policy/v1": {"PodDisruptionBudget"},
    "networking.k8s.io/v1": {"NetworkPolicy", "Ingress"},
    "discovery.k8s.io/v1": {"EndpointSlice"},
    "gateway.networking.k8s.io/v1": {"Gateway", "HTTPRoute", "GRPCRoute"},
    "gateway.networking.k8s.io/v1beta1": {"ReferenceGrant", "Gateway", "HTTPRoute"},
    "inference.networking.k8s.io/v1": {"InferencePool"},
    "inference.networking.x-k8s.io/v1alpha2": {"InferencePool", "InferenceModel"},
    "disaggregatedset.x-k8s.io/v1": {"DisaggregatedSet"},
    "leaderworkerset.x-k8s.io/v1": {"LeaderWorkerSet"},
    "resource.k8s.io/v1": {"ResourceClaimTemplate", "ResourceClaim"},
    "resource.k8s.io/v1beta2": {"ResourceClaimTemplate", "ResourceClaim"},
    "resource.k8s.io/v1beta1": {"ResourceClaimTemplate", "ResourceClaim"},
}

_POST_RENDERER_ALLOWED_NAMESPACED: dict[str, set[str]] = {
    **_REVIEW_ALLOWED_NAMESPACED,
    "v1": {*_REVIEW_ALLOWED_NAMESPACED["v1"], "Secret"},
    "autoscaling/v1": {"HorizontalPodAutoscaler"},
    "autoscaling/v2": {"HorizontalPodAutoscaler"},
    "monitoring.coreos.com/v1": {"ServiceMonitor", "PodMonitor"},
    "monitoring.googleapis.com/v1": {"PodMonitoring"},
    "llm-d.ai/v1alpha1": {"InferenceObjective", "InferenceModelRewrite"},
    "llm-d.ai/v1alpha2": {"InferenceObjective", "InferenceModelRewrite"},
    "inference.networking.k8s.io/v1alpha2": {"InferencePool"},
    "coordination.k8s.io/v1": {"Lease"},
}


def _flatten(documents: list) -> list:
    flat = []
    for document in documents:
        if isinstance(document, dict) and document.get("kind") == "List":
            flat.extend(_flatten(document.get("items") or []))
        else:
            flat.append(document)
    return flat


def _is_token_or_sar_rule(rule: Any) -> bool:
    if not isinstance(rule, dict):
        return False
    api_groups = rule.get("apiGroups")
    resources = rule.get("resources")
    return (
        rule.get("verbs") == ["create"]
        and not rule.get("resourceNames")
        and not rule.get("nonResourceURLs")
        and isinstance(api_groups, list)
        and bool(api_groups)
        and all(isinstance(group, str) for group in api_groups)
        and isinstance(resources, list)
        and bool(resources)
        and all(isinstance(resource, str) for resource in resources)
        and {(group, resource) for group in api_groups for resource in resources} <= _METRICS_AUTH_RULES
    )


def _is_prometheus_metrics_rule(rule: Any) -> bool:
    if not isinstance(rule, dict):
        return False
    return (
        rule.get("verbs") == ["get"]
        and rule.get("nonResourceURLs") == ["/metrics"]
        and not rule.get("apiGroups")
        and not rule.get("resources")
        and not rule.get("resourceNames")
    )


def _is_metrics_auth_role(document: dict) -> bool:
    """The EPP chart's metrics-auth ClusterRole: TokenReview/SAR create plus optional /metrics get."""
    rules = document.get("rules")
    return (
        document.get("apiVersion") == "rbac.authorization.k8s.io/v1"
        and document.get("kind") == "ClusterRole"
        and not document.get("aggregationRule")
        and isinstance(rules, list)
        and bool(rules)
        and any(_is_token_or_sar_rule(rule) for rule in rules)
        and all(_is_token_or_sar_rule(rule) or _is_prometheus_metrics_rule(rule) for rule in rules)
    )


def _is_metrics_auth_binding(document: dict, namespace: str, roles: set[str]) -> bool:
    subjects = document.get("subjects")
    role_ref = document.get("roleRef")
    return (
        document.get("apiVersion") == "rbac.authorization.k8s.io/v1"
        and document.get("kind") == "ClusterRoleBinding"
        and isinstance(role_ref, dict)
        and role_ref.get("kind") == "ClusterRole"
        and role_ref.get("apiGroup") in {"rbac.authorization.k8s.io", None, ""}
        and role_ref.get("name") in roles
        and isinstance(subjects, list)
        and bool(subjects)
        and all(
            isinstance(item, dict)
            and item.get("kind") == "ServiceAccount"
            and item.get("apiGroup", "") in {"", None}
            and item.get("namespace") == namespace
            and isinstance(item.get("name"), str)
            and bool(item["name"])
            for item in subjects
        )
    )


def strip_validated_metrics_auth_rbac(
    documents: list[Any], namespace: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Strip validated EPP metrics-auth RBAC and fail closed on any other cluster-scoped/unclassified kind."""
    flat = [doc for doc in _flatten(documents) if doc is not None]
    metrics_roles = {
        doc["metadata"]["name"]
        for doc in flat
        if isinstance(doc, dict)
        and _is_metrics_auth_role(doc)
        and isinstance((doc.get("metadata") or {}).get("name"), str)
        and bool((doc.get("metadata") or {}).get("name"))
    }
    kept: list[dict[str, Any]] = []
    stripped: list[dict[str, Any]] = []
    for document in flat:
        if not isinstance(document, dict):
            raise ValueError("Helm manifest documents must be Kubernetes objects")
        api_version = document.get("apiVersion")
        kind = document.get("kind")
        if not isinstance(api_version, str) or not api_version or not isinstance(kind, str) or not kind:
            raise ValueError("Helm manifest documents must declare string apiVersion and kind")
        metadata = document.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"Helm manifest resource {kind} has invalid metadata")
        name = (metadata or {}).get("name") or "<unnamed>"
        if _is_metrics_auth_role(document) or _is_metrics_auth_binding(document, namespace, metrics_roles):
            stripped.append(document)
            continue
        if kind in {"ClusterRole", "ClusterRoleBinding"}:
            raise ValueError(f"Non-admin Helm post-renderer rejected unexpected cluster-scoped RBAC: {kind}/{name}")
        if kind not in _POST_RENDERER_ALLOWED_NAMESPACED.get(api_version, set()):
            raise ValueError(f"Non-admin Helm post-renderer rejected unsupported resource: {api_version}/{kind}")
        doc_namespace = (metadata or {}).get("namespace")
        if doc_namespace is not None and doc_namespace != namespace:
            raise ValueError(
                f"Non-admin Helm post-renderer rejected cross-namespace resource: {kind}/{name} ({doc_namespace})"
            )
        kept.append(document)
    if not kept:
        raise ValueError("Non-admin Helm post-renderer rejected manifest with no remaining resources")
    return kept, stripped


def filter_helm_manifest_yaml(manifest_yaml: str, namespace: str) -> str:
    """Parse rendered Helm YAML, strip validated metrics-auth RBAC, and fail closed on anything unexpected."""
    try:
        documents = [doc for doc in yaml.safe_load_all(manifest_yaml) if doc is not None]
    except yaml.YAMLError as error:
        raise ValueError(f"Non-admin Helm post-renderer received invalid YAML: {error}") from error
    kept, _ = strip_validated_metrics_auth_rbac(documents, namespace)
    return yaml.safe_dump_all(kept, sort_keys=False)


def helm_post_renderer_root() -> Path:
    """Controlled scratch root where temporary Helm post-renderer wrappers live."""
    return prism_temp_root("helm-post-renderers")


def _build_post_renderer_filter_script(namespace: str) -> str:
    allowed_json = json.dumps({key: sorted(value) for key, value in _POST_RENDERER_ALLOWED_NAMESPACED.items()})
    rules_json = json.dumps([list(item) for item in sorted(_METRICS_AUTH_RULES)])
    namespace_json = json.dumps(namespace)
    return f"""import json
import sys
import yaml

TARGET_NAMESPACE = {namespace_json}
ALLOWED_NAMESPACED = {{k: set(v) for k, v in json.loads({allowed_json!r}).items()}}
METRICS_AUTH_RULES = {{tuple(item) for item in json.loads({rules_json!r})}}


def _flatten(documents):
    flat = []
    for document in documents:
        if isinstance(document, dict) and document.get("kind") == "List":
            flat.extend(_flatten(document.get("items") or []))
        else:
            flat.append(document)
    return flat


def _is_token_or_sar_rule(rule):
    if not isinstance(rule, dict):
        return False
    api_groups = rule.get("apiGroups")
    resources = rule.get("resources")
    return (
        rule.get("verbs") == ["create"]
        and not rule.get("resourceNames")
        and not rule.get("nonResourceURLs")
        and isinstance(api_groups, list)
        and bool(api_groups)
        and all(isinstance(group, str) for group in api_groups)
        and isinstance(resources, list)
        and bool(resources)
        and all(isinstance(resource, str) for resource in resources)
        and {{(group, resource) for group in api_groups for resource in resources}} <= METRICS_AUTH_RULES
    )


def _is_prometheus_metrics_rule(rule):
    if not isinstance(rule, dict):
        return False
    return (
        rule.get("verbs") == ["get"]
        and rule.get("nonResourceURLs") == ["/metrics"]
        and not rule.get("apiGroups")
        and not rule.get("resources")
        and not rule.get("resourceNames")
    )


def _is_metrics_auth_role(document):
    rules = document.get("rules")
    return (
        document.get("apiVersion") == "rbac.authorization.k8s.io/v1"
        and document.get("kind") == "ClusterRole"
        and not document.get("aggregationRule")
        and isinstance(rules, list)
        and bool(rules)
        and any(_is_token_or_sar_rule(rule) for rule in rules)
        and all(_is_token_or_sar_rule(rule) or _is_prometheus_metrics_rule(rule) for rule in rules)
    )


def _is_metrics_auth_binding(document, namespace, roles):
    subjects = document.get("subjects")
    role_ref = document.get("roleRef")
    return (
        document.get("apiVersion") == "rbac.authorization.k8s.io/v1"
        and document.get("kind") == "ClusterRoleBinding"
        and isinstance(role_ref, dict)
        and role_ref.get("kind") == "ClusterRole"
        and role_ref.get("apiGroup") in {{"rbac.authorization.k8s.io", None, ""}}
        and role_ref.get("name") in roles
        and isinstance(subjects, list)
        and bool(subjects)
        and all(
            isinstance(item, dict)
            and item.get("kind") == "ServiceAccount"
            and item.get("apiGroup", "") in {{"", None}}
            and item.get("namespace") == namespace
            and isinstance(item.get("name"), str)
            and bool(item["name"])
            for item in subjects
        )
    )


def filter_manifest(raw_yaml):
    try:
        documents = [doc for doc in yaml.safe_load_all(raw_yaml) if doc is not None]
    except yaml.YAMLError as error:
        raise ValueError(f"Non-admin Helm post-renderer received invalid YAML: {{error}}") from error
    flat = [doc for doc in _flatten(documents) if doc is not None]
    metrics_roles = {{
        doc["metadata"]["name"]
        for doc in flat
        if isinstance(doc, dict)
        and _is_metrics_auth_role(doc)
        and isinstance((doc.get("metadata") or {{}}).get("name"), str)
        and bool((doc.get("metadata") or {{}}).get("name"))
    }}
    kept = []
    for document in flat:
        if not isinstance(document, dict):
            raise ValueError("Helm manifest documents must be Kubernetes objects")
        api_version = document.get("apiVersion")
        kind = document.get("kind")
        if not isinstance(api_version, str) or not api_version or not isinstance(kind, str) or not kind:
            raise ValueError("Helm manifest documents must declare string apiVersion and kind")
        metadata = document.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"Helm manifest resource {{kind}} has invalid metadata")
        name = (metadata or {{}}).get("name") or "<unnamed>"
        if _is_metrics_auth_role(document) or _is_metrics_auth_binding(document, TARGET_NAMESPACE, metrics_roles):
            continue
        if kind in {{"ClusterRole", "ClusterRoleBinding"}}:
            raise ValueError(
                f"Non-admin Helm post-renderer rejected unexpected cluster-scoped RBAC: {{kind}}/{{name}}"
            )
        if kind not in ALLOWED_NAMESPACED.get(api_version, set()):
            raise ValueError(
                f"Non-admin Helm post-renderer rejected unsupported resource: {{api_version}}/{{kind}}"
            )
        doc_namespace = (metadata or {{}}).get("namespace")
        if doc_namespace is not None and doc_namespace != TARGET_NAMESPACE:
            raise ValueError(
                f"Non-admin Helm post-renderer rejected cross-namespace resource: {{kind}}/{{name}} ({{doc_namespace}})"
            )
        kept.append(document)
    if not kept:
        raise ValueError("Non-admin Helm post-renderer rejected manifest with no remaining resources")
    return yaml.safe_dump_all(kept, sort_keys=False)


def main():
    try:
        sys.stdout.write(filter_manifest(sys.stdin.read()))
    except Exception as error:
        sys.stderr.write(f"{{error}}\\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
"""


@contextlib.contextmanager
def helm_metrics_auth_post_renderer(namespace: str) -> Iterator[Path]:
    """Yield an owner-only executable Helm ``--post-renderer`` scoped to ``namespace``."""
    if not isinstance(namespace, str) or not _DNS1123_LABEL.fullmatch(namespace):
        raise ValueError("Helm post-renderer namespace must be a valid DNS-1123 label")
    root = helm_post_renderer_root()
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    with tempfile.TemporaryDirectory(prefix="rbac-strip-", dir=root) as directory:
        tmpdir = Path(directory)
        os.chmod(tmpdir, 0o700)
        filter_py = tmpdir / "filter.py"
        filter_py.write_text(_build_post_renderer_filter_script(namespace), encoding="utf-8")
        os.chmod(filter_py, 0o600)
        wrapper = tmpdir / "strip-metrics-auth-rbac"
        wrapper.write_text(
            f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(filter_py))}\n",
            encoding="utf-8",
        )
        os.chmod(wrapper, 0o700)
        yield wrapper


class _KubectlSubprocessRunner:
    """Adapter exposing ``run(argv, input=..., timeout=...)`` for explicit kubeconfig environments."""

    def __init__(self, kubectl_path: Path | None, environment: Mapping[str, str] | None) -> None:
        self._kubectl_path = str(kubectl_path) if kubectl_path is not None else "kubectl"
        self._environment = dict(environment) if environment is not None else None

    async def run(
        self,
        argv: list[str],
        *,
        input: str | bytes | None = None,  # noqa: A002 - CommandRunner contract
        timeout: float | None = 15,
    ) -> CommandResult:
        command = [self._kubectl_path, *argv[1:]] if argv and argv[0] == "kubectl" else list(argv)
        return await shell.run(command, env=self._environment, input=input, timeout=timeout)


def adapter_kubectl_context(adapter: Any) -> tuple[Mapping[str, str] | None, Path | None]:
    """Safely extract ``(environment, kubectl_path)`` from an adapter, including ``__new__`` test instances."""
    runner = getattr(adapter, "_runner", getattr(adapter, "_command_runner", adapter))
    kubectl_target = getattr(runner, "_kubectl", runner)
    environment = getattr(adapter, "_environment", None)
    if environment is None:
        environment = getattr(kubectl_target, "_environment", None)
    raw_kubectl = getattr(adapter, "_kubectl_path", None)
    if raw_kubectl is None:
        raw_kubectl = getattr(kubectl_target, "_kubectl_path", None)
    kubectl_path = Path(raw_kubectl) if raw_kubectl is not None else None
    return environment, kubectl_path


async def resolve_helm_rbac_mode(
    namespace: str,
    *,
    cluster_id: str | None = None,
    environment: Mapping[str, str] | None = None,
    kubectl_path: Path | None = None,
    ssar_runner: Any = None,
) -> bool:
    """Return True when Helm must strip metrics-auth cluster RBAC via ``--post-renderer``.

    Admin callers (all 8 cluster RBAC SSAR checks allowed) return False. Non-admin
    callers require a verified bootstrap marker with ``eppAuthDelegator=applied``;
    otherwise fail closed with ``RuntimeError``. Isolated unit tests with no
    ``ssar_runner``, no registered cluster, and no explicit kubeconfig/in-cluster
    ``environment`` return False without touching ambient ``os.environ``.
    """
    from llm_d_lens.cluster import registry as cluster_registry
    from llm_d_lens.deploy import capabilities
    from llm_d_lens.infrastructure.kubernetes import scoped_runner

    clean_cluster_id = str(cluster_id or "").strip() or None
    active_runner = ssar_runner
    if active_runner is None and clean_cluster_id and cluster_registry.get_cluster(clean_cluster_id) is not None:
        active_runner = scoped_runner(clean_cluster_id)
    if (
        active_runner is None
        and environment is not None
        and (
            bool(str(environment.get("KUBECONFIG") or "").strip())
            or bool(str(environment.get("KUBERNETES_SERVICE_HOST") or "").strip())
        )
    ):
        active_runner = _KubectlSubprocessRunner(kubectl_path, environment)
    if active_runner is None:
        return False

    answers = await capabilities._run_ssar_checks(_CLUSTER_RBAC_SSAR_KEYS, runner=active_runner)
    if all(answers.get(key) is True for key in _CLUSTER_RBAC_SSAR_KEYS):
        return False

    marker = await capabilities.read_bootstrap_marker(clean_cluster_id or "", namespace, runner=active_runner)
    if marker.get("present") is True and marker.get("eppAuthDelegator") == "applied":
        return True
    raise RuntimeError(
        f"Namespace {namespace} lacks cluster-scoped RBAC permissions (clusterroles/clusterrolebindings) "
        "for Helm router installation and does not have a verified Orchestration administrator bootstrap "
        f"marker with eppAuthDelegator=applied. Run the Orchestration administrator deployment bootstrap script "
        f"for {namespace} first."
    )


def validate_review_resources(documents: list[dict], namespace: str) -> None:
    documents = _flatten(documents)
    metrics_roles = {
        (document.get("metadata") or {}).get("name")
        for document in documents
        if isinstance(document, dict) and _is_metrics_auth_role(document)
    }
    for document in documents:
        if not isinstance(document, dict):
            raise ValueError("Prepared resources must be Kubernetes objects")
        kind = document.get("kind")
        if kind == "Secret":
            raise ValueError("Prepared plans must reference existing Secrets, not embed Secret payloads")
        if _is_metrics_auth_role(document) or _is_metrics_auth_binding(document, namespace, metrics_roles):
            continue
        if kind not in _REVIEW_ALLOWED_NAMESPACED.get(document.get("apiVersion"), set()):
            raise ValueError(f"Prepared plans do not support cluster-scoped or unclassified resources: {kind}")
        if document.get("metadata", {}).get("namespace", namespace) != namespace:
            raise ValueError("Prepared resource namespace differs from the reviewed namespace")


async def freeze_deployment_bundle(
    bundle: dict,
    *,
    guide: str,
    source_commit: str,
    namespace: str,
    command_runner: CommandRunner,
    effective_values: str,
) -> dict:
    from copy import deepcopy

    saved = deepcopy(bundle)
    saved["helm"]["values"][-1] = {
        "name": "router-effective.yaml",
        "content": effective_values,
        "checksum": text_checksum(effective_values),
    }
    materialized = materialize_deployment_bundle(saved, guide, source_commit)
    with tempfile.TemporaryDirectory(prefix="chart-", dir=materialized.effective_values.parent) as directory:
        status, stdout, stderr = await command_runner(
            [
                "helm",
                "pull",
                materialized.chart,
                "--version",
                materialized.version,
                "--destination",
                directory,
            ]
        )
        if status:
            raise ValueError(f"Router chart could not be frozen: {(stderr or stdout).strip()}")
        archives = list(Path(directory).glob("*.tgz"))
        if len(archives) != 1 or archives[0].stat().st_size > 20 * 1024 * 1024:
            raise ValueError("Router plan requires one chart archive no larger than 20 MiB")
        archive = archives[0].read_bytes()
        status, rendered, stderr = await command_runner(
            [
                "helm",
                "template",
                materialized.release_name,
                str(archives[0]),
                "--namespace",
                namespace,
                "--values",
                str(materialized.effective_values),
            ]
        )
        if status or not rendered.strip():
            raise ValueError(f"Router chart render failed: {stderr.strip()}")
    validate_review_resources([item for item in yaml.safe_load_all(rendered) if item is not None], namespace)
    for resource in saved["resources"]:
        validate_review_resources(
            [item for item in yaml.safe_load_all(resource["content"]) if item is not None], namespace
        )
    saved["frozen"] = {
        "archive": base64.b64encode(archive).decode("ascii"),
        "chartChecksum": "sha256:" + hashlib.sha256(archive).hexdigest(),
        "namespace": namespace,
        "manifest": rendered,
        "manifestChecksum": text_checksum(rendered),
    }
    return saved


def frozen_chart(bundle: dict, directory: Path, namespace: str) -> Path:
    frozen = bundle["frozen"]
    if frozen["namespace"] != namespace or text_checksum(frozen["manifest"]) != frozen["manifestChecksum"]:
        raise ValueError("Prepared Router namespace or manifest changed")
    archive = base64.b64decode(frozen["archive"], validate=True)
    if "sha256:" + hashlib.sha256(archive).hexdigest() != frozen["chartChecksum"]:
        raise ValueError("Prepared Router chart checksum changed")
    path = directory / "router-frozen.tgz"
    if path.exists() and path.read_bytes() != archive:
        raise ValueError("Prepared Router chart file changed")
    path.write_bytes(archive)
    return path


async def validate_frozen_bundle(
    bundle: dict,
    *,
    guide: str,
    source_commit: str,
    namespace: str,
    command_runner: CommandRunner,
    strip_metrics_auth_rbac: bool = False,
) -> None:
    materialized = materialize_deployment_bundle(bundle, guide, source_commit)
    archive = frozen_chart(bundle, materialized.effective_values.parent, namespace)
    command = [
        "helm",
        "install",
        materialized.release_name,
        str(archive),
        "--namespace",
        namespace,
        "--values",
        str(materialized.effective_values),
        "--dry-run=server",
        "--skip-crds",
        "--output",
        "json",
    ]
    if strip_metrics_auth_rbac:
        with helm_metrics_auth_post_renderer(namespace) as post_renderer:
            status, stdout, stderr = await command_runner([*command, "--post-renderer", str(post_renderer)])
    else:
        status, stdout, stderr = await command_runner(command)
    if status:
        raise ValueError(f"Prepared Router server dry run failed: {(stderr or stdout).strip()}")
    release = json.loads(stdout)
    if release.get("hooks"):
        raise ValueError("Prepared deployments do not execute unreviewed Helm hooks")
    actual = release.get("manifest", "")
    if strip_metrics_auth_rbac:
        actual_docs = [doc for doc in yaml.safe_load_all(actual) if doc is not None]
        expected_docs, _ = strip_validated_metrics_auth_rbac(
            [doc for doc in yaml.safe_load_all(bundle["frozen"]["manifest"]) if doc is not None],
            namespace,
        )
        if actual_docs != expected_docs:
            raise ValueError("Router server render differs from the reviewed plan; prepare a new plan")
    elif list(yaml.safe_load_all(actual)) != list(yaml.safe_load_all(bundle["frozen"]["manifest"])):
        raise ValueError("Router server render differs from the reviewed plan; prepare a new plan")


def subprocess_bundle_runner(
    helm_path: Path,
    kubectl_path: Path,
    environment: dict[str, str] | None = None,
) -> CommandRunner:
    """Build the production command boundary for validated Helm and kubectl plans."""

    async def run(command: list[str]) -> tuple[int, str, str]:
        executable = helm_path if command[0] == "helm" else kubectl_path
        process = await spawn(
            [str(executable), *command[1:]],
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        return (
            process.returncode,
            stdout.decode(errors="replace"),
            stderr.decode(errors="replace"),
        )

    return run


def text_checksum(content: str) -> str:
    return f"sha256:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"


def validate_deployment_bundle(bundle: Any, guide: str, source_commit: str) -> dict[str, Any]:
    """Validate a deployment bundle and its binding to one immutable Guide source."""
    if not isinstance(bundle, dict):
        raise ValueError("Guide deployment bundle must be an object")
    if bundle.get("schemaVersion") != _SCHEMA_VERSION:
        raise ValueError(f"Guide deployment bundle schemaVersion must be {_SCHEMA_VERSION}")
    if bundle.get("guide") != guide:
        raise ValueError("Guide deployment bundle Guide does not match its configuration")
    if bundle.get("sourceCommit") != source_commit:
        raise ValueError("Guide deployment bundle source commit does not match its configuration")
    if not re.fullmatch(r"[0-9a-f]{40}", str(bundle.get("sourceCommit") or "")):
        raise ValueError("Guide deployment bundle source commit must be a full Git commit")

    helm = bundle.get("helm")
    if not isinstance(helm, dict):
        raise ValueError("Guide deployment bundle requires Helm metadata")
    for key in ("chart", "version", "releaseName"):
        if not isinstance(helm.get(key), str) or not helm[key].strip():
            raise ValueError(f"Guide deployment bundle Helm {key} is required")
    values = helm.get("values")
    resources = bundle.get("resources")
    if not isinstance(values, list) or not values:
        raise ValueError("Guide deployment bundle requires Helm values")
    if not isinstance(resources, list):
        raise ValueError("Guide deployment bundle resources must be a list")

    calibration_assets = _calibration_assets(bundle)
    all_assets = [*values, *resources, *calibration_assets]
    names: set[str] = set()
    for item in all_assets:
        name, content = _validate_asset(item)
        if name in names:
            raise ValueError("Guide deployment bundle asset names must be unique")
        names.add(name)
        if item in values:
            _yaml_mapping(content, f"Helm values asset {name}")
        elif item in resources:
            _namespace_neutral_resources(content, name)
    if values[-1].get("name") != "router-effective.yaml":
        raise ValueError("Guide deployment bundle must end with router-effective.yaml")
    if guide == "precise-prefix-cache-routing":
        if not calibration_assets:
            raise ValueError("Precise routing deployment bundle requires calibration input")
        if not resources:
            raise ValueError("Precise routing deployment bundle requires auxiliary resources")
    return bundle


def _calibration_assets(bundle: dict[str, Any]) -> list[Any]:
    """Calibration assets to write beside the install output.

    Accepts a single asset (legacy bundles) or a list (a recipe plus the Job
    templates it reads from its own directory).
    """
    calibration = bundle.get("calibration")
    if calibration is None:
        return []
    if isinstance(calibration, dict):
        return [calibration]
    if isinstance(calibration, list):
        return calibration
    raise ValueError("Guide deployment bundle calibration must be an asset or a list of assets")


def materialize_deployment_bundle(
    bundle: dict[str, Any],
    guide: str,
    source_commit: str,
    output_root: Path | None = None,
) -> MaterializedDeploymentBundle:
    """Write validated bundle assets to a checksum-addressed private directory."""
    validate_deployment_bundle(bundle, guide, source_commit)
    serialized = json.dumps(bundle, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    root = (output_root or prism_temp_root("guide-deployment-bundles")).resolve()
    directory = (root / digest).resolve()
    if not directory.is_relative_to(root):
        raise ValueError("Guide deployment bundle path is outside the controlled output directory")
    directory.mkdir(parents=True, exist_ok=True)

    paths: dict[str, Path] = {}
    calibration_assets = _calibration_assets(bundle)
    assets = [*bundle["helm"]["values"], *bundle["resources"], *calibration_assets]
    for asset in assets:
        path = directory / asset["name"]
        if path.is_file() and path.read_text(encoding="utf-8") != asset["content"]:
            raise ValueError("checksum-addressed Guide deployment bundle drift detected")
        if not path.is_file():
            path.write_text(asset["content"], encoding="utf-8")
        paths[asset["name"]] = path
    calibration_script = next(
        (paths[asset["name"]] for asset in calibration_assets if str(asset["name"]).endswith(".sh")),
        None,
    )
    return MaterializedDeploymentBundle(
        chart=bundle["helm"]["chart"],
        version=bundle["helm"]["version"],
        release_name=bundle["helm"]["releaseName"],
        effective_values=paths["router-effective.yaml"],
        resources=tuple(paths[item["name"]] for item in bundle["resources"]),
        calibration=calibration_script,
    )


async def install_deployment_bundle(
    bundle: dict[str, Any],
    *,
    guide: str,
    source_commit: str,
    namespace: str,
    command_runner: CommandRunner,
    output_root: Path | None = None,
    effective_values_content: str | None = None,
    effective_values_name: str = "router-profile-effective.yaml",
    strip_metrics_auth_rbac: bool = False,
) -> dict[str, Any]:
    """Render and install only saved bundle inputs through an injectable command boundary."""
    materialized = materialize_deployment_bundle(bundle, guide, source_commit, output_root)
    effective_values = materialized.effective_values
    original_content = (
        effective_values_content
        if effective_values_content is not None
        else effective_values.read_text(encoding="utf-8")
    )
    original_values = _yaml_mapping(original_content, "Derived Router values")
    compatible_values = compatible_router_values(original_values, materialized.version)
    if compatible_values != original_values:
        effective_values_content = yaml.safe_dump(compatible_values, sort_keys=False)
    if effective_values_content is not None:
        if bundle.get("frozen") and original_values != _yaml_mapping(
            materialized.effective_values.read_text(), "Frozen Router values"
        ):
            raise ValueError("Router values changed after plan review")
        if not _SAFE_ASSET_NAME.fullmatch(effective_values_name):
            raise ValueError("Derived Router values require a safe file name")
        _yaml_mapping(effective_values_content, "Derived Router values")
        effective_values = materialized.effective_values.parent / effective_values_name
        effective_values.write_text(effective_values_content, encoding="utf-8")
    helm_common = [
        materialized.release_name,
        materialized.chart,
        "--namespace",
        namespace,
        "--version",
        materialized.version,
        "--values",
        str(effective_values),
    ]
    if bundle.get("frozen"):
        helm_common[1] = str(frozen_chart(bundle, effective_values.parent, namespace))
    status, rendered, stderr = await command_runner(["helm", "template", *helm_common])
    if status != 0:
        raise RuntimeError((stderr or rendered or "saved Router Helm render failed").strip())
    if bundle.get("frozen") and list(yaml.safe_load_all(rendered)) != list(
        yaml.safe_load_all(bundle["frozen"]["manifest"])
    ):
        raise ValueError("Router render differs from the reviewed plan")
    for resource in materialized.resources:
        status, stdout, stderr = await command_runner(
            [
                "kubectl",
                "apply",
                "--namespace",
                namespace,
                "--filename",
                str(resource),
            ]
        )
        if status != 0:
            raise RuntimeError((stderr or stdout or "saved Guide resource apply failed").strip())
    frozen_options = ["--skip-crds", "--no-hooks"] if bundle.get("frozen") else []
    install_command = ["helm", "upgrade", "--install", *helm_common, *frozen_options]
    if strip_metrics_auth_rbac:
        with helm_metrics_auth_post_renderer(namespace) as post_renderer:
            status, stdout, stderr = await command_runner([*install_command, "--post-renderer", str(post_renderer)])
    else:
        status, stdout, stderr = await command_runner(install_command)
    if status != 0:
        raise RuntimeError((stderr or stdout or "saved Router deployment failed").strip())
    status, rendered, stderr = await command_runner(
        [
            "helm",
            "get",
            "manifest",
            materialized.release_name,
            "--namespace",
            namespace,
        ]
    )
    if status != 0:
        raise RuntimeError((stderr or rendered or "installed Router manifest capture failed").strip())
    if not rendered.strip():
        raise RuntimeError("installed Router manifest capture returned empty output")
    effective_content = effective_values.read_text(encoding="utf-8")
    return {
        "router_effective_values": effective_content,
        "router_effective_values_checksum": text_checksum(effective_content),
        "router_rendered_manifest": rendered,
        "router_rendered_manifest_checksum": text_checksum(rendered),
        "router_values_path": str(effective_values),
        "router_chart": materialized.chart,
        "router_version": materialized.version,
        "router_release_name": materialized.release_name,
        **({"calibration_script_path": str(materialized.calibration)} if materialized.calibration else {}),
    }


def _validate_asset(asset: Any) -> tuple[str, str]:
    if not isinstance(asset, dict):
        raise ValueError("Guide deployment bundle assets must be objects")
    name, content, checksum = asset.get("name"), asset.get("content"), asset.get("checksum")
    if not isinstance(name, str) or not _SAFE_ASSET_NAME.fullmatch(name) or name in {".", ".."}:
        raise ValueError("Guide deployment bundle asset requires a safe file name")
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"Guide deployment bundle asset {name} requires text content")
    if checksum != text_checksum(content):
        raise ValueError(f"Guide deployment bundle asset {name} checksum does not match its content")
    return name, content


def _yaml_mapping(content: str, label: str) -> dict[str, Any]:
    try:
        parsed = yaml.safe_load(content)
    except yaml.YAMLError as error:
        raise ValueError(f"{label} must be valid YAML: {error}") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} must be a YAML mapping")
    return parsed


def _namespace_neutral_resources(content: str, name: str) -> None:
    try:
        documents = list(yaml.safe_load_all(content))
    except yaml.YAMLError as error:
        raise ValueError(f"Guide deployment resource {name} must be valid YAML: {error}") from error
    if not documents or any(not isinstance(item, dict) for item in documents):
        raise ValueError(f"Guide deployment resource {name} must contain YAML mappings")
    for document in documents:
        metadata = document.get("metadata")
        if document.get("kind") == "Namespace" or (isinstance(metadata, dict) and metadata.get("namespace")):
            raise ValueError(f"Guide deployment resource {name} must be namespace-neutral")
