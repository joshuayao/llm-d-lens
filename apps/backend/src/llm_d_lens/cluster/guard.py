"""Execution guard: stored plan, freshness hash, lock token and capabilities.

Every guarded execution endpoint loads the stored plan, rejects a stale or
missing plan, validates the execution token, and evaluates only the endpoint's
capability units. See
``docs/design/cluster-permission-preflight-design.md`` sections 4.4 and 4.4.1.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from llm_d_lens.db.dao.cluster import ClusterDao

from . import execution
from .errors import ClusterOverviewError
from .evaluator import OperationReport
from .plan import PlanHashes, PlanValidationError, ProvisioningPlan, normalize_plan, plan_hashes
from .registry import is_monitoring_only_plan

__all__ = [
    "GuardError",
    "PlanState",
    "begin_user_operation",
    "guard_problem",
    "load_plan",
    "operation_ledger",
    "record_operation",
    "require_execution_token",
    "require_operation",
    "require_plan",
]

_GUARD_TITLES = {
    "plan_missing": "Provisioning plan missing",
    "permission_check_stale": "Permission check is stale",
    "execution_in_progress": "Execution in progress",
    "execution_token_invalid": "Execution token invalid",
    "execution_cancelled": "Execution cancelled",
    "kubernetes_permission_denied": "Kubernetes permission denied",
    "capability_check_unavailable": "Permission check unavailable",
    "plan_resave_required": "Provisioning plan must be re-saved",
}


class GuardError(Exception):
    """A guard rejection with the HTTP problem fields the router needs."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra


def guard_problem(error: GuardError) -> Any:
    """Map a guard rejection to the API's ``application/problem+json`` response.

    Imported lazily so the guard domain module does not require FastAPI at
    module-load time; endpoint modules call this from their rejection paths.
    """

    from llm_d_lens.api.problems import problem  # noqa: PLC0415

    return problem(
        error.status_code,
        _GUARD_TITLES.get(error.code, "Execution request rejected"),
        error.message,
        error.code,
        extra=error.extra,
        expose_detail=True,
    )


@dataclass(frozen=True)
class PlanState:
    plan: ProvisioningPlan
    plan_hash: str
    plan_version: int
    #: An old stored plan that predates a field the catalog now depends on
    #: (currently ``gateway.serviceType``) must be re-saved before execution.
    requires_resave: bool = False

    @classmethod
    def from_hashes(
        cls,
        plan: ProvisioningPlan,
        hashes: PlanHashes,
        *,
        requires_resave: bool = False,
    ) -> PlanState:
        return cls(
            plan=plan,
            plan_hash=hashes.plan_hash,
            plan_version=hashes.plan_version,
            requires_resave=requires_resave,
        )


def load_plan(cluster_id: str) -> PlanState | None:
    """Load and hash the stored plan; ``None`` when the cluster has no plan."""

    raw = ClusterDao().get_provisioning_plan(cluster_id)
    if raw is None or is_monitoring_only_plan(raw):
        return None
    # Normalize on load so old stored plans get current defaults (for example
    # ``lwsVersion``) and their hash covers what the catalog will execute. An
    # invalid raw plan stays loadable so callers can return their explicit
    # ``plan_invalid`` response instead of a 500.
    gateway_raw = raw.get("gateway") if isinstance(raw, Mapping) else None
    model_cache_raw = raw.get("modelCache") if isinstance(raw, Mapping) else None
    model_cache_enabled = bool(model_cache_raw.get("enabled")) if isinstance(model_cache_raw, Mapping) else False
    missing_entry_id = model_cache_enabled and not (
        isinstance(model_cache_raw, Mapping) and "entryId" in model_cache_raw
    )
    requires_resave = not (isinstance(gateway_raw, Mapping) and "serviceType" in gateway_raw) or missing_entry_id
    try:
        plan = normalize_plan(raw, cluster_id=cluster_id)
    except (PlanValidationError, ValidationError) as error:
        raise ClusterOverviewError(
            "The stored provisioning plan is invalid; save the plan again",
            status_code=409,
            code="plan_invalid",
            title="Provisioning plan is invalid",
        ) from error
    return PlanState.from_hashes(plan, plan_hashes(plan), requires_resave=requires_resave)


def require_plan(cluster_id: str, expected_hash: str | None) -> PlanState:
    """Load the plan, rejecting a missing plan or a stale client hash."""

    state = load_plan(cluster_id)
    if state is None:
        raise GuardError(409, "plan_missing", "No provisioning plan is stored for this cluster")
    if state.requires_resave:
        raise GuardError(
            409,
            "plan_resave_required",
            "The stored plan predates the current plan format; save the plan and re-check permissions",
        )
    if expected_hash is not None and expected_hash != state.plan_hash:
        raise GuardError(
            409,
            "permission_check_stale",
            "The stored plan changed after the last permission check",
        )
    return state


def require_execution_token(cluster_id: str, token: str | None) -> None:
    """Require the live execution token and refresh its heartbeat."""

    if not token or not execution.refresh(cluster_id, token):
        raise GuardError(
            409,
            "execution_token_invalid",
            "The execution token is missing, expired or no longer owns the run",
        )


def require_operation(report: OperationReport, operation_id: str) -> dict[str, Any]:
    """Return a user operation entry; admin/lens operations are rejected."""

    for entry in report.user_operations:
        if entry.get("id") == operation_id:
            return entry
    for entry in report.blocked_operations:
        if entry.get("id") == operation_id:
            raise GuardError(
                409,
                "operation_blocked",
                f"Operation {operation_id!r} is blocked until its user-owned access is fixed",
                extra={"operation_id": operation_id, "missing": entry.get("missing", [])},
            )
    for entry in report.admin_operations:
        if entry.get("id") == operation_id:
            raise GuardError(
                409,
                "admin_operation_required",
                f"Operation {operation_id!r} must be run by the Orchestration administrator",
                extra={"operation_id": operation_id},
            )
    for entry in report.lens_operations:
        if entry.get("id") == operation_id:
            raise GuardError(
                409,
                "admin_operation_required",
                f"Operation {operation_id!r} is executed by Lens on execution/complete",
                extra={"operation_id": operation_id},
            )
    raise GuardError(404, "operation_not_found", f"Unknown operation {operation_id!r}")


def begin_user_operation(
    cluster_id: str,
    *,
    plan_hash: str,
    execution_token: str | None = None,
) -> tuple[str, bool]:
    """Validate the plan and acquire or refresh the user execution token.

    Returns ``(token, acquired)``. The caller records the operation only after
    it succeeds, via :func:`record_operation`.
    """

    require_plan(cluster_id, plan_hash)
    if execution_token:
        require_execution_token(cluster_id, execution_token)
        return execution_token, False
    token = execution.acquire(cluster_id)
    return token, True


def record_operation(cluster_id: str, token: str, operation_id: str, status: str) -> bool:
    """Record a user/admin/lens/failed status in the operation ledger."""

    return execution.mark_operation(cluster_id, token, operation_id, status)


def operation_ledger(cluster_id: str) -> dict[str, str] | None:
    """Return the current plan's operation ledger."""

    return execution.operations(cluster_id)
