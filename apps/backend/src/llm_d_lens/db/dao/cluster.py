"""DAO backing ``llm_d_lens.cluster.registry`` -- see design doc section 5.4.1."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import uuid4

from sqlalchemy import func, or_, select, update

from llm_d_lens.cluster.registry import Cluster
from llm_d_lens.db.dao.base import BaseDao
from llm_d_lens.db.models.cluster import ClusterRow


class ClusterDaoError(Exception):
    """Raised for cluster-repository failures that aren't already a domain error."""


_PLAN_MIRRORED_COLUMNS: frozenset[str] = frozenset(
    {
        "gateway_provider",
        "gateway_namespace",
        "gateway_name",
        "gateway_public_url",
        "gateway_port",
        "gateway_authz_host",
        "inotify_max_user_instances",
        "router_version",
        "gie_version",
        "ipp_version",
        "hf_token_secret_namespace",
        "hf_token_secret_name",
    }
)
_PLAN_CAS_MAX_ATTEMPTS = 3


class ClusterDao(BaseDao):
    def create(
        self,
        name: str,
        description: str,
        kubeconfig_text: str,
        *,
        proxy_mode: str = "auto",
        http_proxy: str | None = None,
        https_proxy: str | None = None,
        no_proxy: str | None = None,
        llm_d_ref: str | None = None,
        llm_d_lensmark_ref: str | None = None,
        gateway_provider: str | None = None,
        gateway_namespace: str | None = None,
        gateway_name: str | None = None,
        gateway_public_url: str | None = None,
        gateway_port: int | None = None,
        gateway_authz_host: str | None = None,
        inotify_max_user_instances: int = 8192,
        router_version: str | None = None,
        gie_version: str | None = None,
        ipp_version: str | None = None,
        vllm_image: str | None = None,
        draft: bool = False,
        owner_user_id: str | None = None,
    ) -> Cluster:
        with self._transaction() as session:
            cluster_id = self._new_cluster_id(session)
            created_at = datetime.now(UTC)
            row = ClusterRow(
                id=cluster_id,
                name=name,
                description=description,
                owner_user_id=owner_user_id or None,
                kubeconfig=kubeconfig_text,
                draft=draft,
                proxy_mode=proxy_mode if proxy_mode in ("auto", "custom") else "auto",
                proxy_http_proxy=http_proxy or None,
                proxy_https_proxy=https_proxy or None,
                proxy_no_proxy=no_proxy or None,
                llm_d_ref=llm_d_ref or None,
                llm_d_lensmark_ref=llm_d_lensmark_ref or None,
                gateway_provider=gateway_provider or None,
                gateway_namespace=gateway_namespace or None,
                gateway_name=gateway_name or None,
                gateway_public_url=gateway_public_url or None,
                gateway_port=gateway_port or None,
                gateway_authz_host=gateway_authz_host or None,
                inotify_max_user_instances=inotify_max_user_instances,
                router_version=router_version or None,
                gie_version=gie_version or None,
                ipp_version=ipp_version or None,
                provisioning_plan={"stack": {"vllmImage": vllm_image}} if vllm_image else None,
                created_at=created_at,
            )
            session.add(row)
            session.flush()
            return row.to_dto()

    def _new_cluster_id(self, session) -> str:  # noqa: ANN001
        while True:
            candidate = uuid4().hex[:8]
            if session.get(ClusterRow, candidate) is None:
                return candidate

    def list(self, *, include_drafts: bool = False) -> list[Cluster]:
        with self._read_only() as session:
            stmt = select(ClusterRow).order_by(ClusterRow.created_at, ClusterRow.id)
            if not include_drafts:
                stmt = stmt.where(ClusterRow.draft.is_(False))
            return [row.to_dto() for row in session.scalars(stmt)]

    def get(self, cluster_id: str) -> Cluster | None:
        with self._read_only() as session:
            row = session.get(ClusterRow, cluster_id)
            return row.to_dto() if row else None

    def get_row(self, cluster_id: str) -> ClusterRow | None:
        """Escape hatch for callers (e.g. update_cluster) that need to see ``kubeconfig``."""
        with self._read_only() as session:
            return session.get(ClusterRow, cluster_id)

    def read_kubeconfig(self, cluster_id: str) -> str | None:
        with self._read_only() as session:
            row = session.get(ClusterRow, cluster_id)
            return row.kubeconfig if row else None

    def get_provisioning_plan(self, cluster_id: str) -> dict[str, Any] | None:
        with self._read_only() as session:
            row = session.get(ClusterRow, cluster_id)
            return row.provisioning_plan if row else None

    def get_monitoring_source_fields(self, cluster_id: str) -> dict[str, Any] | None:
        """Return raw ``provisioning_plan``, ``gateway_public_url``, and ``kubeconfig`` for monitoring resolution."""
        with self._read_only() as session:
            row = session.execute(
                select(
                    ClusterRow.provisioning_plan,
                    ClusterRow.gateway_public_url,
                    ClusterRow.kubeconfig,
                ).where(ClusterRow.id == cluster_id)
            ).first()
            if row is None:
                return None
            return {
                "provisioning_plan": row.provisioning_plan,
                "gateway_public_url": row.gateway_public_url,
                "kubeconfig": row.kubeconfig,
            }

    def update_monitoring_plan(
        self,
        cluster_id: str,
        monitoring_payload: Mapping[str, Any],
        *,
        invalidate_execution: bool = False,
    ) -> Cluster | None:
        """Atomically update ``provisioning_plan['monitoring']`` without touching unrelated plan keys."""
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return None
            raw = dict(row.provisioning_plan) if isinstance(row.provisioning_plan, Mapping) else {}
            raw["monitoring"] = dict(monitoring_payload)
            row.provisioning_plan = raw
            if invalidate_execution:
                row.execution_operations = None
                row.execution_completed_at = None
                row.execution_completed_plan_hash = None
            session.flush()
            return row.to_dto()

    def set_provisioning_plan(
        self,
        cluster_id: str,
        plan: dict[str, Any],
        *,
        invalidate_execution: bool = False,
    ) -> bool:
        """Persist the plan; optionally clear ledgers bound to the previous one.

        ``invalidate_execution`` runs in the same transaction so a plan change
        cannot leave a completed step/operation ledger or completion timestamp
        that would let finalize accept the old run.
        """
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return False
            row.provisioning_plan = plan
            if invalidate_execution:
                row.execution_operations = None
                row.execution_completed_at = None
                row.execution_completed_plan_hash = None
            return True

    def compare_and_set_draft_provisioning_plan(
        self,
        cluster_id: str,
        plan: dict[str, Any],
        *,
        stale_before: datetime,
        expected_plan_hash: str | None = None,
        new_plan_hash: str | None = None,
        plan_hasher: Callable[[dict[str, Any]], str | None] | None = None,
        mirrored_columns: Mapping[str, Any] | None = None,
        invalidate_execution: bool = True,
    ) -> Literal["updated", "not_found", "not_draft", "execution_in_progress", "plan_conflict"]:
        """Atomically update a draft cluster's plan, mirrored columns, and execution state.

        Retries up to 3 attempts when an unrelated write (e.g., repo download
        progress) bumps ``version_id`` without changing draft/lock/plan state.
        """
        if expected_plan_hash is not None and plan_hasher is None:
            raise ValueError("plan_hasher is required when expected_plan_hash is set")
        extra_values: dict[str, Any] = {}
        if mirrored_columns is not None:
            unknown = set(mirrored_columns) - _PLAN_MIRRORED_COLUMNS
            if unknown:
                raise ValueError(f"unknown mirrored plan column(s): {', '.join(sorted(unknown))}")
            extra_values = dict(mirrored_columns)

        table = ClusterRow.__table__
        for _ in range(_PLAN_CAS_MAX_ATTEMPTS):
            with self._transaction() as session:
                row = session.get(ClusterRow, cluster_id)
                if row is None:
                    return "not_found"
                if not row.draft:
                    return "not_draft"
                if (
                    row.execution_token
                    and row.execution_heartbeat_at is not None
                    and row.execution_heartbeat_at >= stale_before
                ):
                    return "execution_in_progress"
                stored_hash = (
                    plan_hasher(row.provisioning_plan)
                    if row.provisioning_plan is not None and plan_hasher is not None
                    else None
                )
                if expected_plan_hash is not None and stored_hash != expected_plan_hash:
                    return "plan_conflict"

                should_invalidate = bool(invalidate_execution) and (
                    new_plan_hash is None or stored_hash != new_plan_hash
                )
                expected_version = row.version_id
                values: dict[str, Any] = {
                    "provisioning_plan": plan,
                    "version_id": expected_version + 1,
                    **extra_values,
                }
                if should_invalidate:
                    values["execution_operations"] = None
                    values["execution_completed_at"] = None
                    values["execution_completed_plan_hash"] = None

                result = session.execute(
                    update(table)
                    .where(
                        table.c.id == cluster_id,
                        table.c.draft.is_(True),
                        table.c.version_id == expected_version,
                        or_(
                            table.c.execution_token.is_(None),
                            table.c.execution_token == "",
                            table.c.execution_heartbeat_at.is_(None),
                            table.c.execution_heartbeat_at < stale_before,
                        ),
                    )
                    .values(**values)
                )
                if result.rowcount == 1:
                    return "updated"
        return "plan_conflict"

    def get_owner_user_id(self, cluster_id: str) -> str | None:
        with self._read_only() as session:
            return session.scalar(select(ClusterRow.owner_user_id).where(ClusterRow.id == cluster_id))

    def get_execution_state(self, cluster_id: str) -> dict[str, Any] | None:
        with self._read_only() as session:
            row = session.execute(
                select(
                    ClusterRow.execution_token,
                    ClusterRow.execution_started_at,
                    ClusterRow.execution_heartbeat_at,
                    ClusterRow.execution_cancel_requested,
                ).where(ClusterRow.id == cluster_id)
            ).first()
            if row is None:
                return None
            return {
                "token": row.execution_token,
                "started_at": row.execution_started_at,
                "heartbeat_at": row.execution_heartbeat_at,
                "cancel_requested": row.execution_cancel_requested,
            }

    def try_acquire_execution(
        self,
        cluster_id: str,
        token: str,
        *,
        now: datetime,
        stale_before: datetime,
    ) -> bool:
        """Take over an idle or expired execution lock; returns whether it won the CAS."""
        table = ClusterRow.__table__
        return self._cas_update(
            cluster_id,
            {
                "execution_token": token,
                "execution_started_at": now,
                "execution_heartbeat_at": now,
                "execution_cancel_requested": False,
                # A new run starts from a clean operation ledger so a completed
                # run cannot satisfy the next run's check.
                "execution_operations": None,
                "execution_completed_at": None,
                "execution_completed_plan_hash": None,
            },
            or_(
                table.c.execution_token.is_(None),
                table.c.execution_token == "",
                table.c.execution_heartbeat_at.is_(None),
                table.c.execution_heartbeat_at < stale_before,
            ),
        )

    def refresh_execution_heartbeat(self, cluster_id: str, token: str, now: datetime) -> bool:
        table = ClusterRow.__table__
        return self._cas_update(
            cluster_id,
            {"execution_heartbeat_at": now},
            table.c.execution_token == token,
        )

    def request_execution_cancel(self, cluster_id: str, token: str, *, force: bool = False) -> bool:
        """Set the cancel flag for ``token`` (or any active run when ``force`` is true)."""
        table = ClusterRow.__table__
        conditions = (table.c.execution_token.is_not(None),) if force else (table.c.execution_token == token,)
        return self._cas_update(
            cluster_id,
            {"execution_cancel_requested": True},
            *conditions,
        )

    def release_execution(self, cluster_id: str, token: str) -> bool:
        table = ClusterRow.__table__
        return self._cas_update(
            cluster_id,
            {
                "execution_token": None,
                "execution_started_at": None,
                "execution_heartbeat_at": None,
                "execution_cancel_requested": False,
            },
            table.c.execution_token == token,
        )

    def get_execution_operations(self, cluster_id: str) -> dict[str, str] | None:
        """Return the current plan's operation ledger, ``{}`` when empty, or ``None`` for an unknown cluster."""
        with self._read_only() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return None
            return dict(row.execution_operations or {})

    def set_execution_operations(self, cluster_id: str, operations: dict[str, str]) -> bool:
        """Replace the operation ledger; returns whether the cluster exists."""
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return False
            row.execution_operations = dict(operations)
            return True

    def clear_execution_operations(self, cluster_id: str) -> bool:
        """Drop the operation ledger (a plan change invalidates it); returns whether the cluster exists."""
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return False
            row.execution_operations = None
            return True

    def mark_execution_operation(self, cluster_id: str, token: str, operation_id: str, status: str) -> bool:
        """Record ``status`` for one operation of the run owned by ``token``."""

        if not token or status not in {"user_done", "admin_done", "lens_done", "failed_permission", "failed"}:
            return False
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None or row.execution_token != token:
                return False
            ledger = dict(row.execution_operations or {})
            ledger[operation_id] = status
            row.execution_operations = ledger
            return True

    def mark_execution_operations(
        self,
        cluster_id: str,
        token: str,
        statuses: Mapping[str, str],
    ) -> bool:
        """Atomically record several operation statuses for the run owned by ``token``."""
        if not token or not statuses:
            return False
        if any(
            status not in {"user_done", "admin_done", "lens_done", "failed_permission", "failed"}
            for status in statuses.values()
        ):
            return False
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None or row.execution_token != token:
                return False
            ledger = dict(row.execution_operations or {})
            ledger.update(statuses)
            row.execution_operations = ledger
            return True

    def complete_execution(
        self,
        cluster_id: str,
        token: str,
        *,
        now: datetime | None = None,
        plan_hash: str | None = None,
    ) -> bool:
        """Finish the run owned by ``token``: set ``execution_completed_at`` and clear the lock.

        The step ledger and completion timestamp survive so the finalize guard
        can still see that this cluster's plan ran to completion.
        """
        if not token:
            return False
        table = ClusterRow.__table__
        return self._cas_update(
            cluster_id,
            {
                "execution_completed_at": now or datetime.now(UTC),
                "execution_completed_plan_hash": plan_hash,
                "execution_token": None,
                "execution_started_at": None,
                "execution_heartbeat_at": None,
                "execution_cancel_requested": False,
            },
            table.c.execution_token == token,
        )

    def finalize_execution(
        self,
        cluster_id: str,
        token: str,
        *,
        now: datetime | None = None,
        plan_hash: str,
    ) -> bool:
        """Atomically mark the draft active and release the run lock."""
        if not token:
            return False
        table = ClusterRow.__table__
        return self._cas_update(
            cluster_id,
            {
                "draft": False,
                "execution_completed_at": now or datetime.now(UTC),
                "execution_completed_plan_hash": plan_hash,
                "execution_token": None,
                "execution_started_at": None,
                "execution_heartbeat_at": None,
                "execution_cancel_requested": False,
            },
            table.c.execution_token == token,
        )

    def get_execution_completed_plan_hash(self, cluster_id: str) -> str | None:
        with self._read_only() as session:
            return session.scalar(select(ClusterRow.execution_completed_plan_hash).where(ClusterRow.id == cluster_id))

    def is_execution_completed(self, cluster_id: str, plan_hash: str | None = None) -> bool:
        """Whether this cluster's current plan run has reported completion.

        When ``plan_hash`` is supplied the recorded completion must belong to
        that exact normalized plan; old rows without a recorded hash are stale.
        """

        with self._read_only() as session:
            row = session.execute(
                select(
                    ClusterRow.execution_completed_at,
                    ClusterRow.execution_completed_plan_hash,
                ).where(ClusterRow.id == cluster_id)
            ).first()
            if row is None or row.execution_completed_at is None:
                return False
            return plan_hash is None or row.execution_completed_plan_hash == plan_hash

    def get_execution_completed_at(self, cluster_id: str) -> datetime | None:
        """When the cluster's current plan run completed, or ``None``."""
        with self._read_only() as session:
            return session.scalar(select(ClusterRow.execution_completed_at).where(ClusterRow.id == cluster_id))

    def _cas_update(self, cluster_id: str, values: dict[str, Any], *conditions: object) -> bool:
        """Run a conditional UPDATE and report whether exactly one cluster row matched.

        Uses the Core table rather than an ORM instance so these execution-lock
        writes do not contend with the row's ``version_id`` optimistic lock.
        """
        table = ClusterRow.__table__
        with self._transaction() as session:
            result = session.execute(update(table).where(table.c.id == cluster_id, *conditions).values(**values))
            return result.rowcount == 1

    def update(
        self,
        cluster_id: str,
        *,
        monitoring_plan: Mapping[str, Any] | None = None,
        update_vllm_image: bool = False,
        vllm_image: str | None = None,
        invalidate_execution: bool = False,
        stale_before: datetime | None = None,
        **updates: object,
    ) -> Cluster | None:
        """Patch a subset of a cluster's mutable columns and/or monitoring plan atomically."""
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return None
            if (
                stale_before is not None
                and row.draft
                and row.execution_token
                and row.execution_heartbeat_at is not None
                and row.execution_heartbeat_at >= stale_before
            ):
                raise ClusterDaoError("execution_in_progress")
            for column in (
                "name",
                "description",
                "proxy_mode",
                "llm_d_ref",
                "llm_d_lensmark_ref",
                "llm_d_repo_path",
                "llm_d_lensmark_repo_path",
                "hf_token_secret_namespace",
                "hf_token_secret_name",
                "gateway_provider",
                "gateway_namespace",
                "gateway_name",
                "gateway_public_url",
                "gateway_port",
                "gateway_authz_host",
                "inotify_max_user_instances",
                "router_version",
                "gie_version",
                "ipp_version",
                "draft",
            ):
                if column in updates:
                    setattr(row, column, updates[column])
            # Public kwarg names (http_proxy/...) differ from column names
            # (proxy_http_proxy/...); map them explicitly rather than adding
            # them to the loop above.
            for public_name, column_name in (
                ("http_proxy", "proxy_http_proxy"),
                ("https_proxy", "proxy_https_proxy"),
                ("no_proxy", "proxy_no_proxy"),
            ):
                if public_name in updates:
                    setattr(row, column_name, updates[public_name])
            if "kubeconfig" in updates:
                row.kubeconfig = updates["kubeconfig"]
            if monitoring_plan is not None or update_vllm_image:
                raw = dict(row.provisioning_plan) if isinstance(row.provisioning_plan, Mapping) else {}
                if monitoring_plan is not None:
                    raw["monitoring"] = dict(monitoring_plan)
                if update_vllm_image and (raw or vllm_image is not None):
                    stack = dict(raw.get("stack")) if isinstance(raw.get("stack"), Mapping) else {}
                    stack.pop("vllm_image", None)
                    stack["vllmImage"] = vllm_image
                    raw["stack"] = stack
                if raw:
                    row.provisioning_plan = raw
            if invalidate_execution:
                row.execution_operations = None
                row.execution_completed_at = None
                row.execution_completed_plan_hash = None
            session.flush()
            return row.to_dto()

    def delete(self, cluster_id: str) -> bool:
        with self._transaction() as session:
            row = session.get(ClusterRow, cluster_id)
            if row is None:
                return False
            session.delete(row)
            return True

    def name_taken(self, name: str, *, exclude_id: str | None = None) -> bool:
        with self._read_only() as session:
            stmt = select(ClusterRow.id).where(
                ClusterRow.draft.is_(False), func.lower(ClusterRow.name) == name.strip().lower()
            )
            if exclude_id is not None:
                stmt = stmt.where(ClusterRow.id != exclude_id)
            return session.execute(stmt).first() is not None
