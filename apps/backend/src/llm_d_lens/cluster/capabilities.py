"""Capability catalog for plan-scoped Kubectl permissions.

Grant rules describe what the Orchestration administrator script applies. Check rules
describe what the preflight probes; every check names a concrete verb, API
group, resource and scope, because a review cannot validate a wildcard.

See ``docs/design/cluster-permission-preflight-design.md`` section 4.2.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .plan import ProvisioningPlan

__all__ = [
    "ALL_UNITS",
    "CAPABILITY_UNITS",
    "STORAGE_NAMESPACE",
    "STORAGE_NAMESPACE_PREFIX",
    "CapabilityUnit",
    "CheckRule",
    "NonResourceCheck",
    "check_rules_for_plan",
    "check_rules_for_units",
    "enabled_steps",
    "installer_namespaces_for_plan",
    "non_resource_checks_for_units",
    "step_units",
    "unit_namespaces",
    "units_for_plan",
]

#: Execution order of the configuration wizard's steps (design sections 4.4
#: and 8). The backend uses this to decide which steps a completed run must
#: report and operation execution keep the same order.
EXECUTION_STEP_ORDER = (
    "prepare",
    "gateway",
    "gpu",
    "crds",
    "prepull",
    "lws",
    "hf-secret",
    "storage",
    "model-cache",
)


@dataclass(frozen=True)
class CheckRule:
    verb: str
    api_group: str
    resource: str
    scope: str
    subresource: str | None = None
    #: ``resourceAttributes.name`` for a check narrowed to one named resource.
    name: str | None = None
    #: Exact namespace for a plan-specific check whose target is not the whole
    #: unit namespace set (for example the HF source Secret versus the model
    #: cache's fixed token Secret).
    namespace: str | None = None
    reason: str = ""


@dataclass(frozen=True)
class NonResourceCheck:
    verb: str
    path: str
    reason: str = ""


@dataclass(frozen=True)
class CapabilityUnit:
    id: str
    title: str
    description: str
    check_rules: tuple[CheckRule, ...]
    non_resource_checks: tuple[NonResourceCheck, ...] = ()


_READ = ("get", "list", "watch")
_WRITE = ("get", "create", "update", "patch", "delete")
_WRITE_NO_READ = ("create", "update", "patch", "delete")

_GATEWAY_API = "gateway.networking.k8s.io"
_GATEWAY_RESOURCES = ("gatewayclasses", "gateways", "httproutes", "grpcroutes", "referencegrants")
#: The fixed Secret name the model-cache Jobs materialize and read in their
#: own namespace (see ``model_cache/jobs.py::_ensure_token_secret``).
MODEL_CACHE_TOKEN_SECRET = "llm-d-hf-token"  # noqa: S105 - Kubernetes Secret name, not a credential
_MODEL_CACHE_SECRET_VERBS = ("get", "create", "update", "patch")
#: Helm stores its release state in Secrets; an installer must be able to
#: create them, update an existing release record, and patch it.
_INSTALLER_SECRET_VERBS = ("get", "create", "update", "patch")

#: Units whose catalog-level Secret rules describe the HF token or the model
#: cache. Only these are narrowed to named Secrets in the plan projection;
#: installer units keep their generic Secret grants because Helm itself stores
#: release state in Secrets.
_PLAN_NARROWED_SECRET_UNITS = frozenset(
    {
        "core.discovery.secrets",
        "cache.hf-secret.create",
        "cache.hf-secret.read",
        "cache.job",
    }
)

#: Fixed namespaces the provider installers create themselves. Verified against
#: ``model_service/gateway_providers.py::PROVIDER_SPECS``; all non-GKE providers
#: use ``--create-namespace`` (Istio via ``istioctl``'s default namespace).
GATEWAY_INSTALL_NAMESPACES: dict[str, tuple[str, ...]] = {
    "envoy-ai-gateway": ("envoy-gateway-system", "envoy-ai-gateway-system"),
    "agentgateway": ("agentgateway-system",),
    "istio": ("istio-system",),
}
#: Fixed namespaces used by ``hardware/providers/nvidia.py::install_driver``.
NVIDIA_DRIVER_NAMESPACES: dict[str, tuple[str, ...]] = {
    "plugin": ("kube-system",),
    "dra": ("nvidia-dra-driver-gpu",),
}
#: Fixed namespaces used by the Intel kustomize installs
#: (``monitoring/gpu_driver/service.py::_install_commands``). The shared NFD
#: base creates ``node-feature-discovery`` for both modes; the DRA base also
#: creates ``intel-gpu-resource-driver``. The device-plugin overlay has no
#: Namespace object and applies into the current kube-context namespace
#: (usually ``default``); that target stays unverified.
INTEL_DRIVER_NAMESPACES: dict[str, tuple[str, ...]] = {
    "plugin": ("node-feature-discovery",),
    "dra": ("intel-gpu-resource-driver", "node-feature-discovery"),
}
#: Fixed namespace used by the LWS operation catalog.
LWS_NAMESPACE = "lws-system"
#: Legacy fixed storage namespace retained for backward compatibility.
STORAGE_NAMESPACE = "llm-d-bench-storage"
#: Prefix/fallback for cluster-scoped default PVC namespaces.
STORAGE_NAMESPACE_PREFIX = "lens-storage"
#: The image pre-pull DaemonSet is hard-coded to this namespace (see
#: ``cluster/images.py::IMAGES_NAMESPACE``); the plan must not disagree.
IMAGES_NAMESPACE = "lens-images"


def _checks(
    verb: str,
    api_group: str,
    resources: tuple[str, ...],
    scope: str,
    *,
    reason: str = "",
) -> tuple[CheckRule, ...]:
    return tuple(
        CheckRule(verb=verb, api_group=api_group, resource=resource, scope=scope, reason=reason)
        for resource in resources
    )


def _verb_checks(
    verbs: tuple[str, ...],
    api_group: str,
    resources: tuple[str, ...],
    scope: str,
) -> tuple[CheckRule, ...]:
    return tuple(
        CheckRule(verb=verb, api_group=api_group, resource=resource, scope=scope)
        for resource in resources
        for verb in verbs
    )


CAPABILITY_UNITS: dict[str, CapabilityUnit] = {
    "core.discovery": CapabilityUnit(
        id="core.discovery",
        title="Read cluster discovery resources",
        description=(
            "Read-only discovery used by the wizard, dashboards, preflight and cleanup. "
            "The plan-scoped role deliberately names concrete resources and never reads Secrets."
        ),
        check_rules=(
            *_checks("get", "", ("nodes", "namespaces", "persistentvolumes"), "cluster"),
            # Node-label readiness (accelerator NFD) watches the node list.
            *_checks("list", "", ("nodes",), "cluster"),
            *_checks("watch", "", ("nodes",), "cluster"),
            *_checks("get", "storage.k8s.io", ("storageclasses", "csidrivers"), "cluster"),
            *_checks("get", "apiextensions.k8s.io", ("customresourcedefinitions",), "cluster"),
            *_checks("list", "apiextensions.k8s.io", ("customresourcedefinitions",), "cluster"),
            *_checks("watch", "apiextensions.k8s.io", ("customresourcedefinitions",), "cluster"),
            *_checks("get", _GATEWAY_API, ("gatewayclasses",), "cluster"),
            *_checks(
                "get",
                "",
                ("pods", "services", "configmaps", "persistentvolumeclaims", "endpoints", "events", "serviceaccounts"),
                "namespace",
            ),
            CheckRule(verb="get", api_group="", resource="pods", scope="namespace", subresource="log"),
            *_checks("get", "apps", ("deployments", "daemonsets", "statefulsets", "replicasets"), "namespace"),
            # ``kubectl rollout status daemonset`` and the DaemonSet watch used by
            # the privileged node-sysctl operation need list/watch, not just get.
            *_checks("list", "apps", ("daemonsets",), "namespace"),
            *_checks("watch", "apps", ("daemonsets",), "namespace"),
            *_checks("list", "apps", ("deployments", "statefulsets"), "namespace"),
            *_checks("watch", "apps", ("deployments", "statefulsets"), "namespace"),
            # Cross-namespace driver-status discovery lists DaemonSets.
            *_checks("get", "apps", ("daemonsets",), "cluster"),
            *_checks("list", "apps", ("daemonsets",), "cluster"),
            *_checks("watch", "apps", ("daemonsets",), "cluster"),
            *_checks("get", "batch", ("jobs", "cronjobs"), "namespace"),
            *_checks("get", _GATEWAY_API, ("gateways", "httproutes"), "namespace"),
            *_checks("get", "inference.networking.k8s.io", ("inferencepools",), "namespace"),
            *_checks("get", "leaderworkerset.x-k8s.io", ("leaderworkersets",), "namespace"),
            *_checks("get", "monitoring.coreos.com", ("servicemonitors",), "namespace"),
        ),
        non_resource_checks=(
            NonResourceCheck(verb="get", path="/version"),
            NonResourceCheck(verb="get", path="/readyz"),
            NonResourceCheck(verb="get", path="/metrics"),
            NonResourceCheck(verb="get", path="/apis"),
            NonResourceCheck(verb="get", path="/api"),
        ),
    ),
    "core.discovery.secrets": CapabilityUnit(
        id="core.discovery.secrets",
        title="Read one named Secret",
        description=(
            "Added only when the plan must read a specific, pre-existing Secret. "
            "The Orchestration administrator script narrows the rule to the resource name."
        ),
        check_rules=(CheckRule(verb="get", api_group="", resource="secrets", scope="namespace"),),
    ),
    "core.workloads": CapabilityUnit(
        id="core.workloads",
        title="Manage workload controllers",
        description="Create and update the DaemonSets, deployments, stateful sets, Jobs and Pods named by the plan.",
        check_rules=(
            *_verb_checks(_WRITE_NO_READ, "", ("pods",), "namespace"),
            *_verb_checks(
                _WRITE_NO_READ, "apps", ("daemonsets", "deployments", "statefulsets", "replicasets"), "namespace"
            ),
            *_verb_checks(_WRITE_NO_READ, "batch", ("jobs", "cronjobs"), "namespace"),
        ),
    ),
    "core.namespaces": CapabilityUnit(
        id="core.namespaces",
        title="Create and manage namespaces",
        description="Create the namespaces the plan owns, and read/update/delete them during cleanup.",
        check_rules=(
            *_checks("get", "", ("namespaces",), "cluster"),
            *_checks("create", "", ("namespaces",), "cluster"),
            *_checks("patch", "", ("namespaces",), "cluster"),
        ),
    ),
    "core.rbac.namespaced": CapabilityUnit(
        id="core.rbac.namespaced",
        title="Manage namespaced RBAC",
        description="Create Roles and RoleBindings in the namespaces the plan writes to.",
        check_rules=_verb_checks(_WRITE, "rbac.authorization.k8s.io", ("roles", "rolebindings"), "namespace"),
    ),
    "core.rbac.cluster": CapabilityUnit(
        id="core.rbac.cluster",
        title="Manage cluster RBAC without escalation",
        description="Create ClusterRoles and ClusterRoleBindings but do not grant bind or escalate.",
        check_rules=_verb_checks(
            _WRITE, "rbac.authorization.k8s.io", ("clusterroles", "clusterrolebindings"), "cluster"
        ),
    ),
    "core.rbac.escalation": CapabilityUnit(
        id="core.rbac.escalation",
        title="Manage cluster RBAC with escalation",
        description=(
            "Required by Helm installs that create ClusterRoles or bind pre-existing ones: "
            "the same rules as core.rbac.cluster plus bind/escalate on ClusterRoles."
        ),
        check_rules=(
            *_verb_checks(_WRITE, "rbac.authorization.k8s.io", ("clusterroles", "clusterrolebindings"), "cluster"),
            *_verb_checks(("bind", "escalate"), "rbac.authorization.k8s.io", ("clusterroles",), "cluster"),
        ),
    ),
    "core.crds": CapabilityUnit(
        id="core.crds",
        title="Install custom resource definitions",
        description="Create and patch the CRDs installed by the selected gateway and stack components.",
        check_rules=_verb_checks(
            ("create", "update", "patch"), "apiextensions.k8s.io", ("customresourcedefinitions",), "cluster"
        ),
    ),
    "core.admission": CapabilityUnit(
        id="core.admission",
        title="Install admission and API registration objects",
        description="Create webhooks, APIServices and PriorityClasses required by Istio and Intel installs.",
        check_rules=(
            *_verb_checks(
                ("create", "update", "patch"),
                "admissionregistration.k8s.io",
                (
                    "mutatingwebhookconfigurations",
                    "validatingwebhookconfigurations",
                    "validatingadmissionpolicies",
                    "validatingadmissionpolicybindings",
                ),
                "cluster",
            ),
            *_verb_checks(("create", "update", "patch"), "apiregistration.k8s.io", ("apiservices",), "cluster"),
            *_verb_checks(("create", "update", "patch"), "scheduling.k8s.io", ("priorityclasses",), "cluster"),
        ),
    ),
    "storage.pv": CapabilityUnit(
        id="storage.pv",
        title="Manage static persistent volumes",
        description="Create and clean up the local-disk or NFS PersistentVolumes owned by Lens.",
        check_rules=_verb_checks(("get", "create", "patch", "delete"), "", ("persistentvolumes",), "cluster"),
    ),
    "storage.pvc": CapabilityUnit(
        id="storage.pvc",
        title="Manage persistent volume claims",
        description="Create and clean up the PersistentVolumeClaims for the storage volume and the model-cache mount.",
        check_rules=_verb_checks(("get", "create", "patch", "delete"), "", ("persistentvolumeclaims",), "namespace"),
    ),
    "gateway.envoy-ai-gateway": CapabilityUnit(
        id="gateway.envoy-ai-gateway",
        title="Install Envoy AI Gateway",
        description="Install the Envoy Gateway and Envoy AI Gateway controllers and their CRDs.",
        check_rules=(
            *_checks("get", _GATEWAY_API, ("gatewayclasses",), "cluster"),
            *_checks("get", _GATEWAY_API, ("gateways", "httproutes", "grpcroutes"), "namespace"),
            *_checks("get", "gateway.envoyproxy.io", ("envoyproxies",), "namespace"),
            *_checks("get", "aigateway.envoyproxy.io", ("aigatewayroutes",), "namespace"),
            *_checks("create", "apps", ("deployments",), "namespace"),
            *_verb_checks(_INSTALLER_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
    "gateway.agentgateway": CapabilityUnit(
        id="gateway.agentgateway",
        title="Install Agent Gateway",
        description="Install the Agent Gateway controller and its CRDs.",
        check_rules=(
            *_checks("get", _GATEWAY_API, ("gatewayclasses",), "cluster"),
            *_checks("get", _GATEWAY_API, ("gateways", "httproutes"), "namespace"),
            *_checks("get", "agentgateway.dev", ("agentgatewaybackends",), "namespace"),
            *_checks("create", "apps", ("deployments",), "namespace"),
            *_verb_checks(_INSTALLER_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
    "gateway.istio": CapabilityUnit(
        id="gateway.istio",
        title="Install Istio",
        description="Install the Istio control plane, its CRDs, webhooks and APIServices.",
        check_rules=(
            *_checks("get", _GATEWAY_API, ("gatewayclasses",), "cluster"),
            *_checks("get", _GATEWAY_API, ("gateways", "httproutes"), "namespace"),
            *_checks("get", "networking.istio.io", ("virtualservices",), "namespace"),
            *_checks("get", "security.istio.io", ("peerauthentications",), "namespace"),
            *_checks("get", "install.istio.io", ("istiooperators",), "namespace"),
            *_checks("create", "apps", ("deployments",), "namespace"),
            *_verb_checks(_INSTALLER_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
    "gateway.gke": CapabilityUnit(
        id="gateway.gke",
        title="Use the GKE managed Gateway",
        description="Use the Gateway API resources provided by GKE; no provider install is required.",
        check_rules=(
            *_checks("get", _GATEWAY_API, ("gatewayclasses",), "cluster"),
            *_checks("get", _GATEWAY_API, ("gateways", "httproutes"), "namespace"),
        ),
    ),
    "accelerator.nvidia": CapabilityUnit(
        id="accelerator.nvidia",
        title="Install the NVIDIA accelerator stack",
        description=(
            "Install the NVIDIA device plugin or DRA driver, RuntimeClasses, Node Feature Discovery "
            "and monitoring objects. RBAC requirements are expressed by core.rbac.* units."
        ),
        check_rules=(
            *_verb_checks(
                ("create", "update", "patch"),
                "apps",
                ("daemonsets", "deployments", "statefulsets"),
                "namespace",
            ),
            *_verb_checks(
                ("create", "update", "patch"),
                "",
                ("serviceaccounts", "configmaps"),
                "namespace",
            ),
            *_verb_checks(("get", "create", "update", "patch"), "", ("services",), "namespace"),
            *_checks("get", "node.k8s.io", ("runtimeclasses",), "cluster"),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "resource.k8s.io",
                ("deviceclasses", "resourceslices"),
                "cluster",
            ),
            *_checks("get", "nvidia.com", ("clusterpolicies",), "cluster"),
            *_checks("get", "monitoring.coreos.com", ("servicemonitors",), "namespace"),
            *_verb_checks(_INSTALLER_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
    "accelerator.intel": CapabilityUnit(
        id="accelerator.intel",
        title="Install the Intel XPU stack",
        description=(
            "Install the Intel device plugin or DRA driver, Node Feature Discovery and XPU monitoring "
            "objects. RBAC requirements are expressed by core.rbac.* units."
        ),
        check_rules=(
            *_verb_checks(
                ("create", "update", "patch"),
                "apps",
                ("daemonsets", "deployments"),
                "namespace",
            ),
            *_verb_checks(
                ("create", "update", "patch"),
                "",
                ("serviceaccounts", "configmaps"),
                "namespace",
            ),
            *_checks("get", "node.k8s.io", ("runtimeclasses",), "cluster"),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "resource.k8s.io",
                ("deviceclasses", "resourceslices"),
                "cluster",
            ),
            *_verb_checks(
                ("create", "update", "patch"),
                "admissionregistration.k8s.io",
                ("validatingadmissionpolicies",),
                "cluster",
            ),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "nfd.k8s-sigs.io",
                ("nodefeaturerules",),
                "cluster",
            ),
            *_checks("get", "monitoring.coreos.com", ("servicemonitors",), "namespace"),
        ),
    ),
    "stack.lws": CapabilityUnit(
        id="stack.lws",
        title="Install LeaderWorkerSet",
        description="Install the LWS controller and its CRDs when the stack enables LeaderWorkerSet.",
        check_rules=(
            *_checks("get", "leaderworkerset.x-k8s.io", ("leaderworkersets",), "namespace"),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "apps",
                ("deployments", "statefulsets"),
                "namespace",
            ),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "",
                ("serviceaccounts", "configmaps", "services"),
                "namespace",
            ),
            *_verb_checks(
                ("get", "create", "update", "patch"),
                "rbac.authorization.k8s.io",
                ("roles", "rolebindings"),
                "namespace",
            ),
            *_verb_checks(_INSTALLER_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
    "cache.hf-secret.create": CapabilityUnit(
        id="cache.hf-secret.create",
        title="Create the HF token Secret",
        description="Check for a collision and create or update the plan's Hugging Face token Secret.",
        check_rules=_verb_checks(_MODEL_CACHE_SECRET_VERBS, "", ("secrets",), "namespace"),
    ),
    "cache.hf-secret.read": CapabilityUnit(
        id="cache.hf-secret.read",
        title="Read an existing HF token Secret",
        description="Read the named, pre-existing Hugging Face token Secret referenced by the plan.",
        check_rules=_checks("get", "", ("secrets",), "namespace"),
    ),
    "cache.prepull": CapabilityUnit(
        id="cache.prepull",
        title="Pre-pull images",
        description="Run the image pre-pull DaemonSet on the selected nodes.",
        check_rules=_verb_checks(("get", "create", "update", "patch"), "apps", ("daemonsets",), "namespace"),
    ),
    "cache.job": CapabilityUnit(
        id="cache.job",
        title="Download the model cache",
        description=(
            "Read the source HF Secret, materialize the fixed llm-d-hf-token Secret, and create/patch/delete "
            "the model-cache download Job and its Pods."
        ),
        check_rules=(
            *_verb_checks(("get", "create", "patch", "delete"), "batch", ("jobs",), "namespace"),
            *_verb_checks(("get", "create", "patch", "delete"), "", ("pods",), "namespace"),
            *_verb_checks(_MODEL_CACHE_SECRET_VERBS, "", ("secrets",), "namespace"),
        ),
    ),
}

#: ``--full``/legacy role uses every unit. TODO(M2): the documented full role
#: also has a wildcard read, ``deletecollection`` and broader non-resource
#: URLs; those stay out of the plan-scoped catalog until M2 and must not be
#: inferred from ``ALL_UNITS``.
ALL_UNITS: tuple[CapabilityUnit, ...] = tuple(CAPABILITY_UNITS.values())


def _selected_units(unit_ids: Iterable[str]) -> tuple[CapabilityUnit, ...]:
    selected: list[CapabilityUnit] = []
    for unit_id in unit_ids:
        try:
            selected.append(CAPABILITY_UNITS[unit_id])
        except KeyError:
            raise ValueError(f"unknown capability unit {unit_id!r}") from None
    return tuple(selected)


def _check_rule_sort_key(rule: CheckRule) -> tuple:
    return (
        rule.api_group,
        rule.resource,
        rule.verb,
        rule.scope,
        rule.subresource or "",
        rule.name or "",
        rule.namespace or "",
    )


def check_rules_for_units(unit_ids: Iterable[str]) -> tuple[CheckRule, ...]:
    """Static check rules for the selected units (full/static role only).

    Plan-scoped preflight uses :func:`check_rules_for_plan`, which narrows the
    HF/model-cache Secret checks to the names in the plan.
    """

    rules = {rule for unit in _selected_units(unit_ids) for rule in unit.check_rules}
    return tuple(sorted(rules, key=_check_rule_sort_key))


def _named_check(
    verb: str,
    name: str,
    *,
    resource: str = "secrets",
    api_group: str = "",
    scope: str = "namespace",
    namespace: str | None = None,
) -> CheckRule:
    return CheckRule(
        verb=verb,
        api_group=api_group,
        resource=resource,
        scope=scope,
        name=name,
        namespace=namespace,
    )


def _installer_namespaces_for_unit(unit_id: str, plan: ProvisioningPlan) -> tuple[str, ...]:
    """Fixed namespaces the selected installer unit writes to, if any."""

    namespaces: set[str] = set()
    if unit_id.startswith("gateway."):
        provider = plan.gateway.provider
        namespaces.update(GATEWAY_INSTALL_NAMESPACES.get(provider, ()))
    elif unit_id == "accelerator.nvidia":
        for accelerator in plan.accelerators:
            if accelerator.vendor == "nvidia":
                namespaces.update(NVIDIA_DRIVER_NAMESPACES.get(accelerator.mode, ()))
    elif unit_id == "accelerator.intel":
        for accelerator in plan.accelerators:
            if accelerator.vendor == "intel":
                namespaces.update(INTEL_DRIVER_NAMESPACES.get(accelerator.mode, ()))
    elif unit_id == "stack.lws" and plan.stack.lws_enabled:
        namespaces.add(LWS_NAMESPACE)
    return tuple(sorted(namespaces))


def _check_rules_for_plan_unit(unit: CapabilityUnit, plan: ProvisioningPlan) -> tuple[CheckRule, ...]:
    """Static checks for one unit, narrowed to the plan's names and namespaces."""

    installer_namespaces = _installer_namespaces_for_unit(unit.id, plan)
    if installer_namespaces:
        # The Helm installer itself manages its release Secret in the fixed
        # installer namespace, not in the gateway/storage/HF namespace. Pin the
        # generic catalog check to each installer namespace so the preflight
        # does not probe an unrelated namespace.
        checks = set()
        for check in unit.check_rules:
            if check.api_group == "" and check.resource == "secrets" and check.name is None:
                checks.update(replace(check, namespace=namespace) for namespace in installer_namespaces)
            else:
                checks.add(check)
        return tuple(sorted(checks, key=_check_rule_sort_key))

    if unit.id not in _PLAN_NARROWED_SECRET_UNITS:
        return unit.check_rules

    name = plan.hf_token_secret.secret_name
    if not name:
        # ``normalize_plan`` always fills a name; keep the static rules rather
        # than inventing an unnamed Secret check for a malformed plan.
        return unit.check_rules

    secret_namespace = plan.hf_token_secret.secret_namespace or None

    if unit.id == "cache.job":
        checks = {check for check in unit.check_rules if not (check.api_group == "" and check.resource == "secrets")}
        # Read the plan's source Secret in the HF namespace and materialize the
        # fixed token Secret in the model-cache Job's own namespace.
        checks.add(_named_check("get", name, namespace=secret_namespace))
        cache_namespace = _storage_namespace_for_plan(plan)
        checks.update(
            _named_check(verb, MODEL_CACHE_TOKEN_SECRET, namespace=cache_namespace)
            for verb in _MODEL_CACHE_SECRET_VERBS
        )
        return tuple(sorted(checks, key=_check_rule_sort_key))

    verbs = _MODEL_CACHE_SECRET_VERBS if unit.id == "cache.hf-secret.create" else ("get",)
    return tuple(_named_check(verb, name, namespace=secret_namespace) for verb in verbs)


def check_rules_for_plan(
    plan: ProvisioningPlan,
    unit_ids: Iterable[str] | None = None,
) -> tuple[tuple[str, CheckRule], ...]:
    """Plan-scoped check rules paired with the unit that requested them.

    Named HF/model-cache Secret checks use ``resourceAttributes.name``;
    installer Secret checks stay unnamed because Helm release state is stored
    in Secrets.
    """

    selected = _selected_units(unit_ids if unit_ids is not None else units_for_plan(plan))
    pairs = {(unit.id, check) for unit in selected for check in _check_rules_for_plan_unit(unit, plan)}
    return tuple(sorted(pairs, key=lambda pair: (pair[0], _check_rule_sort_key(pair[1]))))


def non_resource_checks_for_units(unit_ids: Iterable[str]) -> tuple[NonResourceCheck, ...]:
    checks = {check for unit in _selected_units(unit_ids) for check in unit.non_resource_checks}
    return tuple(sorted(checks, key=lambda check: (check.path, check.verb)))


def installer_namespaces_for_plan(plan: ProvisioningPlan) -> tuple[str, ...]:
    """Fixed namespaces the selected provider installers create themselves."""

    namespaces: set[str] = set()
    namespaces.update(GATEWAY_INSTALL_NAMESPACES.get(plan.gateway.provider, ()))
    for accelerator in plan.accelerators:
        if accelerator.vendor == "nvidia":
            namespaces.update(NVIDIA_DRIVER_NAMESPACES.get(accelerator.mode, ()))
        elif accelerator.vendor == "intel":
            namespaces.update(INTEL_DRIVER_NAMESPACES.get(accelerator.mode, ()))
    if plan.stack.lws_enabled:
        namespaces.add(LWS_NAMESPACE)
    return tuple(sorted(namespaces))


def _storage_namespace_for_plan(plan: ProvisioningPlan) -> str | None:
    if plan.storage.kind == "none":
        return None
    return plan.storage.namespace or STORAGE_NAMESPACE_PREFIX


def _model_cache_namespace_for_plan(plan: ProvisioningPlan) -> str | None:
    if not plan.model_cache.enabled:
        return None
    return plan.storage.namespace or STORAGE_NAMESPACE_PREFIX


def unit_namespaces(plan: ProvisioningPlan) -> dict[str, tuple[str, ...]]:
    """Namespace targets per capability unit for namespace-scoped checks.

    Namespace-scoped units target only the namespaces they actually write to:
    the plan's working namespaces, a fixed installer namespace, or the HF/model
    cache Secret namespace. Cluster-scoped units have no namespace target.
    Checks that name one precise namespace (``CheckRule.namespace``) override
    this mapping in the evaluator.
    """

    gateway_namespace = plan.gateway.namespace or None
    storage_namespace = _storage_namespace_for_plan(plan)
    model_cache_namespace = _model_cache_namespace_for_plan(plan)
    hf_namespace = plan.hf_token_secret.secret_namespace or None
    images_namespace = plan.stack.images_namespace or None
    lws_namespace = LWS_NAMESPACE if plan.stack.lws_enabled else None

    nvidia_namespaces: set[str] = set()
    intel_namespaces: set[str] = set()
    for accelerator in plan.accelerators:
        if accelerator.vendor == "nvidia":
            nvidia_namespaces.update(NVIDIA_DRIVER_NAMESPACES.get(accelerator.mode, ()))
        elif accelerator.vendor == "intel":
            intel_namespaces.update(INTEL_DRIVER_NAMESPACES.get(accelerator.mode, ()))

    plan_namespaces = tuple(
        sorted(
            {
                namespace
                for namespace in (
                    gateway_namespace,
                    storage_namespace,
                    model_cache_namespace,
                    hf_namespace,
                    images_namespace,
                    lws_namespace,
                    # A fixed installer namespace the plan writes to (currently
                    # the verified Intel DRA namespace) also needs the
                    # namespace-scoped read/workload/RBAC targets.
                    *intel_namespaces,
                )
                if namespace
            }
        )
    )

    gateway_namespaces = tuple(
        sorted(
            {
                namespace
                for namespace in (gateway_namespace, *GATEWAY_INSTALL_NAMESPACES.get(plan.gateway.provider, ()))
                if namespace
            }
        )
    )

    mapping: dict[str, tuple[str, ...]] = dict.fromkeys(CAPABILITY_UNITS, ())
    mapping.update(
        {
            "core.discovery": plan_namespaces,
            "core.discovery.secrets": (hf_namespace,) if hf_namespace else (),
            "core.workloads": plan_namespaces,
            "core.rbac.namespaced": plan_namespaces,
            "storage.pvc": (storage_namespace,) if storage_namespace else (),
            "gateway.gke": (gateway_namespace,) if gateway_namespace else (),
            "accelerator.nvidia": tuple(sorted(nvidia_namespaces)),
            "accelerator.intel": tuple(sorted(intel_namespaces)),
            "stack.lws": (LWS_NAMESPACE,) if plan.stack.lws_enabled else (),
            "cache.hf-secret.create": (hf_namespace,) if hf_namespace else (),
            "cache.hf-secret.read": (hf_namespace,) if hf_namespace else (),
            "cache.prepull": (images_namespace,) if images_namespace else (),
            "cache.job": (model_cache_namespace,) if model_cache_namespace else (),
        }
    )
    for provider in GATEWAY_INSTALL_NAMESPACES:
        mapping[f"gateway.{provider}"] = gateway_namespaces
    return mapping


def units_for_plan(plan: ProvisioningPlan) -> tuple[str, ...]:
    """Map a normalized plan to the capability units it needs."""

    units: set[str] = {"core.discovery"}

    gateway = plan.gateway
    if gateway.provider:
        if gateway.provider == "gke":
            units.add("gateway.gke")
        else:
            units.add(f"gateway.{gateway.provider}")
            units.add("core.crds")
            units.add("core.rbac.escalation")
            # Provider charts also create namespaced RBAC for their workloads.
            units.add("core.rbac.namespaced")
            # Every non-GKE provider installer uses ``--create-namespace`` (or
            # istioctl's default namespace), so the plan must be allowed to
            # create its fixed system namespace(s).
            units.add("core.namespaces")
            if gateway.provider == "istio":
                units.add("core.admission")
        if gateway.namespace_mode == "create":
            units.add("core.namespaces")

    for accelerator in plan.accelerators:
        accelerator_unit = f"accelerator.{accelerator.vendor}"
        if accelerator_unit not in CAPABILITY_UNITS:
            raise ValueError(f"unknown accelerator capability unit {accelerator_unit!r}")
        units.add(accelerator_unit)
        for requirement in accelerator.rbac:
            if requirement == "namespaced":
                units.add("core.rbac.namespaced")
            elif requirement == "cluster":
                units.add("core.rbac.cluster")
            elif requirement == "escalation":
                units.add("core.rbac.escalation")
        # The Intel manifests install admission and API registration objects.
        # The DRA base manifest also creates ``intel-gpu-resource-driver``; the
        # device-plugin overlay has no verified fixed namespace.
        if accelerator.vendor == "intel":
            units.add("core.admission")
            # Shared NFD installs the node-feature-discovery namespace and its
            # CRDs/workloads for either access mode; DRA also owns its driver
            # namespace.
            units.add("core.namespaces")
            units.add("core.crds")
            units.add("core.workloads")
        # The NVIDIA Helm install always passes ``--create-namespace`` and its
        # charts create namespaced RBAC for their workloads. The DRA chart also
        # creates ValidatingAdmissionPolicy objects.
        if accelerator.vendor == "nvidia":
            units.add("core.namespaces")
            units.add("core.rbac.namespaced")
            if accelerator.mode == "dra":
                units.add("core.admission")

    storage = plan.storage
    if storage.kind in {"local-disk", "nfs"}:
        units.add("storage.pv")
        units.add("storage.pvc")
    elif storage.kind == "dynamic-pvc":
        units.add("storage.pvc")
    if storage.kind != "none" and storage.namespace_mode == "create":
        units.add("core.namespaces")

    secret = plan.hf_token_secret
    if secret.token_source == "create-secret":  # noqa: S105 - token source value, not a credential
        units.add("cache.hf-secret.create")
        if secret.secret_namespace_mode == "create":  # noqa: S105 - namespace mode value
            units.add("core.namespaces")
    elif secret.token_source.startswith("existing-secret:"):
        units.add("cache.hf-secret.read")
        units.add("core.discovery.secrets")

    stack = plan.stack
    cache = plan.model_cache
    if plan.runtime.inotify_enabled or stack.image_prepull_enabled or cache.enabled:
        units.add("core.workloads")
    if cache.enabled:
        units.add("cache.job")
        if storage.kind != "none":
            units.add("storage.pvc")
    if stack.image_prepull_enabled:
        units.add("cache.prepull")
        if stack.images_namespace_mode == "create":
            units.add("core.namespaces")
    if stack.lws_enabled:
        units.add("stack.lws")
        units.add("core.crds")
        units.add("core.rbac.escalation")
        units.add("core.rbac.namespaced")
        # The LWS Helm operation passes ``--create-namespace`` for ``lws-system`` and
        # the chart creates admission webhooks.
        units.add("core.namespaces")
        units.add("core.admission")
    if stack.crds_enabled:
        units.add("core.crds")

    return tuple(sorted(units))


def enabled_steps(plan: ProvisioningPlan) -> tuple[str, ...]:
    """Enabled catalog step groups in design order.

    A group is included only when the normalized plan actually needs it.
    ``hf-secret`` always runs because every plan stores an HF token Secret
    reference.
    """

    enabled = {
        "prepare": plan.runtime.inotify_enabled,
        "gateway": bool(plan.gateway.provider),
        "gpu": bool(plan.accelerators),
        "crds": plan.stack.crds_enabled,
        "prepull": plan.stack.image_prepull_enabled,
        "lws": plan.stack.lws_enabled,
        "hf-secret": True,
        "storage": plan.storage.kind != "none",
        "model-cache": plan.model_cache.enabled,
    }
    return tuple(step for step in EXECUTION_STEP_ORDER if enabled[step])


def step_units(plan: ProvisioningPlan, step: str) -> tuple[str, ...]:
    """Capability units that one guarded execution step must evaluate.

    This is the plan projection for a single endpoint, so the union of the
    executed steps plus ``core.discovery`` matches :func:`units_for_plan`.
    ``storage``, ``gpu`` and ``model-cache`` are mapped here for the endpoints
    delivered in the next phase.
    """

    if step == "prepare":
        return ("core.workloads",)

    if step == "gateway":
        units: set[str] = set()
        provider = plan.gateway.provider
        if provider == "gke":
            units.add("gateway.gke")
            # GKE has no provider installer, so only a namespace the plan
            # explicitly creates needs core.namespaces.
            if plan.gateway.namespace_mode == "create":
                units.add("core.namespaces")
        elif provider:
            units.add(f"gateway.{provider}")
            units.add("core.crds")
            units.add("core.rbac.escalation")
            units.add("core.rbac.namespaced")
            # Every non-GKE provider installer creates its fixed system
            # namespace(s) with ``--create-namespace`` (or istioctl's default
            # namespace), so the step always needs core.namespaces.
            units.add("core.namespaces")
            if provider == "istio":
                units.add("core.admission")
        return tuple(sorted(units))

    if step == "crds":
        return ("core.crds",)

    if step == "prepull":
        units = {"cache.prepull", "core.workloads"}
        if plan.stack.images_namespace_mode == "create":
            units.add("core.namespaces")
        return tuple(sorted(units))

    if step == "lws":
        return tuple(
            sorted(
                {
                    "stack.lws",
                    "core.crds",
                    "core.rbac.escalation",
                    "core.rbac.namespaced",
                    "core.namespaces",
                    "core.admission",
                }
            )
        )

    if step == "hf-secret":
        units = set()
        token_source = plan.hf_token_secret.token_source
        if token_source == "create-secret":  # noqa: S105 - token source value, not a credential
            units.add("cache.hf-secret.create")
        elif token_source.startswith("existing-secret:"):
            units.add("cache.hf-secret.read")
            units.add("core.discovery.secrets")
        else:
            raise ValueError(f"unknown HF token source {token_source!r}")
        if plan.hf_token_secret.secret_namespace_mode == "create":  # noqa: S105 - namespace mode value
            units.add("core.namespaces")
        return tuple(sorted(units))

    if step == "storage":
        units = set()
        if plan.storage.kind in {"local-disk", "nfs"}:
            units.update(("storage.pv", "storage.pvc"))
        elif plan.storage.kind == "dynamic-pvc":
            units.add("storage.pvc")
        if plan.storage.kind != "none" and plan.storage.namespace_mode == "create":
            units.add("core.namespaces")
        return tuple(sorted(units))

    if step == "gpu":
        units = set()
        for accelerator in plan.accelerators:
            units.add(f"accelerator.{accelerator.vendor}")
            for requirement in accelerator.rbac:
                if requirement == "namespaced":
                    units.add("core.rbac.namespaced")
                elif requirement == "cluster":
                    units.add("core.rbac.cluster")
                elif requirement == "escalation":
                    units.add("core.rbac.escalation")
            if accelerator.vendor == "intel":
                units.add("core.admission")
                units.add("core.namespaces")
                units.add("core.crds")
                units.add("core.workloads")
            if accelerator.vendor == "nvidia":
                units.add("core.namespaces")
                units.add("core.rbac.namespaced")
                if accelerator.mode == "dra":
                    units.add("core.admission")
        return tuple(sorted(units))

    if step == "model-cache":
        units = {"cache.job", "core.workloads"}
        if plan.storage.kind != "none":
            units.add("storage.pvc")
        return tuple(sorted(units))

    raise ValueError(f"unknown execution step {step!r}")
