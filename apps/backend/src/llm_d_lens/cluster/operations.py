"""Operation catalog for a provisioning plan (M1).

The catalog expands the normalized plan into the concrete operations Lens would
apply, together with the exact manifests or commands and the permission checks
each operation needs. It is the single source of truth for both the user
executor and the Orchestration administrator script (see
``docs/design/cluster-permission-preflight-design.md`` sections 4.2, 4.3 and 18).

This module deliberately creates no ServiceAccount, ClusterRole,
ClusterRoleBinding, role hash or replacement kubeconfig for the handoff. The
operations cover the gateway namespace, provider installs, manifests, authz and
CRDs; the node inotify DaemonSet; HF token Secret coordinates; image pre-pull;
accelerator drivers/NFD; stack CRDs; LeaderWorkerSet; and storage identities.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from llm_d_lens.hardware.errors import HardwareProfileNotFoundError
from llm_d_lens.hardware.models import HardwareProfile
from llm_d_lens.hardware.providers.nvidia import (
    NVIDIA_DRA_DAEMONSET,
    NVIDIA_DRA_NAMESPACE,
    NVIDIA_DRA_RELEASE,
    NVIDIA_PLUGIN_DAEMONSET,
    NVIDIA_PLUGIN_NAMESPACE,
    NVIDIA_PLUGIN_RELEASE,
)
from llm_d_lens.hardware.registry import get_profile
from llm_d_lens.hardware.resolver import resolve_by_accelerator_key
from llm_d_lens.model_cache.contracts import (
    HuggingFaceSource,
    ModelCacheEntry,
    ModelSource,
    ModelSourceKind,
    TokenSource,
    TokenSourceMode,
    hf_cache_path,
)
from llm_d_lens.model_service.gateway_providers import (
    GATEWAY_PROVIDER_LABEL,
    MANAGED_LABEL,
    MANAGED_VALUE,
    NODE_SYSCTL_NAME,
    authz_tls_insecure_enabled,
    provider_spec,
    render_gateway_ext_auth,
    render_inference_gateway,
    render_node_inotify_daemonset,
)
from llm_d_lens.storage.contracts import (
    DynamicPvcSpec,
    LocalDiskSpec,
    NfsSpec,
    StorageVolume,
    StorageVolumeKind,
)
from llm_d_lens.versions import (
    LWS_CHART,
    LWS_NAMESPACE,
    LWS_RELEASE,
    gateway_provider_version,
    inference_payload_processor_chart,
    inference_payload_processor_version,
)
from llm_d_lens.versions import (
    lws_version as current_lws_version,
)

from .capabilities import (
    CAPABILITY_UNITS,
    GATEWAY_INSTALL_NAMESPACES,
    MODEL_CACHE_TOKEN_SECRET,
    CheckRule,
    step_units,
)
from .gateway_crds import REQUIRED_CRDS, manifest_urls
from .images import (
    IMAGES_NAME,
    IMAGES_NAMESPACE,
    PULLER_IMAGE,
    prepull_images,
    render_image_puller_daemonset,
)
from .plan import MONITORING_NAMESPACE, AcceleratorPlan, ProvisioningPlan, plan_hash16
from .service import CLUSTER_ID_LABEL, LENS_NAMESPACE_LABELS

__all__ = [
    "ApplyOptions",
    "ChartCRDSource",
    "HF_TOKEN_PLACEHOLDER",
    "Operation",
    "OperationApply",
    "OperationDependencyError",
    "OperationRequirement",
    "OperationWait",
    "SecretCopy",
    "build_operations",
]

GATEWAY_CRD_WAIT_TIMEOUT_SECONDS = 60
#: Placeholder for a user-owned Secret value; the executor injects the real
#: token in memory and it never enters the plan, catalog, logs or script.
HF_TOKEN_PLACEHOLDER = "__LENS_SECRET_HF_TOKEN__"  # noqa: S105 - placeholder, not a credential
_ACCELERATOR_VERBS = ("get", "list", "watch", "create", "update", "patch", "bind", "escalate")


class OperationDependencyError(ValueError):
    """The operation dependency graph is missing an edge target or contains a cycle."""

    code = "operation_dependency_invalid"

    def __init__(self, message: str) -> None:
        super().__init__(f"{self.code}: {message}")


@dataclass(frozen=True)
class OperationRequirement:
    checks: tuple[CheckRule, ...]


@dataclass(frozen=True)
class OperationWait:
    kind: str  # "kubectl-wait", "helm", "rollout", "pvc-bound", "crd-established", "job-complete"
    target: str
    namespace: str | None = None
    timeout_seconds: int = 300


@dataclass(frozen=True)
class ChartCRDSource:
    oci_ref: str
    version: str
    digest: str | None = None
    subdir: str = "crds"
    field_manager: str = "lens"


@dataclass(frozen=True)
class ApplyOptions:
    server_side: bool = False
    force_conflicts: bool = False
    timeout_seconds: int = 300
    delete_before_apply: bool = False


@dataclass(frozen=True)
class SecretCopy:
    source_namespace: str
    source_name: str
    target_namespace: str
    target_name: str
    key: str = "HF_TOKEN"


@dataclass(frozen=True)
class OperationApply:
    kind: str  # "manifests", "manifests_from_chart", "helm", "command", or "lens"
    manifests: tuple[dict[str, Any], ...] = ()  # kind == "manifests"
    argv: tuple[str, ...] = ()  # shell-quoted at render time
    stdin: str | None = None
    namespace: str | None = None
    secret_refs: tuple[str, ...] = ()  # names only; values injected at execution
    wait: tuple[OperationWait, ...] = ()
    #: Create the namespace only when it is absent. The executor reads it
    #: first and leaves an existing namespace (and its labels) untouched.
    create_if_absent: bool = False
    manifests_source: ChartCRDSource | None = None  # kind == "manifests_from_chart"
    apply_options: ApplyOptions | None = None
    #: A pinned CLI tool the executor must resolve (for example istioctl).
    tool: str | None = None
    tool_version: str | None = None
    #: Copy an existing Secret into a same-namespace target without exposing
    #: the value to the catalog.
    secret_copy: SecretCopy | None = None
    #: The executor must inject the cluster/proxy environment before applying
    #: this manifest; the catalog deliberately does not read it.
    inject_proxy_env: bool = False
    #: Skip both apply and readiness waits when a matching DaemonSet across
    #: namespaces is already installed and ready (serialized like driver-status).
    skip_if_driver_ready: str | None = None


@dataclass(frozen=True)
class Operation:
    id: str
    step: str
    title: str
    scope: str
    namespace: str | None
    apply: OperationApply
    requirement: OperationRequirement
    depends_on: tuple[str, ...] = ()
    user_owned_secrets: tuple[str, ...] = ()  # Secret resource names
    user_secret_fields: tuple[str, ...] = ()  # data keys, e.g. ("HF_TOKEN",)
    executor: str = "auto"  # "auto" (splitter), "lens"
    lens_action: str | None = None  # e.g. "gateway-exposure"
    #: The operation can only be run by an Orchestration administrator regardless of checks
    #: (for example an explicit hard-admin pin).
    admin_only: bool = False
    #: Remote Kustomize overlays whose exact namespaced targets cannot be
    #: verified statically require a cluster-wide wildcard (*/*/*) SSAR probe
    #: before Lens executes them directly; otherwise they fall back to the
    #: Orchestration administrator script.
    requires_cluster_wildcard: bool = False


def _check_sort_key(check: CheckRule) -> tuple:
    return (
        check.api_group,
        check.resource,
        check.verb,
        check.scope,
        check.subresource or "",
        check.name or "",
        check.namespace or "",
    )


def _unit_checks(
    unit_id: str,
    *,
    resources: tuple[str, ...] = (),
    scope: str | None = None,
    verbs: tuple[str, ...] = (),
    allow_subresources: bool = False,
) -> set[CheckRule]:
    unit = CAPABILITY_UNITS[unit_id]
    checks: set[CheckRule] = set()
    for check in unit.check_rules:
        if resources and check.resource not in resources:
            continue
        if scope is not None and check.scope != scope:
            continue
        if verbs and check.verb not in verbs:
            continue
        if check.subresource and not allow_subresources:
            continue
        checks.add(check)
    return checks


def _checks_from_step(
    plan: ProvisioningPlan,
    step: str,
    unit_ids: tuple[str, ...],
    *,
    resources: tuple[str, ...] = (),
    scope: str | None = None,
    verbs: tuple[str, ...] = (),
    allow_subresources: bool = False,
) -> tuple[CheckRule, ...]:
    """Derive checks from the existing capability units without using grant rules.

    Only units that :func:`step_units` selects for this step contribute. A
    resource/scope/verb filter keeps one operation from claiming checks another
    operation owns (for example the namespace create versus the DaemonSet).
    Subresources (such as ``pods/log``) are excluded unless requested.
    """

    selected_units = set(step_units(plan, step))
    checks: set[CheckRule] = set()
    for unit_id in unit_ids:
        if unit_id in selected_units:
            checks.update(
                _unit_checks(
                    unit_id,
                    resources=resources,
                    scope=scope,
                    verbs=verbs,
                    allow_subresources=allow_subresources,
                )
            )
    return tuple(sorted(checks, key=_check_sort_key))


def _read_checks(*, resources: tuple[str, ...], scope: str) -> tuple[CheckRule, ...]:
    """Read checks an apply/wait needs, reused from the always-present discovery unit."""

    return tuple(
        sorted(
            _unit_checks(
                "core.discovery",
                resources=resources,
                scope=scope,
                verbs=("get", "list", "watch"),
            ),
            key=_check_sort_key,
        )
    )


def _combine_checks(*groups: tuple[CheckRule, ...]) -> tuple[CheckRule, ...]:
    checks = {check for group in groups for check in group}
    return tuple(sorted(checks, key=_check_sort_key))


def _gateway_namespace_operation(plan: ProvisioningPlan) -> Operation:
    spec = provider_spec(plan.gateway.provider)
    manifest = {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {
            "name": plan.gateway.namespace,
            # Match render_inference_gateway's Namespace labels so the same
            # namespace object is labeled whether Lens or the provider creates it.
            "labels": {MANAGED_LABEL: MANAGED_VALUE, GATEWAY_PROVIDER_LABEL: spec.key},
        },
    }
    return Operation(
        id="gateway.namespace",
        step="gateway",
        title="Create the gateway namespace",
        scope="cluster",
        namespace=None,
        apply=OperationApply(kind="manifests", manifests=(manifest,), create_if_absent=True),
        requirement=OperationRequirement(
            checks=_checks_from_step(
                plan,
                "gateway",
                ("core.namespaces",),
                resources=("namespaces",),
            )
        ),
        # Namespace creation is synchronous; there is no workload to roll out
        # or condition to wait for.
    )


def _inotify_operation(plan: ProvisioningPlan, *, gateway_namespace_planned: bool) -> Operation:
    namespace = plan.gateway.namespace
    image = os.environ.get("LENS_NODE_SYSCTL_IMAGE")
    manifest = yaml.safe_load(render_node_inotify_daemonset(plan.runtime.inotify_limit, namespace, image=image))
    return Operation(
        id="inotify.daemonset",
        step="prepare",
        title="Raise the node inotify instance limit",
        scope="namespace",
        namespace=namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=(manifest,),
            namespace=namespace,
            wait=(OperationWait(kind="rollout", target=f"daemonset/{NODE_SYSCTL_NAME}", namespace=namespace),),
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                # Apply creates/updates the DaemonSet; it does not delete it.
                # Pods are created by the DaemonSet controller, so this
                # operation needs no Pod write permission either.
                _checks_from_step(
                    plan,
                    "prepare",
                    ("core.workloads",),
                    resources=("daemonsets",),
                    scope="namespace",
                    verbs=("create", "update", "patch"),
                ),
                # Client-side apply and rollout status read the DaemonSet.
                _read_checks(resources=("daemonsets",), scope="namespace"),
            )
        ),
        # A create-mode namespace operation owns the Namespace; the DaemonSet
        # must wait for it. An existing namespace needs no such edge.
        depends_on=("gateway.namespace",) if gateway_namespace_planned else (),
    )


def _gateway_crd_waits() -> tuple[OperationWait, ...]:
    """One Established wait per required CRD in every pinned bundle."""

    return tuple(
        OperationWait(
            kind="crd-established",
            target=f"crd/{name}",
            timeout_seconds=GATEWAY_CRD_WAIT_TIMEOUT_SECONDS,
        )
        for names in REQUIRED_CRDS.values()
        for name in names
    )


def _gateway_crds_operation(plan: ProvisioningPlan) -> Operation:
    urls = tuple(manifest_urls().values())
    argv = ["kubectl", "apply", "--server-side", "--force-conflicts"]
    for url in urls:
        argv.extend(("-f", url))
    return Operation(
        id="gateway.crds",
        step="gateway",
        title="Install the pinned Gateway API CRDs",
        scope="cluster",
        namespace=None,
        apply=OperationApply(
            kind="command",
            argv=tuple(argv),
            wait=_gateway_crd_waits(),
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "gateway",
                    ("core.crds",),
                    resources=("customresourcedefinitions",),
                ),
                # Server-side apply and the Established waits read the CRDs.
                _read_checks(resources=("customresourcedefinitions",), scope="cluster"),
            )
        ),
    )


def _gateway_unit_ids(plan: ProvisioningPlan) -> tuple[str, ...]:
    selected = set(step_units(plan, "gateway"))
    allowed = {
        f"gateway.{plan.gateway.provider}",
        "core.crds",
        "core.rbac.escalation",
        "core.rbac.namespaced",
        "core.rbac.cluster",
        "core.namespaces",
        "core.admission",
    }
    return tuple(sorted(selected & allowed))


def _command_namespace(argv: tuple[str, ...] | list[str], provider: str) -> str | None:
    for index, token in enumerate(argv[:-1]):
        if token in ("-n", "--namespace"):
            return argv[index + 1]
    namespaces = GATEWAY_INSTALL_NAMESPACES.get(provider, ())
    return namespaces[0] if namespaces else None


def _rewrite_provider_command(command: tuple[str, ...]) -> tuple[tuple[str, ...], str | None]:
    """Replace Helm file/--set values with stdin values; keep istioctl as-is."""

    argv = list(command)
    if argv[0] != "helm":
        return tuple(argv), None

    rewritten: list[str] = []
    stdin: str | None = None
    index = 0
    while index < len(argv):
        token = argv[index]
        if token in ("-f", "--values") and index + 1 < len(argv):
            path = Path(argv[index + 1])
            if path.is_file():
                stdin = path.read_text(encoding="utf-8")
                rewritten += ["--values", "-"]
            else:
                rewritten += [token, argv[index + 1]]
            index += 2
            continue
        if (
            token == "--set"  # noqa: S105 - CLI flag, not a credential
            and index + 1 < len(argv)
            and argv[index + 1] == "inferenceExtension.enabled=true"
        ):
            stdin = "inferenceExtension:\n  enabled: true\n"
            rewritten += ["--values", "-"]
            index += 2
            continue
        rewritten.append(token)
        index += 1
    if "--wait" not in rewritten:
        rewritten.append("--wait")
    return tuple(rewritten), stdin


def _gateway_provider_checks(plan: ProvisioningPlan) -> tuple[CheckRule, ...]:
    explicit = {
        CheckRule(verb=verb, api_group="", resource=resource, scope="namespace")
        for resource in ("services", "serviceaccounts", "configmaps")
        for verb in ("get", "create", "update", "patch")
    }
    return _combine_checks(
        _checks_from_step(plan, "gateway", _gateway_unit_ids(plan), verbs=_ACCELERATOR_VERBS),
        _read_checks(
            resources=("deployments", "statefulsets", "serviceaccounts", "services", "configmaps"),
            scope="namespace",
        ),
        tuple(explicit),
    )


def _provider_operations(plan: ProvisioningPlan) -> list[Operation]:
    spec = provider_spec(plan.gateway.provider)
    if not spec.install_commands:
        return []

    operations: list[Operation] = []
    previous: str | None = None
    for index, command in enumerate(spec.install_commands):
        argv, stdin = _rewrite_provider_command(command)
        namespace = _command_namespace(argv, plan.gateway.provider)
        if argv[0] == "helm":
            release = argv[argv.index("--install") + 1] if "--install" in argv else f"{plan.gateway.provider}-{index}"
            wait = (
                OperationWait(
                    kind="helm",
                    target=release,
                    namespace=namespace,
                    timeout_seconds=900,
                ),
            )
            kind = "helm"
        else:
            wait = (
                OperationWait(
                    kind="rollout",
                    target="deployment/istiod",
                    namespace=namespace,
                    timeout_seconds=300,
                ),
            )
            kind = "command"
        operation_id = f"gateway.provider.{index}"
        operations.append(
            Operation(
                id=operation_id,
                step="gateway",
                title=f"Install {spec.display_name} ({index + 1}/{len(spec.install_commands)})",
                scope="cluster",
                namespace=namespace,
                apply=OperationApply(
                    kind=kind,
                    argv=argv,
                    stdin=stdin,
                    namespace=namespace,
                    wait=wait,
                    tool="istioctl" if argv[0] == "istioctl" else None,
                    tool_version=(gateway_provider_version("istio") if argv[0] == "istioctl" else None),
                ),
                requirement=OperationRequirement(checks=_gateway_provider_checks(plan)),
                depends_on=(previous,) if previous else (),
            )
        )
        previous = operation_id
    return operations


def _gateway_manifest_checks(plan: ProvisioningPlan) -> tuple[CheckRule, ...]:
    provider = plan.gateway.provider
    checks = {
        CheckRule(verb=verb, api_group="gateway.networking.k8s.io", resource=resource, scope=scope)
        for resource, scope in (("gatewayclasses", "cluster"), ("gateways", "namespace"))
        for verb in ("get", "create", "update", "patch")
    }
    checks.update(
        CheckRule(verb=verb, api_group="", resource="configmaps", scope="namespace")
        for verb in ("get", "create", "update", "patch")
    )
    checks.update(
        CheckRule(verb="get", api_group="", resource=resource, scope="namespace")
        for resource in ("services", "endpoints")
    )
    if provider == "envoy-ai-gateway":
        checks.update(
            CheckRule(verb=verb, api_group="gateway.envoyproxy.io", resource=resource, scope="namespace")
            for resource in ("envoyproxies", "clienttrafficpolicies")
            for verb in ("get", "create", "update", "patch")
        )
    elif provider == "agentgateway":
        checks.add(
            CheckRule(
                verb="get",
                api_group="agentgateway.dev",
                resource="agentgatewaybackends",
                scope="namespace",
            )
        )
    elif provider == "istio":
        checks.add(
            CheckRule(
                verb="get",
                api_group="networking.istio.io",
                resource="virtualservices",
                scope="namespace",
            )
        )
    return tuple(sorted(checks, key=_check_sort_key))


GATEWAY_PROGRAMMED_TIMEOUT_SECONDS = 300


def _gateway_manifests_operation(plan: ProvisioningPlan, provider_ids: tuple[str, ...]) -> Operation:
    service_type = (
        (os.environ.get("LENS_GATEWAY_SERVICE_TYPE") or "").strip()
        or plan.gateway.service_type
        or ("NodePort" if plan.gateway.port is not None else None)
    )
    documents = [
        document
        for document in yaml.safe_load_all(
            render_inference_gateway(
                namespace=plan.gateway.namespace,
                gateway_name=plan.gateway.name,
                provider=plan.gateway.provider,
                service_type=service_type,
                service_port=plan.gateway.port,
            )
        )
        if document and document.get("kind") != "Namespace"
    ]
    dependencies: list[str] = []
    if plan.gateway.namespace_mode == "create":
        dependencies.append("gateway.namespace")
    if plan.gateway.provider != "gke":
        dependencies.append("gateway.crds")
    dependencies.extend(provider_ids)
    return Operation(
        id="gateway.manifests",
        step="gateway",
        title="Apply the shared inference Gateway",
        scope="mixed",
        namespace=plan.gateway.namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=tuple(documents),
            namespace=plan.gateway.namespace,
            wait=(
                OperationWait(
                    kind="gateway-programmed",
                    target=f"gateway/{plan.gateway.name}",
                    namespace=plan.gateway.namespace,
                    timeout_seconds=GATEWAY_PROGRAMMED_TIMEOUT_SECONDS,
                ),
            ),
        ),
        requirement=OperationRequirement(checks=_gateway_manifest_checks(plan)),
        depends_on=tuple(dependencies),
    )


def _gateway_exposure_checks(plan: ProvisioningPlan) -> tuple[CheckRule, ...]:
    service_ns = "envoy-gateway-system" if plan.gateway.provider == "envoy-ai-gateway" else plan.gateway.namespace
    checks = {
        CheckRule(verb=verb, api_group="", resource=resource, scope="namespace", namespace=service_ns)
        for resource in ("services", "pods")
        for verb in ("get", "list")
    }
    checks.add(
        CheckRule(
            verb="create",
            api_group="",
            resource="pods",
            subresource="portforward",
            scope="namespace",
            namespace=service_ns,
        )
    )
    if plan.gateway.provider not in {"istio", "envoy-ai-gateway"}:
        checks.add(
            CheckRule(
                verb="get",
                api_group="gateway.networking.k8s.io",
                resource="gateways",
                scope="namespace",
                namespace=plan.gateway.namespace,
            )
        )
    return tuple(sorted(checks, key=_check_sort_key))


def _gateway_exposure_operation(plan: ProvisioningPlan) -> Operation:
    checks = () if plan.gateway.port is None else _gateway_exposure_checks(plan)
    return Operation(
        id="gateway.exposure",
        step="gateway",
        title="Expose the shared inference Gateway",
        scope="namespace",
        namespace=plan.gateway.namespace,
        apply=OperationApply(kind="lens", namespace=plan.gateway.namespace),
        requirement=OperationRequirement(checks=checks),
        depends_on=("gateway.manifests",),
        executor="lens",
        lens_action="gateway-exposure",
    )


def _gateway_authz_checks(plan: ProvisioningPlan, *, authz_tls_insecure: bool) -> tuple[CheckRule, ...]:
    verbs = ("get", "create", "update", "patch")
    checks = {
        CheckRule(verb=verb, api_group="", resource=resource, scope="namespace")
        for resource in ("services", "endpoints")
        for verb in verbs
    }
    provider = plan.gateway.provider
    if provider == "envoy-ai-gateway":
        checks.update(
            CheckRule(verb=verb, api_group="gateway.envoyproxy.io", resource="securitypolicies", scope="namespace")
            for verb in verbs
        )
    elif provider == "agentgateway":
        checks.update(
            CheckRule(verb=verb, api_group="agentgateway.dev", resource="agentgatewaypolicies", scope="namespace")
            for verb in verbs
        )
    elif provider == "istio":
        checks.update(
            CheckRule(verb=verb, api_group="networking.istio.io", resource="envoyfilters", scope="namespace")
            for verb in verbs
        )
        if authz_tls_insecure:
            checks.update(
                CheckRule(verb=verb, api_group="networking.istio.io", resource="destinationrules", scope="namespace")
                for verb in verbs
            )
    return tuple(sorted(checks, key=_check_sort_key))


def _gateway_authz_operation(
    plan: ProvisioningPlan,
    provider_ids: tuple[str, ...],
    *,
    cluster_id: str | None = None,
) -> Operation | None:
    if not plan.gateway.authz_host or plan.gateway.provider == "gke":
        return None
    from llm_d_lens.model_service.gateway_ops import resolve_authz_endpoint  # noqa: PLC0415

    host, port = resolve_authz_endpoint(plan.gateway.authz_host)
    if not host:
        return None
    if port is None:
        raise ValueError(
            "cannot configure Gateway ext_authz: the Lens serving port is unknown; "
            "start the backend with an explicit --port and retry"
        )
    tls_insecure = authz_tls_insecure_enabled()
    documents = render_gateway_ext_auth(
        provider=plan.gateway.provider,
        namespace=plan.gateway.namespace,
        gateway_name=plan.gateway.name,
        authz_host=host,
        authz_port=port,
        authz_cluster_id=cluster_id,
        authz_tls_insecure=tls_insecure,
    )
    if not documents:
        return None
    dependencies: list[str] = []
    if plan.gateway.namespace_mode == "create":
        dependencies.append("gateway.namespace")
    if plan.gateway.provider != "gke":
        dependencies.append("gateway.crds")
    dependencies.extend(provider_ids)
    return Operation(
        id="gateway.authz",
        step="gateway",
        title="Apply the Gateway ext_authz resources",
        scope="namespace",
        namespace=plan.gateway.namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=tuple(documents),
            namespace=plan.gateway.namespace,
        ),
        requirement=OperationRequirement(checks=_gateway_authz_checks(plan, authz_tls_insecure=tls_insecure)),
        depends_on=tuple(dependencies),
    )


_IPP_RELEASE_NAME = "lens-ipp"
_IPP_GRPC_PORT = 9004
_IPP_INSTALL_TIMEOUT_SECONDS = 900
_IPP_ROLLOUT_TIMEOUT_SECONDS = 180
_IPP_DNS1123_LABEL_RE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?\Z")
_IPP_SAFE_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]*\Z")


def _validate_ipp_dns1123_label(value: str, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or "\n" in value
        or "\r" in value
        or len(value) > 63
        or not _IPP_DNS1123_LABEL_RE.fullmatch(value)
    ):
        raise ValueError(f"{field} must be a valid DNS-1123 label")
    return value


def _validate_ipp_dns1123_subdomain(value: str, field: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\n" in value or "\r" in value or len(value) > 253:
        raise ValueError(f"{field} must be a valid DNS-1123 subdomain")
    for label in value.split("."):
        _validate_ipp_dns1123_label(label, field)
    return value


def _validate_ipp_token(value: str, field: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or "\n" in value
        or "\r" in value
        or value.startswith("-")
        or not _IPP_SAFE_TOKEN_RE.fullmatch(value)
    ):
        raise ValueError(f"{field} must be a non-empty single-line safe token")
    return value


def _ipp_heredoc_delimiter(content: str, prefix: str = "LENS_IPP_VALUES") -> str:
    digest = hashlib.sha256(content.encode()).hexdigest()[:12].upper()
    delimiter = f"{prefix}_{digest}"
    existing_lines = set(content.splitlines())
    while delimiter in existing_lines:
        digest = hashlib.sha256(f"{delimiter}:next".encode()).hexdigest()[:12].upper()
        delimiter = f"{prefix}_{digest}"
    return delimiter


def _render_ipp_install_script(
    *,
    gw_ns: str,
    gw_name: str,
    chart: str,
    version: str,
    chart_provider: str,
) -> str:
    """Render an idempotent bash script to install/upgrade the IPP Helm release."""
    safe_ns = _validate_ipp_dns1123_label(gw_ns, "gateway.namespace")
    safe_gw_name = _validate_ipp_dns1123_subdomain(gw_name, "gateway.name")
    safe_chart = _validate_ipp_token(chart, "ippChart")
    safe_version = _validate_ipp_token(version, "ippVersion") if version else ""
    if chart_provider not in ("istio", "gke", "none"):
        raise ValueError(f"unsupported IPP chart provider {chart_provider!r}")

    values_yaml = yaml.safe_dump(
        {
            "payloadProcessor": {"name": _IPP_RELEASE_NAME},
            "provider": {"name": chart_provider},
            "inferenceGateway": {"name": safe_gw_name},
        },
        sort_keys=False,
    ).rstrip("\n")
    delimiter = _ipp_heredoc_delimiter(values_yaml)

    helm_parts = [
        "helm",
        "upgrade",
        "--install",
        shlex.quote(_IPP_RELEASE_NAME),
        shlex.quote(safe_chart),
        "--namespace",
        shlex.quote(safe_ns),
    ]
    if safe_version:
        helm_parts.extend(["--version", shlex.quote(safe_version)])
    helm_parts.extend(["--values", '"$TMP_DIR/ipp-values.yaml"'])

    probe_patch = json.dumps(
        {
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "payload-processor",
                                "livenessProbe": {
                                    "tcpSocket": {"port": _IPP_GRPC_PORT},
                                    "initialDelaySeconds": 10,
                                    "periodSeconds": 20,
                                    "failureThreshold": 3,
                                },
                                "readinessProbe": {
                                    "tcpSocket": {"port": _IPP_GRPC_PORT},
                                    "initialDelaySeconds": 5,
                                    "periodSeconds": 10,
                                    "failureThreshold": 3,
                                },
                            }
                        ]
                    }
                }
            }
        },
        separators=(",", ":"),
    )

    lines = [
        "set -euo pipefail",
        "umask 077",
        'TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lens-ipp.XXXXXX")"',
        "trap 'rm -rf -- \"$TMP_DIR\"' EXIT",
        f"cat > \"$TMP_DIR/ipp-values.yaml\" <<'{delimiter}'",
        *values_yaml.splitlines(),
        delimiter,
        'chmod 600 "$TMP_DIR/ipp-values.yaml"',
        " ".join(helm_parts),
        f"kubectl patch deploy {shlex.quote(_IPP_RELEASE_NAME)} -n {shlex.quote(safe_ns)} "
        f"--type=strategic -p {shlex.quote(probe_patch)} || true",
    ]
    return "\n".join(lines) + "\n"


def _gateway_ipp_checks(plan: ProvisioningPlan, gw_ns: str) -> tuple[CheckRule, ...]:
    write_verbs = ("get", "list", "watch", "create", "update", "patch")
    groups: list[tuple[CheckRule, ...]] = [
        _ns_checks(("deployments",), api_group="apps", verbs=write_verbs, namespace=gw_ns),
        _ns_checks(("services", "serviceaccounts", "configmaps"), api_group="", verbs=write_verbs, namespace=gw_ns),
        _ns_checks(
            ("secrets",),
            api_group="",
            verbs=("get", "list", "watch", "create", "update", "patch", "delete"),
            namespace=gw_ns,
        ),
        _ns_checks(("pods",), api_group="", verbs=("get", "list", "watch"), namespace=gw_ns),
        _ns_checks(
            ("roles", "rolebindings"),
            api_group="rbac.authorization.k8s.io",
            verbs=("get", "list", "watch", "create", "update", "patch", "bind", "escalate"),
            namespace=gw_ns,
        ),
    ]
    provider_verbs = ("get", "list", "create", "update", "patch")
    if plan.gateway.provider == "istio":
        groups.append(
            _ns_checks(
                ("envoyfilters", "destinationrules"),
                api_group="networking.istio.io",
                verbs=provider_verbs,
                namespace=gw_ns,
            )
        )
    elif plan.gateway.provider == "gke":
        groups.append(
            _ns_checks(
                ("gcproutingextensions", "healthcheckpolicies"),
                api_group="networking.gke.io",
                verbs=provider_verbs,
                namespace=gw_ns,
            )
        )
    return _combine_checks(*groups)


def _gateway_ipp_operation(plan: ProvisioningPlan) -> Operation:
    """Build the Inference Payload Processor (IPP) Helm install operation."""
    gw_ns = _validate_ipp_dns1123_label(plan.gateway.namespace, "gateway.namespace")
    gw_name = _validate_ipp_dns1123_subdomain(plan.gateway.name, "gateway.name")
    chart = _validate_ipp_token(inference_payload_processor_chart().strip(), "ippChart")
    if plan.stack.ipp_version is not None and plan.stack.ipp_version != "":
        version = _validate_ipp_token(plan.stack.ipp_version, "ippVersion")
    else:
        fallback_version = inference_payload_processor_version().strip()
        version = _validate_ipp_token(fallback_version, "ippVersion") if fallback_version else ""
    chart_provider = plan.gateway.provider if plan.gateway.provider in ("istio", "gke") else "none"
    script = _render_ipp_install_script(
        gw_ns=gw_ns,
        gw_name=gw_name,
        chart=chart,
        version=version,
        chart_provider=chart_provider,
    )
    return Operation(
        id="gateway.ipp",
        step="gateway",
        title="Install the Inference Payload Processor (IPP)",
        scope="namespace",
        namespace=gw_ns,
        apply=OperationApply(
            kind="command",
            argv=("bash", "-s"),
            stdin=script,
            namespace=gw_ns,
            apply_options=ApplyOptions(timeout_seconds=_IPP_INSTALL_TIMEOUT_SECONDS),
            wait=(
                OperationWait(
                    kind="rollout",
                    target=f"deployment/{_IPP_RELEASE_NAME}",
                    namespace=gw_ns,
                    timeout_seconds=_IPP_ROLLOUT_TIMEOUT_SECONDS,
                ),
            ),
        ),
        requirement=OperationRequirement(checks=_gateway_ipp_checks(plan, gw_ns)),
        depends_on=("gateway.manifests",),
    )


def _gateway_operations(plan: ProvisioningPlan, *, cluster_id: str | None = None) -> list[Operation]:
    if not plan.gateway.provider:
        return []
    provider_operations = _provider_operations(plan)
    provider_ids = tuple(op.id for op in provider_operations)
    operations = list(provider_operations)
    manifests = _gateway_manifests_operation(plan, provider_ids)
    operations.append(manifests)
    authz = _gateway_authz_operation(plan, provider_ids, cluster_id=cluster_id)
    if authz is not None:
        operations.append(authz)
    operations.append(_gateway_ipp_operation(plan))
    operations.append(_gateway_exposure_operation(plan))
    return operations


def _stack_crds_operation(plan: ProvisioningPlan) -> Operation | None:
    if not plan.stack.crds_enabled:
        return None
    urls = manifest_urls()
    selected_keys = [key for key in urls if not (plan.gateway.provider == "gke" and key == "gateway_api")]
    argv = ["kubectl", "apply", "--server-side", "--force-conflicts"]
    for key in selected_keys:
        argv.extend(("-f", urls[key]))
    waits = tuple(
        OperationWait(kind="crd-established", target=f"crd/{name}", timeout_seconds=60)
        for key in selected_keys
        for name in REQUIRED_CRDS[key]
    )
    return Operation(
        id="stack.crds",
        step="crds",
        title="Install the pinned stack CRDs",
        scope="cluster",
        namespace=None,
        apply=OperationApply(kind="command", argv=tuple(argv), wait=waits),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "crds",
                    ("core.crds",),
                    resources=("customresourcedefinitions",),
                    verbs=("create", "update", "patch"),
                ),
                _read_checks(resources=("customresourcedefinitions",), scope="cluster"),
            )
        ),
    )


def _named_crd_checks(names: tuple[str, ...], verbs: tuple[str, ...]) -> tuple[CheckRule, ...]:
    return tuple(
        CheckRule(
            verb=verb,
            api_group="apiextensions.k8s.io",
            resource="customresourcedefinitions",
            scope="cluster",
            name=name,
        )
        for name in names
        for verb in verbs
    )


def _lws_operations(plan: ProvisioningPlan) -> list[Operation]:
    if not plan.stack.lws_enabled:
        return []

    namespace = Operation(
        id="lws.namespace",
        step="lws",
        title="Create the LeaderWorkerSet namespace",
        scope="cluster",
        namespace=None,
        apply=OperationApply(
            kind="manifests",
            manifests=(
                {
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {"name": LWS_NAMESPACE},
                },
            ),
            create_if_absent=True,
        ),
        requirement=OperationRequirement(
            checks=_checks_from_step(
                plan,
                "lws",
                ("core.namespaces",),
                resources=("namespaces",),
            )
        ),
    )

    version = plan.stack.lws_version or current_lws_version()
    crd_names = (
        "leaderworkersets.leaderworkerset.x-k8s.io",
        "disaggregatedsets.disaggregatedset.x-k8s.io",
        "disaggregatedsetrolescalers.disaggregatedset.x-k8s.io",
    )
    crds = Operation(
        id="lws.crds",
        step="lws",
        title="Install the LeaderWorkerSet CRDs",
        scope="cluster",
        namespace=None,
        apply=OperationApply(
            kind="manifests_from_chart",
            manifests_source=ChartCRDSource(
                oci_ref=LWS_CHART,
                version=version,
                digest=None,
                subdir="crds",
                field_manager="lens",
            ),
            apply_options=ApplyOptions(server_side=True, force_conflicts=True, timeout_seconds=300),
            wait=tuple(
                OperationWait(kind="crd-established", target=f"crd/{name}", timeout_seconds=300) for name in crd_names
            ),
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "lws",
                    ("core.crds",),
                    resources=("customresourcedefinitions",),
                    verbs=("create", "update", "patch"),
                ),
                _named_crd_checks(crd_names, ("create", "update", "patch")),
                _read_checks(resources=("customresourcedefinitions",), scope="cluster"),
            )
        ),
        depends_on=("lws.namespace",),
    )

    controller = Operation(
        id="lws.controller",
        step="lws",
        title="Install the LeaderWorkerSet controller",
        scope="cluster",
        namespace=LWS_NAMESPACE,
        apply=OperationApply(
            kind="helm",
            argv=(
                "helm",
                "upgrade",
                "--install",
                LWS_RELEASE,
                LWS_CHART,
                "--version",
                version,
                "--namespace",
                LWS_NAMESPACE,
                "--create-namespace",
                "--skip-crds",
                "--wait",
                "--timeout",
                "300s",
                "--values",
                "-",
            ),
            stdin="enableDisaggregatedSet: true\n",
            namespace=LWS_NAMESPACE,
            wait=(
                OperationWait(
                    kind="helm",
                    target=LWS_RELEASE,
                    namespace=LWS_NAMESPACE,
                    timeout_seconds=300,
                ),
            ),
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "lws",
                    (
                        "stack.lws",
                        "core.rbac.escalation",
                        "core.rbac.namespaced",
                        "core.rbac.cluster",
                        "core.namespaces",
                        "core.admission",
                    ),
                    verbs=_ACCELERATOR_VERBS,
                ),
                _read_checks(resources=("deployments", "statefulsets"), scope="namespace"),
            )
        ),
        depends_on=("lws.crds", "lws.namespace"),
    )
    return [namespace, crds, controller]


def _needs_hf_secret_write(plan: ProvisioningPlan) -> bool:
    """Whether Lens owns creating the HF token Secret value."""

    return plan.hf_token_secret.token_source == "create-secret"  # noqa: S105 - token source value, not a credential


def _hf_namespace_metadata(namespace: str, cluster_id: str | None) -> dict[str, Any]:
    """Namespace metadata, labeled as Lens-owned only for a real cluster id.

    The plan has no cluster-id field. Ownership labels are written only when
    the caller supplies the cluster record's id; without it, adding just the
    managed-by label would make cleanup treat a shared namespace as owned.
    """

    metadata: dict[str, Any] = {"name": namespace}
    if cluster_id:
        metadata["labels"] = {**LENS_NAMESPACE_LABELS, CLUSTER_ID_LABEL: cluster_id}
    return metadata


def _hf_secret_namespace_operation(plan: ProvisioningPlan, *, cluster_id: str | None) -> Operation:
    namespace = plan.hf_token_secret.secret_namespace
    manifest = {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": _hf_namespace_metadata(namespace, cluster_id),
    }
    return Operation(
        id="hf-secret.namespace",
        step="hf-secret",
        title="Create the HF token namespace",
        scope="cluster",
        namespace=None,
        apply=OperationApply(kind="manifests", manifests=(manifest,), create_if_absent=True),
        requirement=OperationRequirement(
            checks=_checks_from_step(
                plan,
                "hf-secret",
                ("core.namespaces",),
                resources=("namespaces",),
            )
        ),
        # Namespace creation is synchronous; there is nothing to wait for.
    )


def _hf_secret_operation(plan: ProvisioningPlan, *, namespace_planned: bool) -> Operation:
    secret = plan.hf_token_secret
    manifest = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": secret.secret_name, "namespace": secret.secret_namespace},
        "type": "Opaque",
        # The executor replaces this placeholder in memory; a real token never
        # enters the plan, the catalog, logs or the Orchestration administrator script.
        "stringData": {"HF_TOKEN": HF_TOKEN_PLACEHOLDER},
    }
    return Operation(
        id="cache.hf-secret",
        step="hf-secret",
        title="Write the HF token Secret",
        scope="namespace",
        namespace=secret.secret_namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=(manifest,),
            namespace=secret.secret_namespace,
            secret_refs=(secret.secret_name,),
        ),
        requirement=OperationRequirement(
            checks=_checks_from_step(
                plan,
                "hf-secret",
                ("cache.hf-secret.create",),
                resources=("secrets",),
                scope="namespace",
                verbs=("get", "create", "patch"),
            )
        ),
        depends_on=("hf-secret.namespace",) if namespace_planned else (),
        user_owned_secrets=(secret.secret_name,),
        user_secret_fields=("HF_TOKEN",),
    )


def _images_namespace_operation(plan: ProvisioningPlan) -> Operation:
    namespace = plan.stack.images_namespace or IMAGES_NAMESPACE
    manifest = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}
    return Operation(
        id="images.namespace",
        step="prepull",
        title="Create the image pre-pull namespace",
        scope="cluster",
        namespace=None,
        apply=OperationApply(kind="manifests", manifests=(manifest,), create_if_absent=True),
        requirement=OperationRequirement(
            checks=_checks_from_step(
                plan,
                "prepull",
                ("core.namespaces",),
                resources=("namespaces",),
            )
        ),
        # Namespace creation is synchronous; there is nothing to wait for.
    )


def _images_prepull_operation(plan: ProvisioningPlan, *, namespace_planned: bool) -> Operation:
    namespace = plan.stack.images_namespace or IMAGES_NAMESPACE
    if plan.stack.images:
        # normalize_plan already trimmed/deduplicated these entries; use the
        # plan's explicit image set instead of the accelerator-derived default.
        image_set = list(plan.stack.images)
    else:
        image_set = prepull_images(
            [accelerator.vendor for accelerator in plan.accelerators],
            plan.gateway.provider or None,
            vllm_image=plan.stack.vllm_image,
        )
    manifest = yaml.safe_load(
        render_image_puller_daemonset(image_set, namespace=namespace, name=IMAGES_NAME, image=PULLER_IMAGE)
    )
    return Operation(
        id="images.prepull",
        step="prepull",
        title="Apply the image pre-pull DaemonSet",
        scope="namespace",
        namespace=namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=(manifest,),
            namespace=namespace,
            wait=(OperationWait(kind="rollout", target=f"daemonset/{IMAGES_NAME}", namespace=namespace),),
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "prepull",
                    ("cache.prepull",),
                    resources=("daemonsets",),
                    scope="namespace",
                    verbs=("get", "create", "update", "patch"),
                ),
                _read_checks(resources=("daemonsets",), scope="namespace"),
            )
        ),
        depends_on=("images.namespace",) if namespace_planned else (),
    )


def _topological_order(operations: list[Operation]) -> tuple[Operation, ...]:
    """Order operations so every dependency appears before its dependents."""

    by_id: dict[str, Operation] = {}
    for operation in operations:
        if operation.id in by_id:
            raise OperationDependencyError(f"duplicate operation id {operation.id!r}")
        by_id[operation.id] = operation

    unknown = sorted(
        {dependency for operation in operations for dependency in operation.depends_on if dependency not in by_id}
    )
    if unknown:
        raise OperationDependencyError(f"unknown operation dependencies: {', '.join(unknown)}")

    ordered: list[Operation] = []
    ordered_ids: set[str] = set()
    remaining = list(operations)
    while remaining:
        progressed = False
        for operation in list(remaining):
            if all(dependency in ordered_ids for dependency in operation.depends_on):
                ordered.append(operation)
                ordered_ids.add(operation.id)
                remaining.remove(operation)
                progressed = True
        if not progressed:
            pending = ", ".join(operation.id for operation in remaining)
            raise OperationDependencyError(f"dependency cycle among operations: {pending}")
    return tuple(ordered)


def _validate_operation_requirements(operations: list[Operation]) -> None:
    """Every non-lens operation needs checks, or the splitter would make it user-owned."""

    for operation in operations:
        if operation.executor == "lens" or operation.apply.kind == "lens":
            continue
        if not operation.requirement.checks:
            raise ValueError(f"operation {operation.id!r} has no permission checks")


def _storage_identity(
    plan: ProvisioningPlan,
    storage_volume: StorageVolume | None = None,
) -> tuple[str | None, str | None, str | None]:
    """``(volume_id, pvc_name, pv_name)`` for storage operations.

    A record is authoritative for an existing volume; otherwise the stable
    plan id derives the same ``prism-storage-<id>`` names.
    """

    if storage_volume is not None:
        derived = f"prism-storage-{storage_volume.id}"
        pv_name = None if storage_volume.kind == StorageVolumeKind.DYNAMIC_PVC else storage_volume.pv_name or derived
        return storage_volume.id, storage_volume.pvc_name or derived, pv_name
    volume_id = plan.storage.volume_id
    if not volume_id:
        # An old plan may predate the stable identity; callers must not derive
        # names like ``prism-storage-None``.
        return None, None, None
    name = f"prism-storage-{volume_id}"
    pv_name = None if plan.storage.kind == "dynamic-pvc" else name
    return volume_id, name, pv_name


_INTEL_DRA_NAMESPACE = "intel-gpu-resource-driver"
_INTEL_DRA_DAEMONSET = "intel-gpu-resource-driver-kubelet-plugin"
_INTEL_NODE_LABEL_FALLBACK = "intel.feature.node.kubernetes.io/gpu=true"
_NFD_NAMESPACE = "node-feature-discovery"
_NFD_RULES_CRD = "nodefeaturerules.nfd.k8s-sigs.io"


def _lookup_hardware_profile(key: str) -> HardwareProfile | None:
    try:
        return get_profile(key)
    except HardwareProfileNotFoundError:
        return resolve_by_accelerator_key(key)


def _accelerator_profile(accelerator: AcceleratorPlan) -> HardwareProfile | None:
    return _lookup_hardware_profile(accelerator.profile or accelerator.vendor)


def _accelerator_unit_ids(plan: ProvisioningPlan, accelerator: AcceleratorPlan) -> tuple[str, ...]:
    selected = set(step_units(plan, "gpu"))
    unit_ids = {f"accelerator.{accelerator.vendor}"}
    for requirement in accelerator.rbac:
        unit_ids.add(f"core.rbac.{requirement}")
    if accelerator.vendor == "nvidia":
        unit_ids.add("core.namespaces")
        unit_ids.add("core.rbac.namespaced")
        if accelerator.mode == "dra":
            unit_ids.add("core.admission")
    elif accelerator.vendor == "intel":
        unit_ids.add("core.admission")
        unit_ids.add("core.namespaces")
    return tuple(sorted(unit for unit in unit_ids if unit in selected))


def _intel_node_label_selector(accelerators: list[AcceleratorPlan]) -> tuple[str, int]:
    profile = _accelerator_profile(accelerators[0]) if accelerators else None
    presence = profile.presence if profile is not None else None
    selector = dict(presence.node_label_selector) if presence is not None else {}
    selector = selector or {"intel.feature.node.kubernetes.io/gpu": "true"}
    timeout = int(presence.timeout_seconds) if presence is not None else 90
    return ",".join(f"{key}={value}" for key, value in selector.items()), timeout


def _intel_nfd_operations(plan: ProvisioningPlan, intel_items: list[AcceleratorPlan]) -> list[Operation]:
    profile = _accelerator_profile(intel_items[0])
    driver = profile.driver if profile is not None else None
    refs = tuple(driver.nfd_manifest_refs) if driver is not None else ()
    if not refs:
        return []

    base_checks = _combine_checks(
        _unit_checks("core.namespaces", resources=("namespaces",), verbs=("get", "create", "patch")),
        _unit_checks(
            "core.crds",
            resources=("customresourcedefinitions",),
            verbs=("get", "create", "update", "patch"),
        ),
        _unit_checks(
            "core.workloads",
            resources=("daemonsets", "deployments"),
            verbs=("get", "create", "update", "patch"),
        ),
        _checks_from_step(
            plan,
            "gpu",
            ("accelerator.intel",),
            resources=("serviceaccounts", "configmaps"),
            verbs=("get", "create", "update", "patch"),
        ),
        _unit_checks(
            "core.rbac.namespaced",
            resources=("roles", "rolebindings"),
            verbs=("get", "create", "update", "patch"),
        ),
        _unit_checks(
            "core.rbac.cluster",
            resources=("clusterroles", "clusterrolebindings"),
            verbs=("get", "create", "update", "patch"),
        ),
        _read_checks(resources=("customresourcedefinitions",), scope="cluster"),
        _read_checks(
            resources=("daemonsets", "deployments", "serviceaccounts", "configmaps"),
            scope="namespace",
        ),
    )
    rules_checks = _combine_checks(
        _checks_from_step(
            plan,
            "gpu",
            ("accelerator.intel",),
            resources=("nodefeaturerules",),
            verbs=("get", "create", "update", "patch"),
        ),
        # The node-label wait lists nodes cluster-wide.
        _read_checks(resources=("nodes",), scope="cluster"),
    )
    selector, timeout = _intel_node_label_selector(intel_items)

    operations: list[Operation] = []
    for index, ref in enumerate(refs):
        operation_id = (
            "accelerator.nfd" if index == 0 else "accelerator.nfd.rules" if index == 1 else f"accelerator.nfd.{index}"
        )
        checks = base_checks if index == 0 else rules_checks
        waits: list[OperationWait] = []
        if index == 0:
            # The NFD base owns the NodeFeature* CRDs; wait before applying the
            # NodeFeatureRule overlay in the next command.
            waits.append(
                OperationWait(
                    kind="crd-established",
                    target=f"crd/{_NFD_RULES_CRD}",
                    timeout_seconds=60,
                )
            )
        if index == len(refs) - 1:
            waits.append(OperationWait(kind="node-label", target=selector, timeout_seconds=timeout))
        operations.append(
            Operation(
                id=operation_id,
                step="gpu",
                title="Install Node Feature Discovery" if index == 0 else "Apply Intel GPU NodeFeatureRules",
                scope="cluster",
                namespace=_NFD_NAMESPACE,
                apply=OperationApply(
                    kind="command",
                    argv=("kubectl", "apply", "-k", ref),
                    namespace=_NFD_NAMESPACE,
                    wait=tuple(waits),
                ),
                requirement=OperationRequirement(checks=checks),
                depends_on=(operations[-1].id,) if operations else (),
                # Remote NFD Kustomize overlays may apply objects outside a
                # statically verified namespace; require a cluster-wide wildcard
                # (*/*/*) SSAR grant for direct execution, falling back to admin.
                admin_only=False,
                requires_cluster_wildcard=True,
            )
        )
    return operations


def _nvidia_values(mode: object, access_mode: str) -> str:
    options = dict(getattr(mode, "options", {}) or {})
    values: dict[str, Any] = {}
    if access_mode == "dra":
        # Required by the 25.8.0 chart's validation; without it `helm upgrade`
        # rejects the release even though the default is intended.
        values["gpuResourcesEnabledOverride"] = True
    if options.get("nfd_enabled"):
        values["nfd"] = {"enabled": True}
    if options.get("gfd_enabled"):
        values["gfd"] = {"enabled": True}
    if options.get("device_plugin_all_nodes"):
        values["failOnInitError"] = False
        values["affinity"] = None
    runtime_class = options.get("runtime_class_name")
    if runtime_class:
        values["runtimeClassName"] = str(runtime_class)
    return yaml.safe_dump(values, sort_keys=False)


def _intel_dra_values(mode: object) -> str:
    options = dict(getattr(mode, "options", {}) or {})
    kubelet_plugin: dict[str, Any] = {}
    if "privileged" in options:
        kubelet_plugin["privileged"] = bool(options["privileged"])
    if "health_monitoring_enabled" in options:
        kubelet_plugin["healthMonitoring"] = {"enabled": bool(options["health_monitoring_enabled"])}
    node_selector = options.get("node_selector")
    if isinstance(node_selector, dict) and node_selector:
        kubelet_plugin["nodeSelector"] = {str(k): str(v) for k, v in node_selector.items()}
    values: dict[str, Any] = {}
    if kubelet_plugin:
        values["kubeletPlugin"] = kubelet_plugin
    return yaml.safe_dump(values, sort_keys=False)


def _nvidia_driver_operation(
    plan: ProvisioningPlan,
    accelerator: AcceleratorPlan,
    index: int,
) -> Operation | None:
    profile = _accelerator_profile(accelerator)
    driver = profile.driver if profile is not None else None
    mode = driver.mode(accelerator.mode) if driver is not None else None
    if mode is None or not mode.manifest_ref:
        return None

    if accelerator.mode == "dra":
        namespace, release, daemonset = NVIDIA_DRA_NAMESPACE, NVIDIA_DRA_RELEASE, NVIDIA_DRA_DAEMONSET
    else:
        namespace, release, daemonset = NVIDIA_PLUGIN_NAMESPACE, NVIDIA_PLUGIN_RELEASE, NVIDIA_PLUGIN_DAEMONSET
    argv = [
        "helm",
        "upgrade",
        "--install",
        release,
        mode.manifest_ref,
        "--namespace",
        namespace,
        "--create-namespace",
    ]
    if mode.repo:
        argv += ["--repo", mode.repo]
    if mode.chart_version:
        argv += ["--version", mode.chart_version]
    argv += ["--values", "-"]
    skip_target = _driver_status_target(mode.daemonset_matchers) if mode.daemonset_matchers else None

    return Operation(
        id=f"accelerator.nvidia.{accelerator.mode}.{index}",
        step="gpu",
        title=f"Install the NVIDIA {accelerator.mode} driver",
        scope="cluster",
        namespace=namespace,
        apply=OperationApply(
            kind="helm",
            argv=tuple(argv),
            stdin=_nvidia_values(mode, accelerator.mode),
            namespace=namespace,
            wait=(
                OperationWait(
                    kind="rollout",
                    target=f"daemonset/{daemonset}",
                    namespace=namespace,
                ),
            ),
            skip_if_driver_ready=skip_target,
        ),
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "gpu",
                    _accelerator_unit_ids(plan, accelerator),
                    verbs=_ACCELERATOR_VERBS,
                ),
                # Rollout status reads the chart DaemonSet in its namespace.
                _read_checks(resources=("daemonsets",), scope="namespace"),
            )
        ),
    )


def _driver_status_target(matchers) -> str:
    """Serialize profile DaemonSet matchers for a ``driver-status`` wait.

    ``;`` separates OR matchers; ``,`` separates key/value inside one matcher.
    Keys/values are profile-controlled and must not contain those separators.
    Readiness mirrors ``driver_status``: at least one matching DaemonSet has
    ``desiredNumberScheduled > 0`` and ``numberReady >= desired``.
    """

    groups: list[str] = []
    for matcher in matchers:
        pairs: list[str] = []
        for key, value in matcher.items():
            key_text, value_text = str(key), str(value)
            if any(separator in key_text or separator in value_text for separator in (",", ";")):
                raise ValueError(f"driver-status matcher contains a reserved separator: {matcher!r}")
            pairs.append(f"{key_text}={value_text}")
        groups.append(",".join(pairs))
    return ";".join(groups)


def _intel_driver_operation(
    plan: ProvisioningPlan,
    accelerator: AcceleratorPlan,
    index: int,
    nfd_ids: tuple[str, ...],
) -> Operation | None:
    profile = _accelerator_profile(accelerator)
    driver = profile.driver if profile is not None else None
    mode = driver.mode(accelerator.mode) if driver is not None else None
    if mode is None or not mode.manifest_ref:
        return None

    is_kustomize_overlay = not bool(mode.chart_version)
    skip_target = _driver_status_target(mode.daemonset_matchers) if mode.daemonset_matchers else None
    waits: tuple[OperationWait, ...] = ()
    if is_kustomize_overlay:
        presence = profile.presence if profile is not None else None
        timeout = int(presence.timeout_seconds) if presence is not None else 90
        waits = (
            OperationWait(
                kind="driver-status",
                target=_driver_status_target(mode.daemonset_matchers),
                timeout_seconds=timeout,
            ),
        )
    else:
        waits = (
            OperationWait(
                kind="rollout",
                target=f"daemonset/{_INTEL_DRA_DAEMONSET}",
                namespace=_INTEL_DRA_NAMESPACE,
            ),
        )

    namespace = None if is_kustomize_overlay else _INTEL_DRA_NAMESPACE
    if not is_kustomize_overlay:
        target_namespace = namespace or _INTEL_DRA_NAMESPACE
        argv = [
            "helm",
            "upgrade",
            "--install",
            _INTEL_DRA_NAMESPACE,
            mode.manifest_ref,
            "--namespace",
            target_namespace,
            "--create-namespace",
        ]
        if mode.repo:
            argv += ["--repo", mode.repo]
        argv += ["--version", mode.chart_version, "--values", "-"]
        apply = OperationApply(
            kind="helm",
            argv=tuple(argv),
            stdin=_intel_dra_values(mode),
            namespace=target_namespace,
            wait=waits,
            skip_if_driver_ready=skip_target,
        )
    else:
        apply = OperationApply(
            kind="command",
            argv=("kubectl", "apply", "-k", mode.manifest_ref),
            namespace=namespace,
            wait=waits,
            skip_if_driver_ready=skip_target,
        )
    return Operation(
        id=f"accelerator.intel.{accelerator.mode}.{index}",
        step="gpu",
        title=f"Install the Intel {accelerator.mode} driver",
        scope="cluster",
        namespace=namespace,
        apply=apply,
        requirement=OperationRequirement(
            checks=_combine_checks(
                _checks_from_step(
                    plan,
                    "gpu",
                    _accelerator_unit_ids(plan, accelerator),
                    verbs=_ACCELERATOR_VERBS,
                ),
                # Client-side apply reads the objects it patches.
                _read_checks(
                    resources=("daemonsets", "deployments", "serviceaccounts", "configmaps"),
                    scope="namespace",
                ),
                # Remote Kustomize overlays probe DaemonSets across namespaces;
                # Helm chart modes only read their own namespace.
                _read_checks(
                    resources=("daemonsets",),
                    scope="cluster" if is_kustomize_overlay else "namespace",
                ),
            )
        ),
        depends_on=nfd_ids,
        # Remote Kustomize overlays have no verified fixed namespace; allow
        # direct execution only when the cluster-wide wildcard (*/*/*) SSAR
        # check succeeds, falling back to admin otherwise.
        admin_only=False,
        requires_cluster_wildcard=is_kustomize_overlay,
    )


def _accelerator_operations(plan: ProvisioningPlan) -> list[Operation]:
    if not plan.accelerators:
        return []

    intel_items = [accelerator for accelerator in plan.accelerators if accelerator.vendor == "intel"]
    nfd_operations = _intel_nfd_operations(plan, intel_items) if intel_items else []
    nfd_ids = tuple(operation.id for operation in nfd_operations)

    operations = list(nfd_operations)
    counts: dict[tuple[str, str], int] = {}
    for accelerator in plan.accelerators:
        key = (accelerator.vendor, accelerator.mode)
        index = counts.get(key, 0)
        counts[key] = index + 1
        operation: Operation | None = None
        if accelerator.vendor == "nvidia":
            operation = _nvidia_driver_operation(plan, accelerator, index)
        elif accelerator.vendor == "intel":
            operation = _intel_driver_operation(plan, accelerator, index, nfd_ids)
        if operation is not None:
            operations.append(operation)
    return operations


def _storage_volume_from_plan(plan: ProvisioningPlan, *, volume_id: str, cluster_id: str | None) -> StorageVolume:
    """A non-persisted DTO so storage manifests come from the same renderers."""

    storage = plan.storage
    values: dict[str, Any] = {
        "id": volume_id,
        "cluster_id": cluster_id or "",
        "name": (plan.model_cache.storage_volume_ref or volume_id),
        "kind": storage.kind,
        "capacity": storage.capacity or "",
        "read_only": storage.read_only,
        "purposes": storage.purposes,
    }
    if storage.kind == "local-disk":
        values["local_disk"] = LocalDiskSpec(hostPath=storage.host_path or "", namespace=storage.namespace)
    elif storage.kind == "nfs":
        values["nfs"] = NfsSpec(
            server=storage.nfs_server or "",
            path=storage.nfs_path or "",
            namespace=storage.namespace,
        )
    elif storage.kind == "dynamic-pvc":
        values["dynamic_pvc"] = DynamicPvcSpec(
            storageClass=storage.storage_class or "",
            namespace=storage.namespace or "",
            accessMode=storage.access_mode or "ReadWriteOnce",
        )
    return StorageVolume(**values)


def _storage_operations(
    plan: ProvisioningPlan,
    *,
    cluster_id: str | None,
    storage_volume: StorageVolume | None,
) -> list[Operation]:
    if plan.storage.kind == "none":
        return []
    from llm_d_lens.storage.service import pv_manifest, pvc_manifest, pvc_namespace  # noqa: PLC0415

    volume_id, pvc_name, pv_name = _storage_identity(plan, storage_volume)
    if volume_id is None or pvc_name is None:
        raise OperationDependencyError("storage volume identity is missing for a configured storage plan")

    volume = storage_volume or _storage_volume_from_plan(plan, volume_id=volume_id, cluster_id=cluster_id)
    namespace = pvc_namespace(volume)
    namespace_planned = plan.storage.namespace_mode == "create"
    static = volume.kind in (StorageVolumeKind.LOCAL_DISK, StorageVolumeKind.NFS)

    operations: list[Operation] = []
    if namespace_planned:
        manifest = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}
        operations.append(
            Operation(
                id="storage.namespace",
                step="storage",
                title="Create the storage namespace",
                scope="cluster",
                namespace=None,
                apply=OperationApply(kind="manifests", manifests=(manifest,), create_if_absent=True),
                requirement=OperationRequirement(
                    checks=_checks_from_step(
                        plan,
                        "storage",
                        ("core.namespaces",),
                        resources=("namespaces",),
                    )
                ),
                # Namespace creation is synchronous; there is nothing to wait for.
            )
        )

    if static:
        pv = pv_manifest(volume, name=pv_name, pvc_name=pvc_name, namespace=namespace)
        if pv is not None:
            operations.append(
                Operation(
                    id="storage.pv",
                    step="storage",
                    title="Create the static storage PersistentVolume",
                    scope="cluster",
                    namespace=None,
                    apply=OperationApply(kind="manifests", manifests=(pv,)),
                    requirement=OperationRequirement(
                        checks=_checks_from_step(
                            plan,
                            "storage",
                            ("storage.pv",),
                            resources=("persistentvolumes",),
                            verbs=("get", "create", "patch"),
                        )
                    ),
                    # A PV can be applied before its namespace exists; claimRef
                    # does not require the namespace object.
                )
            )

    pvc = pvc_manifest(volume, name=pvc_name, namespace=namespace, pv_name=pv_name)
    pvc_dependencies: list[str] = []
    if namespace_planned:
        pvc_dependencies.append("storage.namespace")
    if static:
        pvc_dependencies.append("storage.pv")
    operations.append(
        Operation(
            id="storage.pvc",
            step="storage",
            title="Create the storage PersistentVolumeClaim",
            scope="namespace",
            namespace=namespace,
            apply=OperationApply(
                kind="manifests",
                manifests=(pvc,),
                namespace=namespace,
                wait=(
                    OperationWait(
                        kind="pvc-bound",
                        target=f"pvc/{pvc_name}",
                        namespace=namespace,
                    ),
                ),
            ),
            requirement=OperationRequirement(
                checks=_checks_from_step(
                    plan,
                    "storage",
                    ("storage.pvc",),
                    resources=("persistentvolumeclaims",),
                    verbs=("get", "create", "patch"),
                )
            ),
            depends_on=tuple(pvc_dependencies),
        )
    )
    return operations


def _model_cache_volume_and_namespace(
    plan: ProvisioningPlan,
    *,
    cluster_id: str | None,
    storage_volume: StorageVolume | None,
) -> tuple[StorageVolume, str, str, str]:
    volume_id, pvc_name, pv_name = _storage_identity(plan, storage_volume)
    if volume_id is None or pvc_name is None:
        raise OperationDependencyError("model cache storage identity is missing")
    volume = storage_volume or _storage_volume_from_plan(plan, volume_id=volume_id, cluster_id=cluster_id)
    volume = volume.model_copy(update={"pvc_name": pvc_name, "pv_name": pv_name})
    return volume, volume_id, pvc_name, pv_name


def _model_cache_token_copy_needed(plan: ProvisioningPlan, target_namespace: str) -> bool:
    secret = plan.hf_token_secret
    return not (secret.secret_namespace == target_namespace and secret.secret_name == MODEL_CACHE_TOKEN_SECRET)


def _model_cache_token_secret_operation(
    plan: ProvisioningPlan,
    *,
    cluster_id: str | None,
    storage_volume: StorageVolume | None,
) -> Operation | None:
    if not plan.model_cache.enabled:
        return None
    from llm_d_lens.storage.service import pvc_namespace  # noqa: PLC0415

    token_source = plan.hf_token_secret.token_source
    if not (
        token_source == "create-secret"  # noqa: S105 - token source value, not a credential
        or token_source.startswith("existing-secret:")
    ):
        return None

    volume, _volume_id, _pvc_name, _pv_name = _model_cache_volume_and_namespace(
        plan,
        cluster_id=cluster_id,
        storage_volume=storage_volume,
    )
    target_namespace = pvc_namespace(volume)
    secret = plan.hf_token_secret
    target_name = MODEL_CACHE_TOKEN_SECRET
    if not _model_cache_token_copy_needed(plan, target_namespace):
        return None
    manifest = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": target_name, "namespace": target_namespace},
        "type": "Opaque",
        "stringData": {"HF_TOKEN": HF_TOKEN_PLACEHOLDER},
    }
    dependencies: list[str] = []
    if _needs_hf_secret_write(plan):
        dependencies.append("cache.hf-secret")
    if plan.storage.namespace_mode == "create":
        dependencies.append("storage.namespace")
    checks = _combine_checks(
        (
            CheckRule(
                verb="get",
                api_group="",
                resource="secrets",
                scope="namespace",
                name=secret.secret_name,
                namespace=secret.secret_namespace,
            ),
        ),
        tuple(
            CheckRule(
                verb=verb,
                api_group="",
                resource="secrets",
                scope="namespace",
                name=target_name,
                namespace=target_namespace,
            )
            for verb in ("get", "create", "update", "patch")
        ),
    )
    secret_refs = tuple(dict.fromkeys((secret.secret_name, target_name)))
    return Operation(
        id="model-cache.token-secret",
        step="model-cache",
        title="Copy the HF token into the model-cache namespace",
        scope="namespace",
        namespace=target_namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=(manifest,),
            namespace=target_namespace,
            secret_refs=secret_refs,
            secret_copy=SecretCopy(
                source_namespace=secret.secret_namespace,
                source_name=secret.secret_name,
                target_namespace=target_namespace,
                target_name=target_name,
                key="HF_TOKEN",
            ),
        ),
        requirement=OperationRequirement(checks=checks),
        depends_on=tuple(dependencies),
        user_owned_secrets=(target_name,),
        user_secret_fields=("HF_TOKEN",),
    )


def _model_cache_job_operation(
    plan: ProvisioningPlan,
    *,
    cluster_id: str | None,
    storage_volume: StorageVolume | None,
) -> Operation | None:
    if not plan.model_cache.enabled:
        return None
    # Lazy imports break model_cache -> storage -> db -> cluster -> operations
    # -> model_cache/storage at module load time.
    from llm_d_lens.model_cache.jobs import (  # noqa: PLC0415
        PLAN_HASH_LABEL,
        model_cache_download_command,
        model_cache_job_manifest,
        model_cache_job_name,
    )
    from llm_d_lens.storage.service import pvc_namespace  # noqa: PLC0415

    volume, volume_id, pvc_name, pv_name = _model_cache_volume_and_namespace(
        plan,
        cluster_id=cluster_id,
        storage_volume=storage_volume,
    )
    if not plan.model_cache.entry_id:
        raise OperationDependencyError("model cache entry identity is missing for an enabled cache plan")
    repo_id = plan.model_cache.repo_id or ""
    revision = plan.model_cache.revision or "main"
    secret = plan.hf_token_secret
    entry = ModelCacheEntry(
        id=plan.model_cache.entry_id,
        cluster_id=cluster_id or "",
        storage_volume_id=volume_id,
        source=ModelSource(
            kind=ModelSourceKind.HUGGINGFACE,
            huggingface=HuggingFaceSource(repo_id=repo_id, revision=revision),
        ),
        token_source=TokenSource(
            mode=TokenSourceMode.EXISTING_SECRET,
            namespace=secret.secret_namespace,
            name=secret.secret_name,
        ),
        cache_path=hf_cache_path(repo_id),
    )
    namespace = pvc_namespace(volume)
    current_plan_hash16 = plan_hash16(plan)
    job_name = model_cache_job_name(entry, node="*", action="download")
    token_secret_needed = _model_cache_token_copy_needed(plan, namespace)
    dependencies = ["storage.pvc"]
    if token_secret_needed:
        dependencies.append("model-cache.token-secret")
    elif _needs_hf_secret_write(plan):
        dependencies.append("cache.hf-secret")
    checks = _combine_checks(
        tuple(
            CheckRule(verb=verb, api_group="batch", resource="jobs", scope="namespace")
            for verb in ("get", "list", "watch", "create", "update", "patch", "delete")
        ),
        tuple(
            CheckRule(verb=verb, api_group="", resource="pods", scope="namespace") for verb in ("get", "list", "watch")
        ),
        (
            CheckRule(
                verb="get",
                api_group="",
                resource="secrets",
                scope="namespace",
                name=MODEL_CACHE_TOKEN_SECRET,
                namespace=namespace,
            ),
        ),
    )
    if volume.kind == StorageVolumeKind.LOCAL_DISK:
        # A local-disk cache lives on every node. Lens enumerates the
        # ready+schedulable nodes at execution time and fans out one stable,
        # node-selected Job per node, then waits for all of them.
        local_disk_checks = (
            (
                (
                    CheckRule(
                        verb="get",
                        api_group="",
                        resource="secrets",
                        scope="namespace",
                        name=secret.secret_name,
                        namespace=secret.secret_namespace,
                    ),
                )
                if secret.secret_namespace and secret.secret_name
                else ()
            ),
            tuple(
                CheckRule(
                    verb=verb,
                    api_group="",
                    resource="secrets",
                    scope="namespace",
                    name=MODEL_CACHE_TOKEN_SECRET,
                    namespace=namespace,
                )
                for verb in ("get", "create", "update", "patch")
            ),
        )
        return Operation(
            id="model-cache.job",
            step="model-cache",
            title="Download the model cache on every node",
            scope="namespace",
            namespace=namespace,
            apply=OperationApply(
                kind="lens",
                namespace=namespace,
                apply_options=ApplyOptions(delete_before_apply=True),
                inject_proxy_env=True,
                wait=(
                    OperationWait(
                        kind="job-complete",
                        target=(
                            "jobs-by-label/"
                            f"prism.ai/model-cache-entry-id={plan.model_cache.entry_id},"
                            "prism.ai/model-cache-action=download,"
                            f"{PLAN_HASH_LABEL}={current_plan_hash16}"
                        ),
                        namespace=namespace,
                    ),
                ),
            ),
            requirement=OperationRequirement(checks=_combine_checks(checks, *local_disk_checks)),
            depends_on=tuple(dependencies),
            user_owned_secrets=(MODEL_CACHE_TOKEN_SECRET,),
            executor="lens",
            lens_action="model-cache-jobs",
        )

    manifest = model_cache_job_manifest(
        entry,
        volume,
        node="*",
        command=model_cache_download_command(entry),
        action="download",
        include_proxy_env=False,
        plan_hash=current_plan_hash16,
    )
    return Operation(
        id="model-cache.job",
        step="model-cache",
        title="Download the model cache",
        scope="namespace",
        namespace=namespace,
        apply=OperationApply(
            kind="manifests",
            manifests=(manifest,),
            namespace=namespace,
            apply_options=ApplyOptions(delete_before_apply=True),
            inject_proxy_env=True,
            wait=(
                OperationWait(
                    kind="job-complete",
                    target=f"job/{job_name}",
                    namespace=namespace,
                ),
            ),
        ),
        requirement=OperationRequirement(checks=checks),
        depends_on=tuple(dependencies),
        user_owned_secrets=(MODEL_CACHE_TOKEN_SECRET,),
    )


def _ns_checks(
    resources: tuple[str, ...],
    *,
    api_group: str,
    verbs: tuple[str, ...],
    namespace: str,
) -> tuple[CheckRule, ...]:
    return tuple(
        CheckRule(verb=verb, api_group=api_group, resource=resource, scope="namespace", namespace=namespace)
        for resource in resources
        for verb in verbs
    )


def _cluster_checks(
    resources: tuple[str, ...],
    *,
    api_group: str,
    verbs: tuple[str, ...],
) -> tuple[CheckRule, ...]:
    return tuple(
        CheckRule(verb=verb, api_group=api_group, resource=resource, scope="cluster")
        for resource in resources
        for verb in verbs
    )


def _monitoring_operations(plan: ProvisioningPlan) -> list[Operation]:
    from llm_d_lens.monitoring.accelerator.registry import (  # noqa: PLC0415
        get_registered_provider,
        provider_id_for_profile,
    )
    from llm_d_lens.monitoring.cluster_stack.service import (  # noqa: PLC0415
        KUBE_PROMETHEUS_STACK_RELEASE,
        render_accelerator_exporter_script,
        render_metrics_reader_rbac_script,
        render_monitoring_stack_script,
    )

    monitoring = plan.monitoring
    monitoring_ns = monitoring.namespace or MONITORING_NAMESPACE
    operations: list[Operation] = []

    if monitoring.mode == "managed":
        auto_discovered = set(monitoring.auto_discovered)
        prom_node_port = None if "prometheusNodePort" in auto_discovered else monitoring.prometheus_node_port
        graf_node_port = None if "grafanaNodePort" in auto_discovered else monitoring.grafana_node_port
        stack_checks = _combine_checks(
            _cluster_checks(("namespaces",), api_group="", verbs=("get", "create", "patch")),
            _cluster_checks(("nodes",), api_group="", verbs=("get", "list")),
            _cluster_checks(
                ("customresourcedefinitions",),
                api_group="apiextensions.k8s.io",
                verbs=("get", "list", "watch", "create", "update", "patch"),
            ),
            _cluster_checks(
                ("clusterroles", "clusterrolebindings"),
                api_group="rbac.authorization.k8s.io",
                verbs=("get", "create", "update", "patch", "bind", "escalate"),
            ),
            _ns_checks(
                ("deployments", "daemonsets", "statefulsets"),
                api_group="apps",
                verbs=("get", "list", "watch", "create", "update", "patch"),
                namespace=monitoring_ns,
            ),
            _ns_checks(
                ("services", "configmaps", "secrets", "serviceaccounts"),
                api_group="",
                verbs=("get", "list", "watch", "create", "update", "patch"),
                namespace=monitoring_ns,
            ),
            _ns_checks(
                ("servicemonitors", "podmonitors", "prometheusrules", "prometheuses"),
                api_group="monitoring.coreos.com",
                verbs=("get", "list", "watch", "create", "update", "patch"),
                namespace=monitoring_ns,
            ),
        )
        operations.append(
            Operation(
                id="monitoring.stack",
                step="monitoring",
                title="Install the cluster monitoring stack (Prometheus & Grafana)",
                scope="cluster",
                namespace=monitoring_ns,
                apply=OperationApply(
                    kind="command",
                    argv=("bash", "-s"),
                    stdin=render_monitoring_stack_script(
                        namespace=monitoring_ns,
                        release=KUBE_PROMETHEUS_STACK_RELEASE,
                        prometheus_node_port=prom_node_port,
                        grafana_node_port=graf_node_port,
                    ),
                    namespace=monitoring_ns,
                    apply_options=ApplyOptions(timeout_seconds=900),
                ),
                requirement=OperationRequirement(checks=stack_checks),
                depends_on=(),
                executor="auto",
                admin_only=False,
            )
        )
    elif monitoring.install_accelerator_exporters:
        rbac_checks = _combine_checks(
            _cluster_checks(
                ("clusterroles", "clusterrolebindings"),
                api_group="rbac.authorization.k8s.io",
                verbs=("get", "create", "update", "patch", "bind", "escalate"),
            ),
            _ns_checks(
                ("prometheuses",),
                api_group="monitoring.coreos.com",
                verbs=("get", "list"),
                namespace=monitoring_ns,
            ),
        )
        operations.append(
            Operation(
                id="monitoring.rbac",
                step="monitoring",
                title="Ensure Prometheus metrics-reader RBAC",
                scope="cluster",
                namespace=monitoring_ns,
                apply=OperationApply(
                    kind="command",
                    argv=("bash", "-s"),
                    stdin=render_metrics_reader_rbac_script(monitoring_namespace=monitoring_ns),
                    namespace=monitoring_ns,
                    apply_options=ApplyOptions(timeout_seconds=120),
                ),
                requirement=OperationRequirement(checks=rbac_checks),
                depends_on=(),
                executor="auto",
                admin_only=False,
            )
        )

    if monitoring.install_accelerator_exporters and plan.accelerators:
        modes_by_provider: dict[str, set[str]] = {}
        providers_by_id: dict[str, Any] = {}
        for accelerator in plan.accelerators:
            profile = _accelerator_profile(accelerator)
            provider_id = provider_id_for_profile(profile)
            if not provider_id:
                continue
            provider = get_registered_provider(provider_id)
            if provider is None:
                continue
            providers_by_id[provider_id] = provider
            modes_by_provider.setdefault(provider_id, set()).add(accelerator.mode)

        for provider_id in sorted(providers_by_id):
            provider = providers_by_id[provider_id]
            cap = provider.capability()
            selected_modes = modes_by_provider[provider_id]
            mode = next((candidate for candidate in cap.access_modes if candidate in selected_modes), None)
            if mode is None and selected_modes:
                mode = sorted(selected_modes)[0]

            exporter_checks = _combine_checks(
                _cluster_checks(("namespaces",), api_group="", verbs=("get", "create", "patch")),
                _cluster_checks(("daemonsets",), api_group="apps", verbs=("get", "list")),
                _cluster_checks(("customresourcedefinitions",), api_group="apiextensions.k8s.io", verbs=("get",)),
                _cluster_checks(("nodes",), api_group="", verbs=("get", "list", "patch")),
                _ns_checks(
                    ("daemonsets",),
                    api_group="apps",
                    verbs=("get", "list", "watch", "create", "update", "patch"),
                    namespace=cap.default_namespace,
                ),
                _ns_checks(
                    ("services", "configmaps", "secrets", "serviceaccounts"),
                    api_group="",
                    verbs=("get", "list", "watch", "create", "update", "patch"),
                    namespace=cap.default_namespace,
                ),
                _ns_checks(
                    ("servicemonitors",),
                    api_group="monitoring.coreos.com",
                    verbs=("get", "list", "watch", "create", "update", "patch"),
                    namespace=cap.default_namespace,
                ),
                _ns_checks(
                    ("configmaps",),
                    api_group="",
                    verbs=("get", "create", "update", "patch"),
                    namespace=monitoring_ns,
                ),
            )
            operations.append(
                Operation(
                    id=f"monitoring.accelerator.{provider_id}",
                    step="monitoring",
                    title=f"Install {cap.display_name} metrics exporter ({cap.release_name})",
                    scope="cluster",
                    namespace=cap.default_namespace,
                    apply=OperationApply(
                        kind="command",
                        argv=("bash", "-s"),
                        stdin=render_accelerator_exporter_script(
                            provider_id,
                            access_mode=mode,
                            monitoring_namespace=monitoring_ns,
                            existing_monitoring=(monitoring.mode == "existing"),
                        ),
                        namespace=cap.default_namespace,
                        apply_options=ApplyOptions(timeout_seconds=600),
                    ),
                    requirement=OperationRequirement(checks=exporter_checks),
                    # Depend only on monitoring.stack (never on driver ops) so partial
                    # RBAC permutations cannot introduce an admin -> user edge.
                    depends_on=("monitoring.stack",) if monitoring.mode == "managed" else (),
                    executor="auto",
                    admin_only=False,
                )
            )

    verify_depends_on = tuple(operation.id for operation in operations)
    operations.append(
        Operation(
            id="monitoring.verify",
            step="monitoring",
            title="Verify Prometheus monitoring health",
            scope="cluster",
            namespace=monitoring_ns,
            apply=OperationApply(kind="lens", namespace=monitoring_ns),
            requirement=OperationRequirement(checks=()),
            depends_on=verify_depends_on,
            executor="lens",
            lens_action="monitoring-verify",
        )
    )
    return operations


def build_operations(
    plan: ProvisioningPlan,
    *,
    cluster_id: str | None = None,
    storage_volume: StorageVolume | None = None,
) -> tuple[Operation, ...]:
    """Expand a normalized plan into operations in dependency order.

    ``cluster_id`` comes from the cluster record at the call site. It is
    optional so the catalog stays plan-only, but ownership labels are written
    only when it is supplied.
    """

    namespace_planned = plan.gateway.namespace_mode == "create"
    operations: list[Operation] = []
    if namespace_planned:
        operations.append(_gateway_namespace_operation(plan))
    if plan.runtime.inotify_enabled:
        operations.append(_inotify_operation(plan, gateway_namespace_planned=namespace_planned))
    # GKE provides the Gateway API through its managed control plane and the
    # existing capability projection has no CRD-install unit for it. Applying
    # the pinned bundles with an empty check set would let M2 treat a
    # cluster-scoped write as user-owned, so GKE has no ``gateway.crds``;
    # explicit llm-d CRDs belong to the later ``stack.crds`` operation.
    if plan.gateway.provider and plan.gateway.provider != "gke":
        operations.append(_gateway_crds_operation(plan))
    operations.extend(_gateway_operations(plan, cluster_id=cluster_id))
    stack_crds = _stack_crds_operation(plan)
    if stack_crds is not None:
        operations.append(stack_crds)
    if _needs_hf_secret_write(plan):
        hf_namespace_planned = (
            plan.hf_token_secret.secret_namespace_mode == "create"  # noqa: S105 - namespace mode value
        )
        if hf_namespace_planned:
            operations.append(_hf_secret_namespace_operation(plan, cluster_id=cluster_id))
        operations.append(_hf_secret_operation(plan, namespace_planned=hf_namespace_planned))
    if plan.stack.image_prepull_enabled:
        images_namespace_planned = plan.stack.images_namespace_mode == "create"
        if images_namespace_planned:
            operations.append(_images_namespace_operation(plan))
        operations.append(_images_prepull_operation(plan, namespace_planned=images_namespace_planned))
    operations.extend(_accelerator_operations(plan))
    operations.extend(_lws_operations(plan))
    operations.extend(_storage_operations(plan, cluster_id=cluster_id, storage_volume=storage_volume))
    token_secret = _model_cache_token_secret_operation(
        plan,
        cluster_id=cluster_id,
        storage_volume=storage_volume,
    )
    if token_secret is not None:
        operations.append(token_secret)
    model_cache_job = _model_cache_job_operation(plan, cluster_id=cluster_id, storage_volume=storage_volume)
    if model_cache_job is not None:
        operations.append(model_cache_job)
    operations.extend(_monitoring_operations(plan))
    _validate_operation_requirements(operations)
    return _topological_order(operations)
