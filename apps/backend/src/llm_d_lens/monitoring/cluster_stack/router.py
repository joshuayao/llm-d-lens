"""FastAPI routes for cluster monitoring stack management."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request

from llm_d_lens.auth.access import current_principal, require_cluster_access
from llm_d_lens.monitoring.service_links import (
    authorize_monitoring_cluster_request,
    redact_monitoring_error,
)

from .errors import ClusterStackError
from .models import (
    ClusterStackAdminScriptResponse,
    ClusterStackInstallRequest,
    ClusterStackLinksResponse,
    ClusterStackOperationResponse,
    ClusterStackPreflightResponse,
    ClusterStackRecheckResponse,
    ClusterStackStatusResponse,
)
from .service import (
    get_admin_script,
    get_links,
    get_operation,
    get_status,
    install,
    preflight,
    recheck_cluster_stack,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/monitoring/cluster-stack", tags=["cluster-monitoring-stack"])


def _http_error(error: ClusterStackError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail())


@router.get(
    "/status",
    response_model=ClusterStackStatusResponse,
    summary=(
        "Check whether the cluster-level Prometheus/Grafana monitoring stack (kube-prometheus-stack) is installed "
        "and ready."
    ),
    description=(
        "Check whether the cluster-level Prometheus/Grafana monitoring stack (kube-prometheus-stack) is installed "
        "and ready."
    ),
    operation_id="get_cluster_stack_status",
)
async def status(
    http_request: Request,
    namespace: str | None = Query(default=None, max_length=63),
    cluster_id: str | None = Query(default=None, max_length=64),
) -> ClusterStackStatusResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await get_status(namespace, cluster_id=cluster_id)
    except ClusterStackError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to query cluster monitoring stack")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "CLUSTER_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error


@router.post(
    "/installations/preflight",
    response_model=ClusterStackPreflightResponse,
    summary="Run cluster monitoring stack preflight checks without installing anything.",
    description=(
        "Run cluster monitoring stack preflight checks without installing anything. "
        "Use this before starting a Prometheus/Grafana stack installation."
    ),
    operation_id="preflight_cluster_stack_install",
)
async def installation_preflight(
    http_request: Request,
    request: ClusterStackInstallRequest,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> ClusterStackPreflightResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:install",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await preflight(request, cluster_id=cluster_id)
    except ClusterStackError as error:
        raise _http_error(error) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.post(
    "/installations",
    response_model=ClusterStackOperationResponse,
    status_code=202,
    summary="Install or reinstall the cluster-level monitoring stack.",
    description=(
        "Install or reinstall the cluster-level monitoring stack. "
        "Use this when Prometheus/Grafana cluster monitoring should be provisioned or repaired."
    ),
    operation_id="install_cluster_stack",
)
async def create_installation(
    http_request: Request,
    request: ClusterStackInstallRequest,
    idempotency_key: str | None = Header(default=None, max_length=128),
    cluster_id: str | None = Query(default=None, max_length=64),
) -> ClusterStackOperationResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:install",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await install(request, idempotency_key=idempotency_key, cluster_id=cluster_id)
    except ClusterStackError as error:
        raise _http_error(error) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.get(
    "/operations/{operation_id}",
    response_model=ClusterStackOperationResponse,
    summary="Get the status and logs of one cluster monitoring stack installation operation.",
    description="Get the status and logs of one cluster monitoring stack installation operation.",
    operation_id="get_cluster_stack_operation",
)
async def operation(operation_id: str) -> ClusterStackOperationResponse:
    try:
        return get_operation(operation_id)
    except ClusterStackError as error:
        raise _http_error(error) from error


@router.get(
    "/links",
    response_model=ClusterStackLinksResponse,
    summary="Get resolved Grafana and Prometheus links for the cluster monitoring stack.",
    description="Get resolved Grafana and Prometheus links for the cluster monitoring stack.",
    operation_id="get_cluster_stack_links",
)
async def links(
    http_request: Request,
    namespace: str | None = Query(default=None, max_length=63),
    cluster_id: str | None = Query(default=None, max_length=64),
) -> ClusterStackLinksResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await get_links(namespace, cluster_id=cluster_id)
    except ClusterStackError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to resolve cluster monitoring stack links")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "CLUSTER_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error


@router.get(
    "/admin-script",
    response_model=ClusterStackAdminScriptResponse,
)
async def admin_script(
    http_request: Request,
    cluster_id: str | None = Query(default=None, max_length=64),
    namespace: str | None = Query(default=None, max_length=63),
    mode: Literal["managed", "existing"] | None = Query(default=None),
    include_accelerators: bool = Query(default=True),
) -> ClusterStackAdminScriptResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await get_admin_script(
            namespace=namespace,
            cluster_id=cluster_id,
            mode=mode,
            include_accelerators=include_accelerators,
        )
    except ClusterStackError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.post(
    "/recheck",
    response_model=ClusterStackRecheckResponse,
)
async def recheck(
    http_request: Request,
    namespace: str | None = Query(default=None, max_length=63),
    cluster_id: str | None = Query(default=None, max_length=64),
) -> ClusterStackRecheckResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:cluster-stack:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await recheck_cluster_stack(namespace, cluster_id=cluster_id)
    except ClusterStackError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to recheck cluster monitoring stack")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "CLUSTER_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error
