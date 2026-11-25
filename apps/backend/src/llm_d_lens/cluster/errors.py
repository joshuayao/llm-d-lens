"""Domain errors for the cluster overview service."""

from __future__ import annotations

from collections.abc import Mapping


class ClusterOverviewError(Exception):
    """An expected cluster-overview failure mapped to an HTTP problem response."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 502,
        code: str = "cluster_request_failed",
        title: str | None = None,
        extra: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.title = title or "Cluster request failed"
        self.extra = dict(extra or {})

    def problem(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "type": "about:blank",
            "status": self.status_code,
            "title": self.title,
            "detail": self.message,
            "code": self.code,
            "error": self.message,
        }
        payload.update(self.extra)
        return payload


class CleanupPermissionDenied(ClusterOverviewError):  # noqa: N818 - name fixed by the design contract
    """Namespace cleanup could not enumerate namespaced resources.

    Cleanup is fail-closed: an identity that cannot discover or list every
    namespaced kind must never authorise deleting the namespace, because an
    unlisted custom resource would be destroyed with it. The cluster record is
    retained so an Orchestration administrator can retry with a temporary Orchestration administrator kubeconfig
    (``POST /clusters/{id}/cleanup``) or a replaced credential.
    """

    def __init__(self, message: str, *, namespace: str | None = None) -> None:
        super().__init__(
            message,
            status_code=409,
            code="cleanup_permission_denied",
            title="Namespace cleanup permission denied",
            extra={"namespace": namespace} if namespace is not None else None,
        )
