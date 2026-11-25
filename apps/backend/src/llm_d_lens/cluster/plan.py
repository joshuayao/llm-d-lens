"""Provisioning-plan model, normalization and the two plan hashes.

The plan is the complete, validated description of what the configuration
wizard will execute. It contains no secret values: only the HF token source and
the Secret coordinates. See
``docs/design/cluster-permission-preflight-design.md`` sections 4.1, 4.2,
D21-D22, 16 and 17.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, get_args

from pydantic import Field, ValidationError, field_validator

from llm_d_lens.hardware.errors import HardwareProfileNotFoundError
from llm_d_lens.hardware.models import HardwareProfile
from llm_d_lens.hardware.registry import get_profile
from llm_d_lens.hardware.resolver import resolve_by_accelerator_key
from llm_d_lens.model_service.gateway_providers import GatewayProvider
from llm_d_lens.monitoring.gpu_driver.models import GpuAccessMode
from llm_d_lens.storage.contracts import (
    DynamicPvcSpec,
    LocalDiskSpec,
    NfsSpec,
    validate_storage_volume_id,
)
from llm_d_lens.versions import lws_version as current_lws_version

from .capabilities import CAPABILITY_UNITS, installer_namespaces_for_plan
from .models import StrictModel
from .registry import (
    DEFAULT_MONITORING_NAMESPACE,
    MONITORING_MODES,
    extract_url_host,
    validate_container_image_ref,
    validate_monitoring_http_url,
)

__all__ = [
    "GATEWAY_PROVIDERS",
    "GATEWAY_SERVICE_TYPES",
    "MONITORING_MODES",
    "MONITORING_NAMESPACE",
    "MONITORING_NAMESPACE_PREFIX",
    "PLAN_VERSION",
    "STORAGE_NAMESPACE",
    "STORAGE_NAMESPACE_PREFIX",
    "AcceleratorPlan",
    "GatewayPlan",
    "HandoffPlan",
    "HfTokenSecretPlan",
    "ModelCachePlan",
    "MonitoringPlan",
    "PlanHashes",
    "PlanValidationError",
    "ProvisioningPlan",
    "RuntimePlan",
    "StackPlan",
    "StoragePlan",
    "canonical_plan_json",
    "default_monitoring_namespace",
    "default_storage_namespace",
    "effective_namespaces",
    "normalize_monitoring_plan",
    "normalize_plan",
    "plan_hash",
    "plan_hash16",
    "plan_hashes",
]

PLAN_VERSION = 5
MONITORING_NAMESPACE = DEFAULT_MONITORING_NAMESPACE
#: Prefix used for cluster-scoped default monitoring namespaces (``lens-monitoring-<cluster_id>``).
MONITORING_NAMESPACE_PREFIX = "lens-monitoring"

#: Legacy fixed storage namespace retained for backward compatibility with
#: unmigrated volume rows and default HF token secret coordinates.
STORAGE_NAMESPACE = "llm-d-bench-storage"
#: Prefix used for cluster-scoped default PVC namespaces (``lens-storage-<cluster_id>``).
STORAGE_NAMESPACE_PREFIX = "lens-storage"
#: The image pre-pull DaemonSet is hard-coded to this namespace (see
#: ``cluster/images.py::IMAGES_NAMESPACE``); the plan must not disagree.
#: This is a temporary M1/M2 limitation: the namespace is not configurable
#: until M2/M3 makes the execution side follow the plan.
IMAGES_NAMESPACE = "lens-images"

GATEWAY_PROVIDERS: tuple[GatewayProvider, ...] = get_args(GatewayProvider)
STORAGE_PURPOSES = ("model-cache",)
ACCESS_MODES = ("ReadWriteOnce", "ReadWriteMany", "ReadOnlyMany")
GATEWAY_SERVICE_TYPES = ("LoadBalancer", "NodePort", "ClusterIP")
CAPACITY_PATTERN = re.compile(r"^\d+(Gi|Mi|Ti)$")
DNS1123_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
PROFILE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


def default_monitoring_namespace(cluster_id: str | None = None) -> str:
    """Return the default monitoring namespace ``lens-monitoring-<cluster_id>`` (or ``lens-monitoring`` when empty)."""
    raw = (cluster_id or "").strip().lower()
    if not raw:
        return MONITORING_NAMESPACE_PREFIX
    cleaned = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    max_suffix = 63 - len(MONITORING_NAMESPACE_PREFIX) - 1
    cleaned = cleaned[:max_suffix].rstrip("-")
    if not cleaned:
        return MONITORING_NAMESPACE_PREFIX
    return f"{MONITORING_NAMESPACE_PREFIX}-{cleaned}"


def default_storage_namespace(cluster_id: str | None = None) -> str:
    """Return the default PVC namespace ``lens-storage-<cluster_id>`` (or ``lens-storage`` when empty)."""
    raw = (cluster_id or "").strip().lower()
    if not raw:
        return STORAGE_NAMESPACE_PREFIX
    cleaned = re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")
    max_suffix = 63 - len(STORAGE_NAMESPACE_PREFIX) - 1
    cleaned = cleaned[:max_suffix].rstrip("-")
    if not cleaned:
        return STORAGE_NAMESPACE_PREFIX
    return f"{STORAGE_NAMESPACE_PREFIX}-{cleaned}"


class PlanValidationError(ValueError):
    """A plan is syntactically valid but fails a normalization rule."""


class GatewayPlan(StrictModel):
    provider: str = ""
    namespace: str = ""
    namespace_mode: Literal["create", "existing"] = Field(default="existing", alias="namespaceMode")
    name: str = ""
    public_url: str | None = Field(default=None, alias="publicUrl")
    port: int | None = None
    authz_host: str | None = Field(default=None, alias="authzHost")
    service_type: Literal["LoadBalancer", "NodePort", "ClusterIP"] | None = Field(
        default=None,
        alias="serviceType",
    )


class AcceleratorPlan(StrictModel):
    """One accelerator vendor/mode pair selected by the user.

    ``rbac`` is resolved from the hardware profile before the plan is saved and
    snapshotted here. It is a list so ``namespaced + cluster`` stays explicit;
    a string such as ``"namespaced+cluster"`` is accepted on input and
    normalized to the sorted list. An omitted list means "use the hardware
    profile"; normalization always fills it from the profile when empty.
    """

    vendor: str = ""
    model: str | None = None
    mode: GpuAccessMode = "plugin"
    operator: str | None = None
    profile: str | None = None
    rbac: list[Literal["none", "namespaced", "cluster", "escalation"]] = Field(default_factory=list)

    @field_validator("rbac", mode="before")
    @classmethod
    def _coerce_rbac(cls, value: Any) -> Any:
        if value is None:
            return []
        if isinstance(value, str):
            return [part.strip() for part in value.replace(",", "+").split("+") if part.strip()]
        return value

    @field_validator("rbac")
    @classmethod
    def _normalize_rbac(cls, value: list[str]) -> list[str]:
        normalized = sorted(set(value))
        if "none" in normalized and len(normalized) > 1:
            raise ValueError("rbac 'none' cannot be combined with another requirement")
        return normalized


class StoragePlan(StrictModel):
    kind: Literal["local-disk", "nfs", "dynamic-pvc", "none"] = "none"
    volume_id: str | None = Field(default=None, alias="volumeId")
    namespace: str | None = None
    namespace_mode: Literal["create", "existing"] = Field(default="existing", alias="namespaceMode")
    capacity: str | None = None
    storage_class: str | None = Field(default=None, alias="storageClass")
    access_mode: str | None = Field(default=None, alias="accessMode")
    read_only: bool = Field(default=False, alias="readOnly")
    purposes: list[str] = Field(default_factory=list)
    host_path: str | None = Field(default=None, alias="hostPath")
    nfs_server: str | None = Field(default=None, alias="nfsServer")
    nfs_path: str | None = Field(default=None, alias="nfsPath")


class HfTokenSecretPlan(StrictModel):
    token_source: str = Field(default="create-secret", alias="tokenSource")
    secret_name: str | None = Field(default=None, alias="secretName")
    secret_namespace: str = Field(default="", alias="secretNamespace")
    secret_namespace_mode: Literal["create", "existing"] = Field(default="existing", alias="secretNamespaceMode")


class ModelCachePlan(StrictModel):
    enabled: bool = False
    entry_id: str | None = Field(default=None, alias="entryId")
    repo_id: str | None = Field(default=None, alias="repoId")
    revision: str | None = None
    storage_volume_ref: str | None = Field(default=None, alias="storageVolumeRef")


class StackPlan(StrictModel):
    router_version: str | None = Field(default=None, alias="routerVersion")
    gie_version: str | None = Field(default=None, alias="gieVersion")
    ipp_version: str | None = Field(default=None, alias="ippVersion")
    lws_version: str | None = Field(default=None, alias="lwsVersion")
    lws_enabled: bool = Field(default=False, alias="lwsEnabled")
    crds_enabled: bool = Field(default=False, alias="crdsEnabled")
    image_prepull_enabled: bool = Field(default=False, alias="imagePrepullEnabled")
    vllm_image: str | None = Field(default=None, alias="vllmImage")
    images: list[str] = Field(default_factory=list)
    images_namespace: str | None = Field(default=None, alias="imagesNamespace")
    images_namespace_mode: Literal["create", "existing"] = Field(default="create", alias="imagesNamespaceMode")


class RuntimePlan(StrictModel):
    inotify_enabled: bool = Field(default=True, alias="inotifyEnabled")
    inotify_limit: int = Field(default=8192, ge=1, le=10_000_000, alias="inotifyLimit")


class HandoffPlan(StrictModel):
    """Coordinates the Orchestration administrator handoff may use.

    The completion marker is a ConfigMap in this namespace; the edit identity
    must be able to read it. The handoff never creates an identity, RoleBinding
    or replacement kubeconfig here.
    """

    namespace: str = "default"


_MONITORING_AUTO_DISCOVERED_FIELDS: dict[str, str] = {
    "prometheusUrl": "prometheus_url",
    "grafanaUrl": "grafana_url",
    "prometheusNodePort": "prometheus_node_port",
    "grafanaNodePort": "grafana_node_port",
    "host": "host",
}


class MonitoringPlan(StrictModel):
    """Monitoring stack configuration and direct HTTP endpoint overrides."""

    enabled: bool = True
    mode: Literal["managed", "existing"] = "managed"
    namespace: str = MONITORING_NAMESPACE
    prometheus_url: str | None = Field(default=None, alias="prometheusUrl")
    grafana_url: str | None = Field(default=None, alias="grafanaUrl")
    prometheus_node_port: int | None = Field(default=None, alias="prometheusNodePort")
    grafana_node_port: int | None = Field(default=None, alias="grafanaNodePort")
    host: str | None = None
    install_accelerator_exporters: bool = Field(default=True, alias="installAcceleratorExporters")
    auto_discovered: list[Literal["prometheusUrl", "grafanaUrl", "prometheusNodePort", "grafanaNodePort", "host"]] = (
        Field(default_factory=list, alias="autoDiscovered")
    )

    @field_validator("auto_discovered", mode="before")
    @classmethod
    def _coerce_auto_discovered(cls, value: Any) -> Any:
        if value is None:
            return []
        return value

    @field_validator("prometheus_node_port", "grafana_node_port", mode="before")
    @classmethod
    def _reject_bool_port(cls, value: Any) -> Any:
        if isinstance(value, bool):
            raise ValueError("NodePort must be an integer between 30000 and 32767, not a boolean")
        return value


class ProvisioningPlan(StrictModel):
    gateway: GatewayPlan = Field(default_factory=GatewayPlan)
    accelerators: list[AcceleratorPlan] = Field(default_factory=list)
    storage: StoragePlan = Field(default_factory=StoragePlan)
    hf_token_secret: HfTokenSecretPlan = Field(default_factory=HfTokenSecretPlan, alias="hfTokenSecret")
    model_cache: ModelCachePlan = Field(default_factory=ModelCachePlan, alias="modelCache")
    stack: StackPlan = Field(default_factory=StackPlan)
    runtime: RuntimePlan = Field(default_factory=RuntimePlan)
    handoff: HandoffPlan = Field(default_factory=HandoffPlan)
    monitoring: MonitoringPlan = Field(default_factory=MonitoringPlan)
    spec: dict[str, Any] = Field(default_factory=dict)
    plan_version: int = Field(default=PLAN_VERSION, alias="planVersion")

    @field_validator("monitoring", mode="before")
    @classmethod
    def _coerce_monitoring(cls, value: Any) -> Any:
        if value is None:
            return MonitoringPlan()
        return value


def _required(value: str | None, field: str) -> str:
    text = (value or "").strip()
    if not text:
        raise PlanValidationError(f"{field} is required")
    return text


def _optional(value: str | None) -> str | None:
    text = (value or "").strip()
    return text or None


def _exact_optional(value: str | None, field: str) -> str | None:
    """Return a value without silently trimming it.

    Names and filesystem paths must reject surrounding whitespace and embedded
    newlines rather than being "repaired" by stripping, which would make the
    validated value differ from what the client sent.
    """

    if value is None or not value.strip():
        return None
    if value != value.strip() or "\n" in value or "\r" in value:
        raise PlanValidationError(f"{field} must not contain surrounding whitespace or newlines")
    return value


def _required_exact(value: str | None, field: str) -> str:
    text = _exact_optional(value, field)
    if text is None:
        raise PlanValidationError(f"{field} is required")
    return text


def _required_name(value: str | None, field: str) -> str:
    return _validate_dns1123_label(_required_exact(value, field), field)


def _required_subdomain(value: str | None, field: str) -> str:
    return _validate_dns1123_subdomain(_required_exact(value, field), field)


def _validate_dns1123_label(value: str, field: str) -> str:
    """Reject anything that is not a Kubernetes DNS-1123 label (incl. newlines)."""
    if len(value) > 63 or not DNS1123_LABEL.fullmatch(value):
        raise PlanValidationError(f"{field} must be a valid DNS-1123 label")
    return value


def _validate_dns1123_subdomain(value: str, field: str) -> str:
    """Validate a DNS-1123 subdomain (dots allowed, at most 253 characters).

    Kubernetes limits each dot-separated label to 63 characters as well as the
    whole name to 253, so a 100-character single label is invalid even though
    the total length fits.
    """
    if len(value) > 253:
        raise PlanValidationError(f"{field} must be a valid DNS-1123 subdomain")
    for label in value.split("."):
        _validate_dns1123_label(label, field)
    return value


def _validate_profile_id(value: str, field: str) -> str:
    """Profile ids use the schema's ``[a-z0-9][a-z0-9.-]*`` alphabet."""
    if len(value) > 253 or not PROFILE_ID.fullmatch(value):
        raise PlanValidationError(f"{field} must be a valid hardware profile id")
    return value


def _validate_capacity(value: str | None) -> str:
    capacity = _required_exact(value, "storage.capacity")
    if not CAPACITY_PATTERN.fullmatch(capacity):
        raise PlanValidationError("storage.capacity must be a positive integer followed by Gi, Mi or Ti")
    return capacity


def _normalize_gateway(gateway: GatewayPlan) -> GatewayPlan:
    provider = _required(gateway.provider, "gateway.provider")
    if provider not in GATEWAY_PROVIDERS:
        raise PlanValidationError(f"unknown gateway provider {provider!r}")
    namespace = _required_name(gateway.namespace, "gateway.namespace")
    name = _required_subdomain(gateway.name, "gateway.name")
    if gateway.port is not None and not 30000 <= gateway.port <= 32767:
        raise PlanValidationError("gateway.port must be between 30000 and 32767")
    return gateway.model_copy(
        update={
            "provider": provider,
            "namespace": namespace,
            "name": name,
            "public_url": _optional(gateway.public_url),
            "authz_host": _optional(gateway.authz_host),
            "service_type": _optional(gateway.service_type),
        }
    )


def _lookup_hardware_profile(key: str) -> HardwareProfile | None:
    try:
        return get_profile(key)
    except HardwareProfileNotFoundError:
        return resolve_by_accelerator_key(key)


def _normalize_accelerator(accelerator: AcceleratorPlan) -> AcceleratorPlan:
    vendor = _validate_profile_id(
        _required_exact(accelerator.vendor, "accelerators[].vendor"),
        "accelerators[].vendor",
    )
    profile_key = _exact_optional(accelerator.profile, "accelerators[].profile")
    if profile_key is not None:
        profile_key = _validate_profile_id(profile_key, "accelerators[].profile")

    vendor_profile = _lookup_hardware_profile(vendor)
    if vendor_profile is None:
        raise PlanValidationError(f"unknown accelerator vendor {vendor!r}")
    profile = _lookup_hardware_profile(profile_key) if profile_key is not None else vendor_profile
    if profile is None:
        raise PlanValidationError(f"unknown hardware profile {profile_key!r}")
    if profile.id != vendor_profile.id:
        raise PlanValidationError(f"accelerator vendor {vendor!r} does not match hardware profile {profile.id!r}")
    if not profile.vendor:
        raise PlanValidationError(f"hardware profile {profile.id!r} does not declare a vendor")
    unit_id = f"accelerator.{profile.vendor}"
    if unit_id not in CAPABILITY_UNITS:
        raise PlanValidationError(f"hardware profile {profile.id!r} has no capability unit {unit_id!r}")

    access_modes = profile.access_modes or tuple((profile.driver.modes if profile.driver else {}).keys())
    if access_modes and accelerator.mode not in access_modes:
        raise PlanValidationError(
            f"accelerator mode {accelerator.mode!r} is not supported by hardware profile {profile.id!r} "
            f"(supported: {', '.join(access_modes)})"
        )

    profile_rbac = tuple(profile.driver.rbac) if profile.driver is not None else ()
    if not profile_rbac:
        raise PlanValidationError(f"hardware profile {profile.id!r} does not declare driver rbac requirements")
    requested = set(accelerator.rbac)
    if requested:
        # There is no optional RBAC semantic yet: an explicit value must match
        # the profile exactly so a user cannot silently drop a required scope.
        expected = set(profile_rbac)
        if requested != expected:
            raise PlanValidationError(
                f"accelerator rbac {sorted(requested)!r} must equal hardware profile {profile.id!r} "
                f"rbac {sorted(expected)!r}"
            )
        rbac = sorted(expected)
    else:
        rbac = sorted(set(profile_rbac))

    return accelerator.model_copy(
        update={
            "vendor": profile.vendor,
            "model": _optional(accelerator.model),
            "operator": _optional(accelerator.operator),
            "profile": profile_key,
            "rbac": rbac,
        }
    )


def _normalize_storage(storage: StoragePlan, *, cluster_id: str) -> StoragePlan:
    volume_id = _exact_optional(storage.volume_id, "storage.volumeId")
    if volume_id is None and cluster_id:
        volume_id = f"storage-{cluster_id}"
    if volume_id is not None:
        try:
            validate_storage_volume_id(volume_id)
        except ValueError as exc:
            raise PlanValidationError(str(exc)) from exc

    if storage.kind == "none":
        # kind=none carries no storage fields; an invalid capacity is ignored
        # on a plan that has no storage rather than rejected by Pydantic.
        return storage.model_copy(
            update={
                "volume_id": volume_id,
                "namespace": None,
                "namespace_mode": "existing",
                "capacity": None,
                "storage_class": None,
                "access_mode": None,
                "read_only": False,
                "purposes": [],
                "host_path": None,
                "nfs_server": None,
                "nfs_path": None,
            }
        )

    capacity = _validate_capacity(storage.capacity)
    access_mode = storage.access_mode or "ReadWriteOnce"
    if access_mode not in ACCESS_MODES:
        raise PlanValidationError(f"storage.accessMode must be one of {', '.join(ACCESS_MODES)}")
    purposes = sorted(set(storage.purposes))
    for purpose in purposes:
        if purpose not in STORAGE_PURPOSES:
            raise PlanValidationError(f"unknown storage purpose {purpose!r}")
    if "model-cache" in purposes and storage.read_only:
        raise PlanValidationError("a model-cache storage volume must be writable (readOnly: false)")

    namespace_mode = storage.namespace_mode
    if storage.kind == "dynamic-pvc":
        namespace = _required_name(storage.namespace, "storage.namespace")
        storage_class = _required_exact(storage.storage_class, "storage.storageClass")
        if storage.host_path or storage.nfs_server or storage.nfs_path:
            raise PlanValidationError("dynamic-pvc storage does not accept hostPath, nfsServer or nfsPath")
        host_path = None
        nfs_server = None
        nfs_path = None
        try:
            DynamicPvcSpec(storageClass=storage_class, namespace=namespace, accessMode=access_mode)
        except ValidationError as exc:
            raise PlanValidationError(str(exc)) from exc
        if "model-cache" in purposes:
            raise PlanValidationError("model-cache purpose cannot use dynamic-pvc storage")
    else:
        if storage.namespace is None or storage.namespace == "":
            namespace = default_storage_namespace(cluster_id)
            if "namespace_mode" not in storage.model_fields_set:
                namespace_mode = "create"
        else:
            namespace = _required_name(storage.namespace, "storage.namespace")
        storage_class = _optional(storage.storage_class)
        host_path = _exact_optional(storage.host_path, "storage.hostPath")
        nfs_server = _exact_optional(storage.nfs_server, "storage.nfsServer")
        nfs_path = _exact_optional(storage.nfs_path, "storage.nfsPath")
        if storage.kind == "local-disk":
            if nfs_server or nfs_path:
                raise PlanValidationError("local-disk storage does not accept nfsServer or nfsPath")
            try:
                LocalDiskSpec(hostPath=_required_exact(host_path, "storage.hostPath"), namespace=namespace)
            except ValidationError as exc:
                raise PlanValidationError(str(exc)) from exc
        else:
            if host_path:
                raise PlanValidationError("nfs storage does not accept hostPath")
            try:
                NfsSpec(
                    server=_required_exact(nfs_server, "storage.nfsServer"),
                    path=_required_exact(nfs_path, "storage.nfsPath"),
                    namespace=namespace,
                )
            except ValidationError as exc:
                raise PlanValidationError(str(exc)) from exc

    return storage.model_copy(
        update={
            "volume_id": volume_id,
            "namespace": namespace,
            "namespace_mode": namespace_mode,
            "capacity": capacity,
            "storage_class": storage_class,
            "access_mode": access_mode,
            "read_only": storage.read_only,
            "purposes": purposes,
            "host_path": host_path,
            "nfs_server": nfs_server,
            "nfs_path": nfs_path,
        }
    )


def _normalize_hf_token_secret(secret: HfTokenSecretPlan, *, cluster_id: str) -> HfTokenSecretPlan:
    token_source = _required_exact(secret.token_source, "hfTokenSecret.tokenSource")
    secret_name = _exact_optional(secret.secret_name, "hfTokenSecret.secretName")

    if token_source == "create-secret":  # noqa: S105 - token source value, not a credential
        if secret_name is None:
            if not cluster_id:
                raise PlanValidationError("cluster id is required to default the HF Secret name")
            secret_name = f"hf-token-{cluster_id[:8]}"
    elif token_source.startswith("existing-secret:"):
        referenced_name = _required_exact(
            token_source.split(":", 1)[1],
            "hfTokenSecret.tokenSource secret name",
        )
        if secret_name is not None and secret_name != referenced_name:
            raise PlanValidationError("hfTokenSecret.secretName must match the name in an existing-secret token source")
        secret_name = referenced_name
    else:
        raise PlanValidationError("hfTokenSecret.tokenSource must be 'create-secret' or 'existing-secret:<name>'")

    secret_name = _required_subdomain(secret_name, "hfTokenSecret.secretName")
    secret_namespace = _required_name(secret.secret_namespace, "hfTokenSecret.secretNamespace")
    # An existing Secret implies its namespace already exists; Lens has no
    # reason to create (or relabel) it from this plan.
    secret_namespace_mode = "existing" if token_source.startswith("existing-secret:") else secret.secret_namespace_mode
    return secret.model_copy(
        update={
            "token_source": token_source,
            "secret_name": secret_name,
            "secret_namespace": secret_namespace,
            "secret_namespace_mode": secret_namespace_mode,
        }
    )


def _normalize_model_cache(
    cache: ModelCachePlan,
    *,
    storage: StoragePlan,
    cluster_id: str,
) -> ModelCachePlan:
    entry_id = _exact_optional(cache.entry_id, "modelCache.entryId")
    if entry_id is None and cluster_id:
        entry_id = f"model-cache-{cluster_id}"
    if entry_id is not None:
        try:
            validate_storage_volume_id(entry_id)
        except ValueError as exc:
            raise PlanValidationError(str(exc)) from exc
    elif cache.enabled:
        raise PlanValidationError("modelCache.entryId is required when model cache is enabled")
    repo_id = _optional(cache.repo_id)
    revision = _optional(cache.revision)
    # ``storageVolumeRef`` is a display/reference name for the plan-owned
    # storage volume, not a Kubernetes object name: the storage contract only
    # limits it to 63 characters, so spaces and dots are valid.
    storage_volume_ref = _optional(cache.storage_volume_ref)
    if storage_volume_ref is not None and len(storage_volume_ref) > 63:
        raise PlanValidationError("modelCache.storageVolumeRef must be at most 63 characters")
    if cache.enabled:
        if storage.kind not in {"local-disk", "nfs"}:
            # A dynamic PVC cannot carry the model-cache purpose (the storage
            # contract rejects it), and a storage-less plan has no volume name
            # or namespace for the download Job.
            raise PlanValidationError("modelCache.enabled requires 'local-disk' or 'nfs' storage")
        if "model-cache" not in storage.purposes:
            raise PlanValidationError("modelCache.enabled requires the storage volume purpose 'model-cache'")
        if storage.read_only:
            raise PlanValidationError("modelCache.enabled requires a writable storage volume (readOnly: false)")
        if repo_id is None:
            raise PlanValidationError("modelCache.repoId is required when model cache is enabled")
        if revision is None:
            raise PlanValidationError("modelCache.revision is required when model cache is enabled")
        if storage_volume_ref is None:
            raise PlanValidationError("modelCache.storageVolumeRef is required when model cache is enabled")
    return cache.model_copy(
        update={
            "entry_id": entry_id,
            "repo_id": repo_id,
            "revision": revision,
            "storage_volume_ref": storage_volume_ref,
        }
    )


def _normalize_stack(stack: StackPlan) -> StackPlan:
    try:
        vllm_image = validate_container_image_ref(stack.vllm_image, field="stack.vllmImage")
    except ValueError as exc:
        raise PlanValidationError(str(exc)) from exc
    images: list[str] = []
    for value in stack.images:
        try:
            image = validate_container_image_ref(value, field="stack.images", allow_empty=False)
        except ValueError as exc:
            raise PlanValidationError(str(exc)) from exc
        assert image is not None
        if image not in images:
            images.append(image)
    images_namespace = _exact_optional(stack.images_namespace, "stack.imagesNamespace")
    if stack.image_prepull_enabled or images:
        if images_namespace is None:
            images_namespace = IMAGES_NAMESPACE
        elif images_namespace != IMAGES_NAMESPACE:
            # The execution side (cluster/images.py) is hard-coded to this
            # namespace; accepting another value would make plan and execution
            # disagree about the namespace to check.
            raise PlanValidationError(f"stack.imagesNamespace must be {IMAGES_NAMESPACE!r}")
        images_namespace = _required_name(images_namespace, "stack.imagesNamespace")
    elif images_namespace is not None:
        images_namespace = _required_name(images_namespace, "stack.imagesNamespace")
        if images_namespace != IMAGES_NAMESPACE:
            raise PlanValidationError(f"stack.imagesNamespace must be {IMAGES_NAMESPACE!r}")
    return stack.model_copy(
        update={
            "router_version": _optional(stack.router_version),
            "gie_version": _optional(stack.gie_version),
            "ipp_version": _optional(stack.ipp_version),
            "lws_version": _optional(stack.lws_version) or current_lws_version(),
            "vllm_image": vllm_image,
            "images": images,
            "images_namespace": images_namespace,
        }
    )


def _normalize_handoff(handoff: HandoffPlan) -> HandoffPlan:
    return handoff.model_copy(
        update={"namespace": _required_name(handoff.namespace, "handoff.namespace")},
    )


def normalize_monitoring_plan(
    monitoring: MonitoringPlan | Mapping[str, Any] | None,
    *,
    cluster_id: str = "",
) -> MonitoringPlan:
    """Validate and normalize monitoring configuration against URL/NodePort/host rules."""
    if monitoring is None:
        if (cluster_id or "").strip():
            return MonitoringPlan(namespace=default_monitoring_namespace(cluster_id))
        return MonitoringPlan(namespace=MONITORING_NAMESPACE)
    try:
        parsed = monitoring if isinstance(monitoring, MonitoringPlan) else MonitoringPlan.model_validate(monitoring)
    except ValidationError as exc:
        raise PlanValidationError(str(exc)) from exc

    if parsed.enabled is False:
        raise PlanValidationError("monitoring.enabled must be true")

    if not parsed.namespace.strip() or "namespace" not in parsed.model_fields_set:
        namespace = default_monitoring_namespace(cluster_id) if (cluster_id or "").strip() else MONITORING_NAMESPACE
    else:
        namespace = _required_name(parsed.namespace, "monitoring.namespace")

    try:
        prometheus_url = validate_monitoring_http_url(parsed.prometheus_url, field="monitoring.prometheusUrl")
        grafana_url = validate_monitoring_http_url(parsed.grafana_url, field="monitoring.grafanaUrl")
    except ValueError as exc:
        raise PlanValidationError(str(exc)) from exc

    for port, label in (
        (parsed.prometheus_node_port, "monitoring.prometheusNodePort"),
        (parsed.grafana_node_port, "monitoring.grafanaNodePort"),
    ):
        if port is not None and (isinstance(port, bool) or not (30000 <= port <= 32767)):
            raise PlanValidationError(f"{label} must be between 30000 and 32767")
    if (
        parsed.prometheus_node_port is not None
        and parsed.grafana_node_port is not None
        and parsed.prometheus_node_port == parsed.grafana_node_port
    ):
        raise PlanValidationError("monitoring.prometheusNodePort and grafanaNodePort must differ")

    raw_host = _exact_optional(parsed.host, "monitoring.host")
    if raw_host is None:
        host = None
    else:
        if any(ord(char) < 32 or ord(char) == 127 or char.isspace() for char in raw_host):
            raise PlanValidationError("monitoring.host must not contain whitespace or control characters")
        if any(token in raw_host for token in ("://", "/", "@", "?", "#", "%")):
            raise PlanValidationError("monitoring.host must be a hostname or IP address, not a URL")
        host = extract_url_host(raw_host)
        if host is None:
            raise PlanValidationError("monitoring.host must be a valid, allowed hostname or IP address")

    normalized_fields = {
        "prometheus_url": prometheus_url,
        "grafana_url": grafana_url,
        "prometheus_node_port": parsed.prometheus_node_port,
        "grafana_node_port": parsed.grafana_node_port,
        "host": host,
    }
    auto_discovered = sorted(
        {
            key
            for key in parsed.auto_discovered
            if key in _MONITORING_AUTO_DISCOVERED_FIELDS
            and normalized_fields[_MONITORING_AUTO_DISCOVERED_FIELDS[key]] is not None
        }
    )

    return parsed.model_copy(
        update={
            "namespace": namespace,
            "prometheus_url": prometheus_url,
            "grafana_url": grafana_url,
            "host": host,
            "auto_discovered": auto_discovered,
        }
    )


def normalize_plan(
    plan: ProvisioningPlan | Mapping[str, Any],
    *,
    cluster_id: str = "",
) -> ProvisioningPlan:
    """Validate and normalize a plan against the execution contracts.

    Defaults are filled and only the effective values are stored, so two
    equivalent plans produce the same canonical JSON. A rule violation raises
    :class:`PlanValidationError`; malformed field types are wrapped in it too.
    """

    try:
        parsed = plan if isinstance(plan, ProvisioningPlan) else ProvisioningPlan.model_validate(plan)
    except ValidationError as exc:
        raise PlanValidationError(str(exc)) from exc

    accelerators = [_normalize_accelerator(item) for item in parsed.accelerators]
    accelerators.sort(key=lambda item: (item.vendor, item.mode, item.model or ""))
    storage = _normalize_storage(parsed.storage, cluster_id=cluster_id)
    gateway = _normalize_gateway(parsed.gateway)
    monitoring = normalize_monitoring_plan(parsed.monitoring, cluster_id=cluster_id)
    if monitoring.mode == "managed" and gateway.port is not None:
        if monitoring.prometheus_node_port == gateway.port:
            raise PlanValidationError("monitoring.prometheusNodePort must not collide with gateway.port")
        if monitoring.grafana_node_port == gateway.port:
            raise PlanValidationError("monitoring.grafanaNodePort must not collide with gateway.port")
    return parsed.model_copy(
        update={
            "gateway": gateway,
            "accelerators": accelerators,
            "storage": storage,
            "hf_token_secret": _normalize_hf_token_secret(parsed.hf_token_secret, cluster_id=cluster_id),
            "model_cache": _normalize_model_cache(parsed.model_cache, storage=storage, cluster_id=cluster_id),
            "stack": _normalize_stack(parsed.stack),
            "handoff": _normalize_handoff(parsed.handoff),
            "monitoring": monitoring,
            "plan_version": PLAN_VERSION,
        }
    )


def _canonical_json(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_plan_json(plan: ProvisioningPlan) -> str:
    """Stable JSON for the full plan (the plan never contains secret values)."""
    payload = plan.model_dump(mode="json")
    monitoring = payload.get("monitoring")
    if isinstance(monitoring, dict):
        raw_auto = monitoring.pop("auto_discovered", None)
        if isinstance(raw_auto, list):
            for camel_key in raw_auto:
                snake_key = _MONITORING_AUTO_DISCOVERED_FIELDS.get(camel_key)
                if snake_key is not None:
                    monitoring[snake_key] = None
    return _canonical_json(payload)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def plan_hash(plan: ProvisioningPlan) -> str:
    """SHA-256 over every plan field, used for staleness and concurrency."""
    return _sha256(canonical_plan_json(plan))


def plan_hash16(plan: ProvisioningPlan) -> str:
    return plan_hash(plan)[:16]


def effective_namespaces(plan: ProvisioningPlan) -> dict[str, str]:
    """Effective namespace targets that participate in the grant projection.

    ``handoff.namespace`` is deliberately absent: the marker is read with the
    edit identity's existing permissions and is not a grant or install target.
    It is still part of the plan and therefore of ``plan_hash``.
    """

    entries: dict[str, str] = {}
    if plan.gateway.namespace:
        entries["gateway"] = plan.gateway.namespace
    if plan.storage.kind != "none" and plan.storage.namespace:
        entries["storage"] = plan.storage.namespace
    if plan.hf_token_secret.secret_namespace:
        entries["hf_secret"] = plan.hf_token_secret.secret_namespace
    if plan.stack.images_namespace:
        entries["images"] = plan.stack.images_namespace
    if plan.model_cache.enabled:
        # Model-cache Jobs run in the storage volume's namespace
        # (``model_cache/jobs.py::_pvc_namespace``).
        entries["model_cache"] = plan.storage.namespace or STORAGE_NAMESPACE_PREFIX
    # Provider installers create their fixed system namespaces themselves; the
    # preflight and the plan-scoped RoleBindings must include them.
    for namespace in installer_namespaces_for_plan(plan):
        entries[f"installer:{namespace}"] = namespace
    return {key: entries[key] for key in sorted(entries)}


@dataclass(frozen=True)
class PlanHashes:
    plan_hash: str
    plan_hash16: str
    plan_version: int


def plan_hashes(plan: ProvisioningPlan) -> PlanHashes:
    full_plan_hash = plan_hash(plan)
    return PlanHashes(
        plan_hash=full_plan_hash,
        plan_hash16=full_plan_hash[:16],
        plan_version=plan.plan_version,
    )
