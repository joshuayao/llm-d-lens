"""Render the Orchestration administrator operation script for a stored provisioning plan.

The script is the only Orchestration administrator artifact. It contains the plan's admin
operations and their readiness waits, writes the completion marker, and never
contains a Lens identity, kubeconfig, user secret, or Lens-local operation.
See ``docs/design/cluster-permission-preflight-design.md`` section 4.5.

This module is a pure generator plus a fail-closed chart-source resolver.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .operations import ChartCRDSource, Operation, OperationApply, OperationWait
from .plan import ProvisioningPlan, plan_hash, plan_hash16

__all__ = [
    "PROTECTED_NAMESPACES",
    "AdminCleanupScript",
    "AdminOperationScript",
    "AdminScriptSourceUnavailableError",
    "AdminScriptValidationError",
    "CleanupOperation",
    "ResolvedChartCRDs",
    "cleanup_cluster_label_value",
    "cleanup_digest",
    "cleanup_marker_name",
    "render_admin_cleanup_script",
    "render_admin_operations_script",
    "resolve_chart_crds",
    "validate_crd_yaml",
    "validate_field_manager",
]

PROTECTED_NAMESPACES = frozenset(
    {
        "default",
        "kube-system",
        "kube-public",
        "kube-node-lease",
        "istio-system",
        "envoy-gateway-system",
        "envoy-ai-gateway-system",
        "agentgateway-system",
    }
)

_NON_DELETABLE_CLEANUP_NAMESPACES = PROTECTED_NAMESPACES | frozenset(
    {"lens-gateway", "lens-monitoring", "llm-d-bench-storage", "lens-storage"}
)

_CLEANUP_KIND_SPECS: dict[str, tuple[str, str | None]] = {
    "namespace": ("namespace", None),
    "helm_release": ("helm_release", None),
    "clusterrole": ("clusterrole", None),
    "clusterrolebinding": ("clusterrolebinding", None),
    "role": ("role", None),
    "rolebinding": ("rolebinding", None),
    "secret": ("secret", None),
    "configmap": ("configmap", None),
    "service": ("service", None),
    "endpoints": ("endpoints", None),
    "daemonset.apps": ("daemonset.apps", None),
    "gateway.gateway.networking.k8s.io": (
        "gateway.gateway.networking.k8s.io",
        "gateways.gateway.networking.k8s.io",
    ),
    "envoyproxy.gateway.envoyproxy.io": (
        "envoyproxy.gateway.envoyproxy.io",
        "envoyproxies.gateway.envoyproxy.io",
    ),
    "clienttrafficpolicy.gateway.envoyproxy.io": (
        "clienttrafficpolicy.gateway.envoyproxy.io",
        "clienttrafficpolicies.gateway.envoyproxy.io",
    ),
    "securitypolicy.gateway.envoyproxy.io": (
        "securitypolicy.gateway.envoyproxy.io",
        "securitypolicies.gateway.envoyproxy.io",
    ),
    "agentgatewaypolicy.agentgateway.dev": (
        "agentgatewaypolicy.agentgateway.dev",
        "agentgatewaypolicies.agentgateway.dev",
    ),
    "envoyfilter.networking.istio.io": (
        "envoyfilter.networking.istio.io",
        "envoyfilters.networking.istio.io",
    ),
}

_CLUSTER_SCOPED_CLEANUP_KINDS = frozenset({"namespace", "clusterrole", "clusterrolebinding"})

_OPERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_DNS1123_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
_RESOURCE_TARGET = re.compile(r"^[a-z][a-z0-9.-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
_FORBIDDEN_MANIFEST_KINDS = frozenset(
    {
        "ClusterRole",
        "ClusterRoleBinding",
        "Secret",
        "ServiceAccount",
        "ServiceAccountToken",
    }
)
_DEFAULT_CHART_CACHE = Path.home() / ".cache" / "lens" / "admin-script-charts"


class AdminScriptValidationError(ValueError):
    """An admin operation cannot be rendered safely."""


class AdminScriptSourceUnavailableError(RuntimeError):
    """A pinned chart source could not be resolved; no script is emitted."""

    code = "admin_script_source_unavailable"

    def __init__(self, message: str) -> None:
        super().__init__(f"{self.code}: {message}")


@dataclass(frozen=True)
class ResolvedChartCRDs:
    """Materialized CRD YAML and the digest of the chart archive it came from."""

    yaml: str
    digest: str


@dataclass(frozen=True)
class AdminOperationScript:
    """The generated admin script and the metadata returned to the caller."""

    filename: str
    script: str
    instructions: str
    plan_hash: str
    admin_operations: tuple[str, ...]
    marker: dict[str, str]
    warnings: tuple[str, ...]
    source_digests: Mapping[str, str]


ChartResolver = Callable[[ChartCRDSource], ResolvedChartCRDs]


def _text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\n" in value or "\r" in value:
        raise AdminScriptValidationError(f"{field} must be a non-empty single-line string")
    return value


def _quote(value: str, field: str = "value") -> str:
    return shlex.quote(_text(value, field))


def _validate_cluster_id(cluster_id: str) -> str:
    value = _text(cluster_id, "cluster id")
    if len(value) > 128 or not _OPERATION_ID.fullmatch(value):
        raise AdminScriptValidationError("cluster id must be a simple identifier")
    return value


def _validate_operation_id(operation_id: str) -> str:
    value = _text(operation_id, "operation id")
    if len(value) > 128 or not _OPERATION_ID.fullmatch(value):
        raise AdminScriptValidationError(f"operation id {value!r} is invalid")
    return value


def validate_field_manager(value: str) -> str:
    """Validate a Kubernetes server-side apply field-manager identifier."""
    return _validate_operation_id(value)


def _validate_namespace(value: str, field: str) -> str:
    text = _text(value, field)
    if len(text) > 63 or not _DNS1123_LABEL.fullmatch(text):
        raise AdminScriptValidationError(f"{field} must be a DNS-1123 label")
    return text


def _validate_resource_name(value: str, field: str) -> str:
    text = _text(value, field)
    if len(text) > 253:
        raise AdminScriptValidationError(f"{field} must be a valid DNS-1123 subdomain")
    for label in text.split("."):
        if not label or len(label) > 63 or not _DNS1123_LABEL.fullmatch(label):
            raise AdminScriptValidationError(f"{field} must be a valid DNS-1123 subdomain")
    return text


def _validate_target(value: str, field: str) -> str:
    text = _text(value, field)
    if not _RESOURCE_TARGET.fullmatch(text):
        raise AdminScriptValidationError(f"{field} must look like kind/name")
    return text


def _validate_selector(value: str, field: str) -> str:
    text = _text(value, field)
    if "'" in text or "`" in text or "$" in text:
        raise AdminScriptValidationError(f"{field} contains unsupported shell characters")
    return text


def _validate_manifest(manifest: Mapping[str, Any], operation_id: str) -> None:
    kind = str(manifest.get("kind") or "")
    if kind == "List":
        items = manifest.get("items")
        if not isinstance(items, list):
            raise AdminScriptValidationError(f"admin operation {operation_id!r} has a List without items")
        for item in items:
            if not isinstance(item, Mapping):
                raise AdminScriptValidationError(f"admin operation {operation_id!r} has a non-object List item")
            _validate_manifest(item, operation_id)
        return
    if kind in _FORBIDDEN_MANIFEST_KINDS:
        raise AdminScriptValidationError(f"admin operation {operation_id!r} must not embed a handoff {kind} object")
    metadata = manifest.get("metadata")
    if metadata is not None:
        if not isinstance(metadata, Mapping):
            raise AdminScriptValidationError(f"admin operation {operation_id!r} has invalid metadata")
        for key in ("name", "namespace"):
            if key in metadata and metadata[key] is not None:
                _text(str(metadata[key]), f"manifest metadata.{key}")


def _validate_crd(manifest: Mapping[str, Any], operation_id: str) -> None:
    if manifest.get("kind") == "List":
        raise AdminScriptValidationError(f"admin operation {operation_id!r} must not use a List for chart CRDs")
    if manifest.get("apiVersion") != "apiextensions.k8s.io/v1" or manifest.get("kind") != "CustomResourceDefinition":
        raise AdminScriptValidationError(
            f"admin operation {operation_id!r} chart subdir contains a non-CRD {manifest.get('kind')!r}"
        )
    _validate_manifest(manifest, operation_id)


def _yaml_documents(manifests: Iterable[Mapping[str, Any]], operation_id: str) -> str:
    documents = list(manifests)
    if not documents:
        raise AdminScriptValidationError(f"admin operation {operation_id!r} has no manifests")
    for document in documents:
        if not isinstance(document, Mapping):
            raise AdminScriptValidationError(f"admin operation {operation_id!r} has a non-object manifest")
        _validate_manifest(document, operation_id)
    rendered = yaml.safe_dump_all(documents, sort_keys=False, default_flow_style=False)
    if not rendered.strip():
        raise AdminScriptValidationError(f"admin operation {operation_id!r} rendered empty YAML")
    return rendered


def _validate_yaml_text(yaml_text: str, operation_id: str, *, crds_only: bool = False) -> None:
    if not isinstance(yaml_text, str):
        raise AdminScriptValidationError(f"admin operation {operation_id!r} has invalid YAML")
    try:
        documents = [document for document in yaml.safe_load_all(yaml_text) if document is not None]
    except yaml.YAMLError as error:
        raise AdminScriptValidationError(f"admin operation {operation_id!r} has invalid YAML: {error}") from error
    if not documents:
        raise AdminScriptValidationError(f"admin operation {operation_id!r} has empty YAML")
    for document in documents:
        if not isinstance(document, Mapping):
            raise AdminScriptValidationError(f"admin operation {operation_id!r} has a non-object YAML document")
        if crds_only:
            _validate_crd(document, operation_id)
        else:
            _validate_manifest(document, operation_id)


def validate_crd_yaml(yaml_text: str, operation_id: str) -> None:
    """Validate that ``yaml_text`` contains only safe v1 CustomResourceDefinition documents."""
    _validate_yaml_text(yaml_text, operation_id, crds_only=True)


def _heredoc_name(prefix: str, operation_id: str) -> str:
    digest = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:12].upper()
    return f"{prefix}_{digest}"


def _apply_flags(apply: OperationApply, *, field_manager: str | None = None, namespace: str | None = None) -> str:
    args = ["kubectl", "apply"]
    options = apply.apply_options
    if options is not None and options.server_side:
        args.append("--server-side")
    if options is not None and options.force_conflicts:
        args.append("--force-conflicts")
    if field_manager:
        args.append(f"--field-manager={validate_field_manager(field_manager)}")
    if options is not None and options.timeout_seconds > 0:
        args.append(f"--timeout={int(options.timeout_seconds)}s")
    if namespace:
        args.extend(["--namespace", _validate_namespace(namespace, "apply namespace")])
    return shlex.join(args)


def _base64_file(
    lines: list[str],
    *,
    variable: str,
    filename: str,
    content: str,
    operation_id: str,
) -> None:
    delimiter = _heredoc_name("LENS_BASE64", operation_id)
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    lines.append(f'{variable}="$TMP_DIR/{filename}"')
    lines.append(f"base64 -d >\"${{{variable}}}\" <<'{delimiter}'")
    for chunk in (encoded[index : index + 76] for index in range(0, len(encoded), 76)):
        lines.append(chunk)
    lines.append(delimiter)
    lines.append(f'chmod 600 "${{{variable}}}"')


def _render_yaml_apply(
    lines: list[str],
    *,
    operation_id: str,
    yaml_text: str,
    apply: OperationApply,
    field_manager: str | None = None,
) -> None:
    if apply.apply_options is not None and apply.apply_options.delete_before_apply:
        raise AdminScriptValidationError(
            f"admin operation {operation_id!r} uses delete_before_apply; admin scripts never delete existing objects"
        )
    safe_id = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:12]
    variable = f"LENS_YAML_{safe_id.upper()}"
    _base64_file(
        lines,
        variable=variable,
        filename=f"manifests-{safe_id}.yaml",
        content=yaml_text,
        operation_id=operation_id,
    )
    apply_flags = _apply_flags(apply, field_manager=field_manager, namespace=apply.namespace)
    if apply.create_if_absent:
        namespace = apply.namespace
        if not namespace:
            for document in yaml.safe_load_all(yaml_text):
                if isinstance(document, Mapping) and document.get("kind") == "Namespace":
                    metadata = document.get("metadata") or {}
                    namespace = str(metadata.get("name") or "") or None
                    break
        if not namespace:
            raise AdminScriptValidationError(
                f"admin operation {operation_id!r} uses create_if_absent without a namespace"
            )
        lines.append(f"if ! kubectl get namespace {_quote(namespace, 'namespace')} >/dev/null 2>&1; then")
        lines.append(f'  {apply_flags} -f "${{{variable}}}"')
        lines.append("fi")
        return
    lines.append(f'{apply_flags} -f "${{{variable}}}"')


def _target_parts(target: str, field: str) -> tuple[str, str]:
    text = _validate_target(target, field)
    kind, name = text.split("/", 1)
    return kind, name


def _namespace_arg(namespace: str | None) -> str:
    if not namespace:
        return ""
    return f" --namespace {_quote(_validate_namespace(namespace, 'wait namespace'), 'namespace')}"


def _timeout_arg(timeout_seconds: int) -> str:
    if timeout_seconds <= 0:
        raise AdminScriptValidationError("wait timeout must be positive")
    return f" --timeout={int(timeout_seconds)}s"


def _gateway_is_istio(operation: Operation) -> bool:
    for document in operation.apply.manifests:
        if not isinstance(document, Mapping) or document.get("kind") != "GatewayClass":
            continue
        spec = document.get("spec") or {}
        controller = str(spec.get("controllerName") or "").lower()
        return "istio" in controller
    return False


def _gateway_node_port(operation: Operation) -> int | None:
    for document in operation.apply.manifests:
        if not isinstance(document, Mapping) or document.get("kind") != "ConfigMap":
            continue
        data = document.get("data") or {}
        service = data.get("service")
        if not isinstance(service, str):
            continue
        match = re.search(r"nodePort:\s*(\d+)", service)
        if match is not None:
            value = int(match.group(1))
            if 30000 <= value <= 32767:
                return value
    return None


def _render_gateway_programmed_wait(wait: OperationWait, operation: Operation) -> list[str]:
    """Wait for Gateway.Programmed, retrying Istio with a NodePort service."""
    base = _render_wait(wait)
    if not _gateway_is_istio(operation):
        return base
    target = _validate_target(wait.target, "wait target")
    namespace = _validate_namespace(wait.namespace or "", "namespace")
    name = target.split("/", 1)[1]
    config_name = f"{name}-config"
    node_port = _gateway_node_port(operation)
    service_lines = ["    spec:", "      type: NodePort"]
    if node_port is not None:
        service_lines += [
            "      ports:",
            "      - name: http",
            "        port: 80",
            f"        nodePort: {node_port}",
        ]
    patch = json.dumps(
        {
            "spec": {
                "infrastructure": {
                    "parametersRef": {
                        "group": "",
                        "kind": "ConfigMap",
                        "name": config_name,
                    }
                }
            }
        },
        separators=(",", ":"),
    )
    return [
        f"if ! {base[0]}; then",
        f'  reason="$(kubectl get {_quote(target, "wait target")}{_namespace_arg(namespace)} '
        '-o jsonpath=\'{.status.conditions[?(@.type=="Programmed")].reason}\' 2>/dev/null || true)"',
        '  if [[ "$reason" == "AddressNotAssigned" ]]; then',
        "    printf 'Gateway has no address; retrying with NodePort...\\n' >&2",
        f"    kubectl apply{_namespace_arg(namespace)} -f - <<'LENS_GATEWAY_NODEPORT'",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        f"  name: {config_name}",
        f"  namespace: {namespace}",
        "data:",
        "  service: |",
        *service_lines,
        "LENS_GATEWAY_NODEPORT",
        f"    kubectl patch {_quote(target, 'wait target')}{_namespace_arg(namespace)} "
        f"--type=merge -p {_quote(patch, 'gateway patch')}",
        f"    {base[0]}",
        "  else",
        f'    die "Timed out waiting for {target} to be Programmed (reason: ${{reason:-unknown}})"',
        "  fi",
        "fi",
    ]


def _validate_driver_name_token(value: str, field: str) -> str:
    text = _text(value, field)
    if not _OPERATION_ID.fullmatch(text):
        raise AdminScriptValidationError(f"{field} contains invalid DaemonSet name characters")
    return text.lower()


def _driver_ready_clauses(target: str) -> list[str]:
    groups = [item.strip() for item in _text(target, "driver-status target").split(";") if item.strip()]
    if not groups:
        raise AdminScriptValidationError("driver-status wait has no matchers")
    clauses: list[str] = []
    for group in groups:
        pairs = [pair.strip() for pair in group.split(",") if pair.strip()]
        if not pairs:
            continue
        namespace_flag = "--all-namespaces"
        labels: list[str] = []
        awk_predicates = ["NF==3", "$2+0>0", "$3+0>=$2+0"]
        for pair in pairs:
            _validate_selector(pair, "driver-status selector")
            if "=" not in pair:
                raise AdminScriptValidationError(f"driver-status matcher {pair!r} must look like key=value")
            key, value = pair.split("=", 1)
            if not key or not value:
                raise AdminScriptValidationError(f"driver-status matcher {pair!r} must have non-empty key and value")
            if key == "namespace":
                ns = _validate_namespace(value, "driver-status namespace")
                namespace_flag = f"--namespace {_quote(ns, 'driver-status namespace')}"
            elif key == "label":
                if "=" not in value:
                    raise AdminScriptValidationError(f"driver-status label matcher {value!r} must look like k=v")
                labels.append(_validate_selector(value, "driver-status label"))
            elif key == "name":
                exact = _validate_driver_name_token(value, "driver-status name")
                awk_predicates.append(f'tolower($1)=="{exact}"')
            elif key == "name_contains":
                substr = _validate_driver_name_token(value, "driver-status name_contains")
                awk_predicates.append(f'index(tolower($1), "{substr}")>0')
            else:
                labels.append(_validate_selector(pair, "driver-status selector"))
        label_flag = f" -l {_quote(','.join(labels), 'driver-status selector')}" if labels else ""
        awk_expr = " && ".join(awk_predicates)
        jsonpath = _quote(
            '{range .items[*]}{.metadata.name}{"\\t"}'
            '{.status.desiredNumberScheduled}{"\\t"}{.status.numberReady}{"\\n"}{end}',
            "jsonpath",
        )
        clauses.append(
            f"(kubectl get daemonsets {namespace_flag}{label_flag} "
            f"-o jsonpath={jsonpath} "
            f"2>/dev/null || true) | awk -F '\\t' '{awk_expr} {{found=1}} END{{exit !found}}'"
        )
    if not clauses:
        raise AdminScriptValidationError("driver-status wait has no matchers")
    return clauses


def _render_wait(wait: OperationWait) -> list[str]:
    kind = wait.kind
    timeout = _timeout_arg(wait.timeout_seconds)
    namespace = _namespace_arg(wait.namespace)
    if kind in {"rollout", "crd-established", "pvc-bound", "job-complete", "gateway-programmed", "kubectl-wait"}:
        if kind == "rollout":
            target = _validate_target(wait.target, "rollout target")
            return [f"kubectl rollout status {_quote(target, 'rollout target')}{namespace}{timeout}"]
        if kind == "pvc-bound":
            target = _validate_target(wait.target, "pvc target")
            return [
                "kubectl wait --for='jsonpath={.status.phase}=Bound' "
                f"{_quote(target, 'pvc target')}{namespace}{timeout}"
            ]
        if kind == "job-complete" and wait.target.startswith("jobs-by-label/"):
            selector = _validate_selector(wait.target.removeprefix("jobs-by-label/"), "job selector")
            return [
                "kubectl wait --for=condition=Complete "
                f"--selector={_quote(selector, 'job selector')} jobs{namespace}{timeout}"
            ]
        if kind == "kubectl-wait":
            target = _validate_target(wait.target, "wait target")
            return [f"kubectl wait --for=condition=Ready {_quote(target, 'wait target')}{namespace}{timeout}"]
        condition = "Programmed" if kind == "gateway-programmed" else "Established"
        if kind == "job-complete":
            condition = "Complete"
        target = _validate_target(wait.target, "wait target")
        return [f"kubectl wait --for=condition={condition} {_quote(target, 'wait target')}{namespace}{timeout}"]
    if kind == "node-label":
        selector = _validate_selector(wait.target, "node label selector")
        return [
            f"deadline=$((SECONDS+{int(wait.timeout_seconds)}))",
            f'until [[ -n "$(kubectl get nodes -l {_quote(selector, "node label selector")} '
            '-o name 2>/dev/null)" ]]; do',
            '  (( SECONDS < deadline )) || die "Timed out waiting for the node label"',
            "  sleep 5",
            "done",
        ]
    if kind == "driver-status":
        clauses = _driver_ready_clauses(wait.target)
        condition = " || ".join(clauses)
        return [
            f"deadline=$((SECONDS+{int(wait.timeout_seconds)}))",
            "ready=0",
            "while (( SECONDS < deadline )); do",
            f"  if {condition}; then",
            "    ready=1",
            "    break",
            "  fi",
            "  sleep 5",
            "done",
            '(( ready )) || die "Timed out waiting for the driver DaemonSet status"',
        ]
    if kind == "helm":
        release = _text(wait.target, "helm release")
        return [f"helm status {_quote(release, 'helm release')}{namespace} >/dev/null"]
    raise AdminScriptValidationError(f"unsupported admin wait kind {kind!r}")


def _render_command(apply: OperationApply, operation_id: str) -> list[str]:
    if not apply.argv:
        raise AdminScriptValidationError(f"admin command operation {operation_id!r} has no argv")
    argv = [_text(argument, "command argument") for argument in apply.argv]
    if argv[0] == "helm":
        if any(argument.startswith("--set") for argument in argv[1:]):
            raise AdminScriptValidationError(f"admin helm operation {operation_id!r} must use --values, never --set")
        if argv[1:3] != ["upgrade", "--install"]:
            raise AdminScriptValidationError(f"admin helm operation {operation_id!r} must use 'helm upgrade --install'")
    lines: list[str] = []
    if apply.stdin is None:
        lines.append(shlex.join(argv))
        return lines
    stdin = _text_stripped(apply.stdin, f"{operation_id} stdin")
    if argv == ["bash", "-s"]:
        delimiter = _heredoc_name("LENS_SCRIPT", operation_id)
        if "\r" not in stdin and delimiter not in stdin.splitlines():
            lines.append(f"bash -s <<'{delimiter}'")
            lines.extend(stdin.splitlines())
            lines.append(delimiter)
            return lines
    safe_id = hashlib.sha256(operation_id.encode("utf-8")).hexdigest()[:12]
    variable = f"LENS_STDIN_{safe_id.upper()}"
    _base64_file(
        lines,
        variable=variable,
        filename=f"stdin-{safe_id}",
        content=stdin,
        operation_id=operation_id,
    )
    if argv[0] == "helm":
        if not any(argv[index] in {"--values", "-f"} and argv[index + 1] == "-" for index in range(len(argv) - 1)):
            raise AdminScriptValidationError(
                f"admin helm operation {operation_id!r} must read stdin through --values -"
            )
        placeholder = "__LENS_STDIN_FILE__"
        rewritten = [
            placeholder if argv[index - 1] in {"--values", "-f"} and argv[index] == "-" else argv[index]
            for index in range(len(argv))
        ]
        command = shlex.join(rewritten).replace(shlex.quote(placeholder), f'"${{{variable}}}"')
        lines.append(command)
    else:
        lines.append(f'{shlex.join(argv)} < "${{{variable}}}"')
    return lines


def _text_stripped(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AdminScriptValidationError(f"{field} must be non-empty")
    if "\x00" in value:
        raise AdminScriptValidationError(f"{field} contains a NUL byte")
    return value


def _order_admin_operations(
    operations: Iterable[Operation],
    admin_operation_ids: tuple[str, ...],
    completed_operation_ids: Iterable[str] = (),
) -> list[Operation]:
    ids = set(admin_operation_ids)
    completed = {_validate_operation_id(value) for value in completed_operation_ids}
    ordered = [operation for operation in operations if operation.id in ids]
    found = {operation.id for operation in ordered}
    if found != ids:
        missing = sorted(ids - found)
        raise AdminScriptValidationError(f"unknown admin operations: {', '.join(missing)}")
    seen: set[str] = set()
    for operation in ordered:
        _validate_operation_id(operation.id)
        for dependency in operation.depends_on:
            if dependency not in ids:
                if dependency not in completed:
                    raise AdminScriptValidationError(
                        f"admin operation {operation.id!r} depends on non-admin operation {dependency!r}"
                    )
            elif dependency not in seen:
                raise AdminScriptValidationError(
                    f"admin operation {operation.id!r} is ordered before dependency {dependency!r}"
                )
        seen.add(operation.id)
    return ordered


def _marker_lines(marker_namespace: str, marker_name: str, plan_hash16_value: str) -> list[str]:
    return [
        f"MARKER_NAMESPACE={_quote(marker_namespace, 'marker namespace')}",
        f"MARKER_NAME={_quote(marker_name, 'marker name')}",
        f"PLAN_HASH16={_quote(plan_hash16_value, 'plan hash16')}",
        'DONE_OPS=""',
        'MONITORING_PROMETHEUS_NODE_PORT=""',
        'MONITORING_GRAFANA_NODE_PORT=""',
        'MONITORING_HOST=""',
        "MARKER_WRITTEN=0",
        "MARKER_WRITING=0",
        "",
        "append_done() {",
        '  if [[ -n "$DONE_OPS" ]]; then DONE_OPS="$DONE_OPS,$1"; else DONE_OPS="$1"; fi',
        "}",
        "",
        "cleanup() {",
        '  rm -rf -- "$TMP_DIR"',
        "}",
        "",
        "write_marker() {",
        '  local status="$1"',
        "  local completed_at",
        '  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
        "  (( MARKER_WRITTEN || MARKER_WRITING )) && return 0",
        "  MARKER_WRITING=1",
        '  cat > "$TMP_DIR/marker.yaml" <<MARKER_YAML',
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        '  name: "$MARKER_NAME"',
        '  namespace: "$MARKER_NAMESPACE"',
        "  labels:",
        "    app.kubernetes.io/managed-by: lens",
        '    lens.llm-d.ai/plan-hash: "$PLAN_HASH16"',
        "data:",
        '  planHash: "$PLAN_HASH"',
        '  operations: "$DONE_OPS"',
        '  status: "$status"',
        '  completedAt: "$completed_at"',
        "MARKER_YAML",
        '  if [[ -n "$MONITORING_PROMETHEUS_NODE_PORT" ]]; then',
        '    printf \'  prometheusNodePort: "%s"\\n\' "$MONITORING_PROMETHEUS_NODE_PORT" >> "$TMP_DIR/marker.yaml"',
        "  fi",
        '  if [[ -n "$MONITORING_GRAFANA_NODE_PORT" ]]; then',
        '    printf \'  grafanaNodePort: "%s"\\n\' "$MONITORING_GRAFANA_NODE_PORT" >> "$TMP_DIR/marker.yaml"',
        "  fi",
        '  if [[ -n "$MONITORING_HOST" ]]; then',
        '    printf \'  monitoringHost: "%s"\\n\' "$MONITORING_HOST" >> "$TMP_DIR/marker.yaml"',
        "  fi",
        '  if kubectl apply -f - >/dev/null < "$TMP_DIR/marker.yaml"; then',
        "    MARKER_WRITTEN=1",
        "    MARKER_WRITING=0",
        "    return 0",
        "  fi",
        "  MARKER_WRITING=0",
        "  return 1",
        "}",
        "",
        "die() { printf 'error: %s\\n' \"$*\" >&2; write_marker partial || true; exit 1; }",
        "on_exit() {",
        "  local status=$?",
        "  if (( status != 0 )); then write_marker partial || true; fi",
        "  cleanup",
        "}",
        "trap 'write_marker partial || true' ERR",
        "trap on_exit EXIT",
    ]


def _prepare_storage_rbac_block(
    storage_rbac_namespace: str,
    storage_rbac_subject: Mapping[str, Any] | None,
    *,
    ensure_namespace: bool,
    warning_list: list[str],
) -> list[str]:
    from .evaluator import (  # noqa: PLC0415
        STORAGE_OPERATOR_ROLE_NAME,
        storage_operator_role_binding_manifest,
        storage_operator_role_manifest,
    )

    rbac_ns = _validate_namespace(storage_rbac_namespace, "storage RBAC namespace")
    try:
        role_manifest = storage_operator_role_manifest(rbac_ns)
        binding_manifest = storage_operator_role_binding_manifest(rbac_ns, storage_rbac_subject)
    except ValueError as error:
        raise AdminScriptValidationError(str(error)) from error

    manifests: list[Mapping[str, Any]] = [role_manifest]
    if binding_manifest is not None:
        manifests.append(binding_manifest)

    rbac_lines: list[str] = [
        f"# storage RBAC: {STORAGE_OPERATOR_ROLE_NAME} in {rbac_ns}",
    ]
    q_ns = _quote(rbac_ns, "storage RBAC namespace")
    if ensure_namespace:
        rbac_lines.append(f"kubectl get namespace -- {q_ns} >/dev/null 2>&1 || kubectl create namespace -- {q_ns}")
    _render_yaml_apply(
        rbac_lines,
        operation_id="storage.rbac",
        yaml_text=_yaml_documents(manifests, "storage.rbac"),
        apply=OperationApply(kind="manifests", manifests=tuple(manifests), namespace=rbac_ns),
    )
    if binding_manifest is None:
        q_role = _quote(STORAGE_OPERATOR_ROLE_NAME, "storage operator role")
        rbac_lines.extend(
            [
                "# Subject could not be auto-detected from the kubeconfig; bind the Role manually:",
                f"# kubectl -n {q_ns} create rolebinding {q_role} --role={q_role} "
                "--serviceaccount=<sa-namespace>:<sa-name>",
                "# (or --user=<username> / --group=<groupname> for User/Group subjects)",
            ]
        )
        warning_list.append(
            f"Could not auto-detect the Kubernetes subject for namespace '{rbac_ns}'. "
            f"The script creates Role '{STORAGE_OPERATOR_ROLE_NAME}' without a RoleBinding; "
            "ask the Orchestration administrator to bind it to your kubeconfig's ServiceAccount or User "
            "before clicking Re-check."
        )
    rbac_lines.append("")
    return rbac_lines


def render_admin_operations_script(
    *,
    cluster_id: str,
    plan: ProvisioningPlan,
    operations: Iterable[Operation],
    admin_operation_ids: Iterable[str],
    completed_operation_ids: Iterable[str] = (),
    resolver: ChartResolver | None = None,
    warnings: Iterable[str] = (),
    storage_rbac_namespace: str | None = None,
    storage_rbac_subject: Mapping[str, Any] | None = None,
) -> AdminOperationScript:
    """Render the idempotent Orchestration administrator script from the plan's admin operations."""

    cluster = _validate_cluster_id(cluster_id)
    admin_ids = tuple(dict.fromkeys(_validate_operation_id(value) for value in admin_operation_ids))
    if not admin_ids:
        raise AdminScriptValidationError("at least one admin operation is required")
    marker_namespace = _validate_namespace(plan.handoff.namespace, "handoff namespace")
    digest = plan_hash(plan)
    marker_name = f"lens-admin-handoff-{plan_hash16(plan)}"
    ordered = _order_admin_operations(operations, admin_ids, completed_operation_ids=completed_operation_ids)
    chart_resolver = resolver or resolve_chart_crds
    warning_list = list(warnings)

    rbac_placement: str | None = None
    rbac_lines: list[str] = []
    if storage_rbac_namespace is not None:
        rbac_ns = _validate_namespace(storage_rbac_namespace, "storage RBAC namespace")
        ordered_by_id = {op.id: op for op in ordered}
        storage_ns_op = ordered_by_id.get("storage.namespace")
        storage_ns_target: str | None = None
        if storage_ns_op is not None:
            for doc in storage_ns_op.apply.manifests:
                if isinstance(doc, Mapping) and doc.get("kind") == "Namespace":
                    storage_ns_target = str((doc.get("metadata") or {}).get("name") or "") or None
                    break
        if storage_ns_op is not None:
            rbac_placement = "after_storage_namespace"
            ensure_ns = storage_ns_target != rbac_ns
        elif "storage.pvc" in ordered_by_id:
            rbac_placement = "before_storage_pvc"
            ensure_ns = True
        else:
            rbac_placement = "before_marker"
            ensure_ns = True
        rbac_lines = _prepare_storage_rbac_block(
            rbac_ns,
            storage_rbac_subject,
            ensure_namespace=ensure_ns,
            warning_list=warning_list,
        )

    lines: list[str] = [
        "#!/usr/bin/env bash",
        "# Lens Orchestration administrator operation script.",
        f"# cluster: {cluster}",
        f"# planHash: {digest}",
        f"# operations: {','.join(admin_ids)}",
        "#",
        "# Run this with an Orchestration administrator kubeconfig. The script contains no",
        "# Lens identity, kubeconfig, user secret, or Lens-local operation.",
        "",
        "set -euo pipefail",
        "umask 077",
        'TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lens-admin.XXXXXX")"',
        'chmod 700 "$TMP_DIR"',
        "",
        f"PLAN_HASH={_quote(digest, 'plan hash')}",
        *_marker_lines(marker_namespace, marker_name, plan_hash16(plan)),
        "",
    ]
    source_digests: dict[str, str] = {}
    for operation in ordered:
        apply = operation.apply
        if operation.executor == "lens" or apply.kind == "lens":
            raise AdminScriptValidationError(f"lens operation {operation.id!r} cannot enter the admin script")
        if operation.user_owned_secrets:
            raise AdminScriptValidationError(
                f"user-owned secret operation {operation.id!r} cannot enter the admin script"
            )
        if apply.apply_options is not None and apply.apply_options.delete_before_apply:
            raise AdminScriptValidationError(
                f"admin operation {operation.id!r} uses delete_before_apply; "
                "admin scripts never delete existing objects"
            )
        if rbac_placement == "before_storage_pvc" and operation.id == "storage.pvc":
            lines.extend(rbac_lines)
        lines.append(f"# operation: {operation.id} - {operation.title}")
        if operation.depends_on:
            lines.append(f"# depends on: {','.join(operation.depends_on)}")
        op_lines: list[str] = []
        if apply.kind == "manifests":
            _render_yaml_apply(
                op_lines,
                operation_id=operation.id,
                yaml_text=_yaml_documents(apply.manifests, operation.id),
                apply=apply,
            )
        elif apply.kind == "manifests_from_chart":
            source = apply.manifests_source
            if source is None:
                raise AdminScriptValidationError(f"admin operation {operation.id!r} has no chart source")
            resolved = chart_resolver(source)
            source_digests[operation.id] = resolved.digest
            try:
                validate_crd_yaml(resolved.yaml, operation.id)
            except AdminScriptValidationError as error:
                raise AdminScriptSourceUnavailableError(str(error)) from error
            lines.append(f"# source: {source.oci_ref}@{source.version} {resolved.digest}")
            _render_yaml_apply(
                op_lines,
                operation_id=operation.id,
                yaml_text=resolved.yaml,
                apply=apply,
                field_manager=source.field_manager,
            )
        elif apply.kind in {"helm", "command"}:
            op_lines.extend(_render_command(apply, operation.id))
        else:
            raise AdminScriptValidationError(
                f"admin operation {operation.id!r} has unsupported apply kind {apply.kind!r}"
            )
        for wait in apply.wait:
            if wait.kind == "gateway-programmed" and operation.id == "gateway.manifests":
                op_lines.extend(_render_gateway_programmed_wait(wait, operation))
            else:
                op_lines.extend(_render_wait(wait))
        if apply.skip_if_driver_ready:
            skip_condition = " || ".join(_driver_ready_clauses(apply.skip_if_driver_ready))
            quoted_id = _quote(operation.id, "operation id")
            lines.append(f"if {skip_condition}; then")
            lines.append(f"  printf 'Driver already ready for %s; skipping install.\\n' {quoted_id} >&2")
            lines.append("else")
            lines.extend(op_lines)
            lines.append("fi")
        else:
            lines.extend(op_lines)
        lines.append(f"append_done {_quote(operation.id, 'operation id')}")
        if operation.id == "monitoring.stack":
            from llm_d_lens.monitoring.cluster_stack.service import (  # noqa: PLC0415
                render_nodeport_discovery_snippet,
            )

            lines.extend(
                render_nodeport_discovery_snippet(
                    monitoring_namespace=plan.monitoring.namespace,
                    emit_marker_vars=True,
                )
            )
        lines.append("")
        if rbac_placement == "after_storage_namespace" and operation.id == "storage.namespace":
            lines.extend(rbac_lines)

    if rbac_placement == "before_marker":
        lines.extend(rbac_lines)

    lines.extend(
        [
            "write_marker complete",
            "printf 'Lens Orchestration administrator operations completed for plan %s\\n' \"$PLAN_HASH\"",
            "trap - ERR",
            "",
        ]
    )
    instructions = (
        "Send this script to your Orchestration administrator. They run it once with an Orchestration administrator "
        "kubeconfig; it is idempotent. After it completes, click Re-check in Lens. The script contains "
        "no Lens identity, kubeconfig, or user secret."
    )
    return AdminOperationScript(
        filename=f"lens-admin-operations-{cluster[:8]}.sh",
        script="\n".join(lines),
        instructions=instructions,
        plan_hash=digest,
        admin_operations=admin_ids,
        marker={"namespace": marker_namespace, "name": marker_name},
        warnings=tuple(warning_list),
        source_digests=source_digests,
    )


def _cache_root() -> Path:
    configured = os.environ.get("LENS_ADMIN_SCRIPT_CACHE")
    return Path(configured) if configured else _DEFAULT_CHART_CACHE


def _archive_digest(path: Path) -> str:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as error:
        raise AdminScriptSourceUnavailableError(f"could not read chart archive: {error}") from error
    return f"sha256:{digest.hexdigest()}"


def _normalized_digest(value: str) -> str:
    text = _text(value, "chart digest")
    return text if text.startswith("sha256:") else f"sha256:{text}"


def _helm_pull(source: ChartCRDSource, destination: Path) -> Path:
    argv = [
        "helm",
        "pull",
        source.oci_ref,
        "--version",
        source.version,
        "--destination",
        str(destination),
    ]
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=180, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as error:
        raise AdminScriptSourceUnavailableError(f"helm pull failed for {source.oci_ref}: {error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[:500]
        raise AdminScriptSourceUnavailableError(f"helm pull failed for {source.oci_ref}: {detail}")
    archives = sorted(destination.glob("*.tgz"))
    if len(archives) != 1:
        raise AdminScriptSourceUnavailableError(
            f"helm pull for {source.oci_ref} produced {len(archives)} chart archives"
        )
    return archives[0]


def _safe_extract(archive: Path, destination: Path) -> None:
    try:
        with tarfile.open(archive) as handle:
            for member in handle.getmembers():
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                    raise AdminScriptSourceUnavailableError(f"chart archive has an unsafe path: {member.name}")
            handle.extractall(destination, filter="data")
    except (tarfile.TarError, OSError) as error:
        raise AdminScriptSourceUnavailableError(f"could not extract chart archive: {error}") from error


def _read_crds(root: Path, source: ChartCRDSource) -> str:
    try:
        candidates = sorted(path for path in root.rglob(source.subdir) if path.is_dir())
        if not candidates:
            raise AdminScriptSourceUnavailableError(f"chart has no {source.subdir!r} subdir")
        directory = candidates[0]
        documents: list[str] = []
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.suffix in {".yaml", ".yml"}:
                documents.append(f"# source: {path.relative_to(root)}\n{path.read_text(encoding='utf-8')}")
    except AdminScriptSourceUnavailableError:
        raise
    except (OSError, UnicodeError) as error:
        raise AdminScriptSourceUnavailableError(f"could not read chart CRDs: {error}") from error
    if not documents:
        raise AdminScriptSourceUnavailableError(f"chart {source.subdir!r} subdir contains no YAML")
    return "\n---\n".join(document.rstrip("\n") for document in documents) + "\n"


def _validate_chart_source(source: ChartCRDSource) -> None:
    try:
        oci_ref = _text(source.oci_ref, "chart oci_ref")
        version = _text(source.version, "chart version")
        subdir = _text(source.subdir, "chart subdir")
    except AdminScriptValidationError as error:
        raise AdminScriptSourceUnavailableError(str(error)) from error
    if oci_ref.startswith("-") or version.startswith("-"):
        raise AdminScriptSourceUnavailableError("chart oci_ref and version must not start with '-'")
    subdir_path = Path(subdir)
    if subdir_path.is_absolute() or ".." in subdir_path.parts:
        raise AdminScriptSourceUnavailableError(f"chart subdir {subdir!r} must be a safe relative path")


def _resolve_chart_crds(source: ChartCRDSource, *, cache_root: Path | None = None) -> ResolvedChartCRDs:
    _validate_chart_source(source)
    root = cache_root or _cache_root()
    key = hashlib.sha256(f"{source.oci_ref}@{source.version}:{source.subdir}".encode()).hexdigest()[:32]
    target = root / key
    archive = target / "chart.tgz"
    extracted = target / "chart"
    try:
        pinned = _normalized_digest(source.digest) if source.digest else None
    except AdminScriptValidationError as error:
        raise AdminScriptSourceUnavailableError(f"invalid pinned chart digest: {error}") from error

    if archive.is_file() and extracted.is_dir():
        actual = _archive_digest(archive)
        if pinned is None or actual == pinned:
            try:
                return ResolvedChartCRDs(yaml=_read_crds(extracted, source), digest=actual)
            except AdminScriptSourceUnavailableError:
                pass

    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise AdminScriptSourceUnavailableError(f"could not create the chart cache: {error}") from error
    with tempfile.TemporaryDirectory(prefix=f".{key}.", dir=root) as temporary:
        working = Path(temporary)
        downloaded = _helm_pull(source, working)
        actual = _archive_digest(downloaded)
        if pinned is not None and actual != pinned:
            raise AdminScriptSourceUnavailableError(
                f"chart digest mismatch for {source.oci_ref}: expected {pinned}, got {actual}"
            )
        working_extracted = working / "chart"
        _safe_extract(downloaded, working_extracted)
        yaml_text = _read_crds(working_extracted, source)
        if target.exists():
            for child in target.iterdir():
                if child.is_file():
                    child.unlink()
        target.mkdir(parents=True, exist_ok=True)
        os.replace(downloaded, archive)
        if extracted.exists():
            shutil.rmtree(extracted)
        os.replace(working_extracted, extracted)
    return ResolvedChartCRDs(yaml=yaml_text, digest=actual)


def resolve_chart_crds(source: ChartCRDSource, *, cache_root: Path | None = None) -> ResolvedChartCRDs:
    """Download, verify, cache and materialize a chart's CRD subdirectory.

    Every filesystem, decode, digest and parse failure is fail-closed as
    ``AdminScriptSourceUnavailableError`` so the API can return 503.
    """
    try:
        return _resolve_chart_crds(source, cache_root=cache_root)
    except AdminScriptSourceUnavailableError:
        raise
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise AdminScriptSourceUnavailableError(f"could not resolve chart source: {error}") from error


@dataclass(frozen=True)
class CleanupOperation:
    """One Kubernetes resource or namespace to delete during cluster cleanup."""

    id: str
    title: str
    kind: str
    name: str
    namespace: str | None = None
    required: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "name": self.name,
            "namespace": self.namespace,
            "required": self.required,
        }


@dataclass(frozen=True)
class AdminCleanupScript:
    """The generated Orchestration administrator cleanup script and its verification metadata."""

    filename: str
    script: str
    instructions: str
    cleanup_digest: str
    operations: tuple[CleanupOperation, ...]
    marker: dict[str, str | None]
    can_verify_marker: bool
    warnings: tuple[str, ...]


_K8S_LABEL_VALUE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$")


def cleanup_cluster_label_value(cluster_id: str) -> str:
    """Return a Kubernetes-valid label value (<= 63 chars, alphanumeric ends) for ``cluster_id``."""
    cluster = _validate_cluster_id(cluster_id)
    if len(cluster) <= 63 and _K8S_LABEL_VALUE.fullmatch(cluster):
        return cluster
    return hashlib.sha256(cluster.encode("utf-8")).hexdigest()[:16]


def cleanup_marker_name(cluster_id: str) -> str:
    """Return the DNS-1123 ConfigMap name used to verify Orchestration administrator cleanup."""
    cluster = _validate_cluster_id(cluster_id)
    candidate = f"lens-admin-cleanup-{cluster}"
    if len(candidate) <= 63 and _DNS1123_LABEL.fullmatch(candidate):
        return candidate
    digest = hashlib.sha256(cluster.encode("utf-8")).hexdigest()[:16]
    return f"lens-admin-cleanup-{digest}"


def _validate_cleanup_operation(
    operation: CleanupOperation,
    *,
    blocked_namespaces: set[str] | frozenset[str],
) -> CleanupOperation:
    op_id = _validate_operation_id(operation.id)
    title = _text(operation.title, f"operation {op_id!r} title")
    if operation.kind not in _CLEANUP_KIND_SPECS:
        raise AdminScriptValidationError(f"unsupported cleanup kind {operation.kind!r}")
    if operation.kind == "namespace":
        name = _validate_namespace(operation.name, f"operation {op_id!r} namespace name")
        if operation.namespace is not None:
            raise AdminScriptValidationError(f"namespace operation {op_id!r} must not declare a namespace")
        if name in blocked_namespaces:
            raise AdminScriptValidationError(f"refusing to delete protected namespace {name!r}")
        namespace = None
    elif operation.kind in _CLUSTER_SCOPED_CLEANUP_KINDS:
        name = _validate_resource_name(operation.name, f"operation {op_id!r} resource name")
        if operation.namespace is not None:
            raise AdminScriptValidationError(f"{operation.kind} operation {op_id!r} must not declare a namespace")
        namespace = None
    else:
        name = _validate_resource_name(operation.name, f"operation {op_id!r} resource name")
        if not operation.namespace:
            raise AdminScriptValidationError(f"cleanup operation {op_id!r} requires a namespace")
        namespace = _validate_namespace(operation.namespace, f"operation {op_id!r} namespace")
    return CleanupOperation(
        id=op_id,
        title=title,
        kind=operation.kind,
        name=name,
        namespace=namespace,
        required=bool(operation.required),
    )


def _cleanup_sort_key(operation: CleanupOperation) -> tuple[str, str, str, str]:
    return (operation.id, operation.kind, operation.namespace or "", operation.name)


def cleanup_digest(cluster_id: str, operations: Iterable[CleanupOperation]) -> str:
    """Compute a deterministic SHA-256 digest over sorted canonical ``required=True`` ops."""
    cluster = _validate_cluster_id(cluster_id)
    deduped: dict[tuple[str, str, str, str], CleanupOperation] = {}
    for operation in operations:
        validated = _validate_cleanup_operation(operation, blocked_namespaces=())
        if not validated.required:
            continue
        deduped.setdefault(_cleanup_sort_key(validated), validated)
    canonical_ops = [
        {
            "id": op.id,
            "kind": op.kind,
            "name": op.name,
            "namespace": op.namespace,
        }
        for op in sorted(deduped.values(), key=_cleanup_sort_key)
    ]
    payload = json.dumps({"clusterId": cluster, "operations": canonical_ops}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _cleanup_marker_lines(
    *,
    cluster_id: str,
    marker_namespace: str,
    marker_name: str,
    digest: str,
) -> list[str]:
    cluster_label = cleanup_cluster_label_value(cluster_id)
    return [
        f"CLUSTER_ID={_quote(cluster_id, 'cluster id')}",
        f"CLUSTER_LABEL={_quote(cluster_label, 'cluster label')}",
        f"MARKER_NAMESPACE={_quote(marker_namespace, 'marker namespace')}",
        f"MARKER_NAME={_quote(marker_name, 'marker name')}",
        f"CLEANUP_DIGEST={_quote(digest, 'cleanup digest')}",
        'DONE_OPS=""',
        "",
        "append_done() {",
        '  if [[ -n "$DONE_OPS" ]]; then DONE_OPS="$DONE_OPS,$1"; else DONE_OPS="$1"; fi',
        "}",
        "",
        "write_marker() {",
        '  local status="$1"',
        "  local completed_at",
        '  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
        "  kubectl apply -f - >/dev/null <<MARKER_YAML",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        '  name: "$MARKER_NAME"',
        '  namespace: "$MARKER_NAMESPACE"',
        "  labels:",
        "    app.kubernetes.io/managed-by: lens",
        '    lens.llm-d.ai/cleanup-cluster: "$CLUSTER_LABEL"',
        "data:",
        '  clusterId: "$CLUSTER_ID"',
        '  cleanupDigest: "$CLEANUP_DIGEST"',
        '  operations: "$DONE_OPS"',
        '  status: "$status"',
        '  completedAt: "$completed_at"',
        "MARKER_YAML",
        "}",
    ]


def render_admin_cleanup_script(
    *,
    cluster_id: str,
    operations: Iterable[CleanupOperation],
    marker_namespace: str | None = None,
    protected_namespaces: Iterable[str] = (),
    warnings: Iterable[str] = (),
    cleanup_digest_override: str | None = None,
) -> AdminCleanupScript:
    """Render an idempotent Orchestration administrator cleanup script and ConfigMap marker handoff."""
    cluster = _validate_cluster_id(cluster_id)
    marker_ns = _validate_namespace(marker_namespace, "marker namespace") if marker_namespace else None
    blocked_namespaces: set[str] = set(_NON_DELETABLE_CLEANUP_NAMESPACES)
    if marker_ns:
        blocked_namespaces.add(marker_ns)
    for item in protected_namespaces:
        if item:
            blocked_namespaces.add(_validate_namespace(item, "protected namespace"))

    deduped: dict[tuple[str, str, str, str], CleanupOperation] = {}
    for operation in operations:
        validated = _validate_cleanup_operation(operation, blocked_namespaces=blocked_namespaces)
        deduped.setdefault(_cleanup_sort_key(validated), validated)
    if not deduped:
        raise AdminScriptValidationError("at least one cleanup operation is required")

    helm_ops = [op for op in deduped.values() if op.kind == "helm_release"]
    resource_ops = [op for op in deduped.values() if op.kind not in {"helm_release", "namespace"}]
    namespace_ops = [op for op in deduped.values() if op.kind == "namespace"]
    ordered_ops = (*helm_ops, *resource_ops, *namespace_ops)

    if cleanup_digest_override is not None:
        digest = _validate_operation_id(cleanup_digest_override)
    else:
        digest = cleanup_digest(cluster, ordered_ops)

    marker_name = cleanup_marker_name(cluster)
    warning_list = list(dict.fromkeys(_text(item, "warning") for item in warnings if item))
    if marker_ns is None:
        warning_list.append(
            "No non-deletable marker namespace is available; after running this script, "
            "use Confirm & Delete Record in Lens."
        )

    lines: list[str] = [
        "#!/usr/bin/env bash",
        "# Lens Orchestration administrator cluster cleanup script.",
        f"# cluster: {cluster}",
        f"# cleanupDigest: {digest}",
        f"# operations: {','.join(op.id for op in ordered_ops)}",
        "#",
        "# Run this once with an Orchestration administrator kubeconfig. It is idempotent and",
        "# contains no Lens identity, kubeconfig, or user secret.",
        "",
        "set -euo pipefail",
        "umask 077",
        "",
    ]
    if marker_ns is not None:
        lines.extend(
            _cleanup_marker_lines(
                cluster_id=cluster,
                marker_namespace=marker_ns,
                marker_name=marker_name,
                digest=digest,
            )
        )
        lines.append("")
    else:
        lines.append(f"CLUSTER_ID={_quote(cluster, 'cluster id')}")
        lines.append(f"CLEANUP_DIGEST={_quote(digest, 'cleanup digest')}")
        lines.append("")

    for op in ordered_ops:
        lines.append(f"# operation: {op.id} - {op.title}")
        if op.kind == "helm_release":
            q_name = _quote(op.name, "helm release")
            q_ns = _quote(op.namespace or "", "helm namespace")
            lines.append(
                f"if command -v helm >/dev/null 2>&1 && helm status {q_name} --namespace {q_ns} >/dev/null 2>&1; then"
            )
            lines.append(f"  helm uninstall {q_name} --namespace {q_ns}")
            lines.append("fi")
        else:
            kubectl_resource, crd_name = _CLEANUP_KIND_SPECS[op.kind]
            args = ["kubectl", "delete", kubectl_resource, op.name]
            if op.namespace:
                args.extend(["--namespace", op.namespace])
            args.append("--ignore-not-found=true")
            command = " ".join(_quote(part, "kubectl argument") for part in args)
            if crd_name is not None:
                lines.append(f"if kubectl get crd {_quote(crd_name, 'crd name')} >/dev/null 2>&1; then")
                lines.append(f"  {command}")
                lines.append("fi")
            else:
                lines.append(command)
        if marker_ns is not None:
            lines.append(f"append_done {_quote(op.id, 'operation id')}")
        lines.append("")

    if marker_ns is not None:
        lines.extend(
            [
                "write_marker completed",
                "printf 'Lens Orchestration administrator cleanup completed for cluster %s (digest %s)\\n' "
                '"$CLUSTER_ID" "$CLEANUP_DIGEST"',
                "",
            ]
        )
    else:
        lines.extend(
            [
                "printf 'Lens Orchestration administrator cleanup completed for cluster %s (digest %s)\\n' "
                '"$CLUSTER_ID" "$CLEANUP_DIGEST"',
                "",
            ]
        )

    instructions = (
        "Ask an Orchestration administrator to run this idempotent cleanup script once with an Orchestration "
        "administrator kubeconfig, then click Re-check & Delete in Lens."
        if marker_ns is not None
        else "Ask an Orchestration administrator to run this idempotent cleanup script once with an Orchestration "
        "administrator kubeconfig, then confirm record deletion in Lens."
    )
    safe_cluster = re.sub(r"[^A-Za-z0-9._-]", "-", cluster)[:32].strip(".-") or "cluster"
    return AdminCleanupScript(
        filename=f"lens-admin-cleanup-{safe_cluster}.sh",
        script="\n".join(lines),
        instructions=instructions,
        cleanup_digest=digest,
        operations=ordered_ops,
        marker={"namespace": marker_ns, "name": marker_name},
        can_verify_marker=marker_ns is not None,
        warnings=tuple(warning_list),
    )
