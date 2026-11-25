"""FastAPI routes for accelerator observability management."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Query, Request

from llm_d_lens.auth.access import current_principal, require_cluster_access
from llm_d_lens.monitoring.service_links import (
    authorize_monitoring_cluster_request,
    redact_monitoring_error,
)

from .errors import AcceleratorError
from .models import (
    AcceleratorAdminScriptResponse,
    AcceleratorCapabilitiesResponse,
    AcceleratorInstallRequest,
    AcceleratorLinksResponse,
    AcceleratorOperationResponse,
    AcceleratorPreflightResponse,
    AcceleratorRecheckResponse,
    AcceleratorStatusResponse,
    GpuAccess,
)
from .registry import get_provider
from .service import (
    capabilities,
    get_admin_script,
    get_links,
    get_operation,
    get_status,
    install,
    preflight,
    recheck_accelerator,
    validate_namespace,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/monitoring/accelerators", tags=["accelerator-observability"])


def _http_error(error: AcceleratorError) -> HTTPException:
    return HTTPException(status_code=error.status_code, detail=error.detail())


@router.get(
    "",
    response_model=AcceleratorCapabilitiesResponse,
    summary=(
        "List accelerator observability capabilities Lens supports, including access modes and default namespaces."
    ),
    description=(
        "List accelerator observability capabilities Lens supports, including access modes and default namespaces."
    ),
    operation_id="list_monitoring_accelerators",
)
async def list_accelerators() -> AcceleratorCapabilitiesResponse:
    return capabilities()


@router.get(
    "/{accelerator}/status",
    response_model=AcceleratorStatusResponse,
    summary=(
        "Get observability status for one accelerator family, including release, component, and access-mode health."
    ),
    description=(
        "Get observability status for one accelerator family, including release, component, and access-mode health."
    ),
    operation_id="get_accelerator_monitoring_status",
)
async def status(
    accelerator: str,
    http_request: Request,
    namespace: Annotated[str, Query(max_length=63)] = "intel-xpumd",
    access_mode: Annotated[GpuAccess | None, Query()] = None,
    monitoring_namespace: Annotated[str | None, Query(max_length=63)] = None,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorStatusResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await get_status(
            accelerator,
            validate_namespace(namespace),
            access_mode,
            monitoring_namespace=monitoring_namespace,
            cluster_id=cluster_id,
        )
    except AcceleratorError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to query accelerator observability")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "ACCELERATOR_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error


@router.post(
    "/{accelerator}/installations/preflight",
    response_model=AcceleratorPreflightResponse,
    summary="Run accelerator observability installation preflight checks without mutating the cluster.",
    description=(
        "Run accelerator observability installation preflight checks without mutating the cluster. "
        "Use this before starting a real install."
    ),
    operation_id="preflight_accelerator_install",
)
async def installation_preflight(
    accelerator: str,
    request: AcceleratorInstallRequest,
    http_request: Request,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorPreflightResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:install",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        if request.accelerator != accelerator:
            raise AcceleratorError(
                "ACCELERATOR_MISMATCH",
                "Request accelerator does not match the path accelerator",
                status_code=422,
            )
        return await preflight(request, cluster_id=cluster_id)
    except AcceleratorError as error:
        raise _http_error(error) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.post(
    "/{accelerator}/installations",
    response_model=AcceleratorOperationResponse,
    status_code=202,
    summary="Install accelerator observability components for a supported accelerator family.",
    description="Install accelerator observability components for a supported accelerator family.",
    operation_id="install_accelerator_monitoring",
)
async def create_installation(
    accelerator: str,
    request: AcceleratorInstallRequest,
    http_request: Request,
    idempotency_key: str | None = Header(default=None, max_length=128),
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorOperationResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:install",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        if request.accelerator != accelerator:
            raise AcceleratorError(
                "ACCELERATOR_MISMATCH",
                "Request accelerator does not match the path accelerator",
                status_code=422,
            )
        return await install(request, idempotency_key=idempotency_key, cluster_id=cluster_id)
    except AcceleratorError as error:
        raise _http_error(error) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.get(
    "/{accelerator}/operations/{operation_id}",
    response_model=AcceleratorOperationResponse,
    summary="Get the status and logs of one accelerator monitoring installation operation.",
    description="Get the status and logs of one accelerator monitoring installation operation.",
    operation_id="get_accelerator_monitoring_operation",
)
async def operation(accelerator: str, operation_id: str) -> AcceleratorOperationResponse:
    del accelerator  # operations are keyed by operation_id; accelerator is validated for routing consistency
    try:
        return get_operation(operation_id)
    except AcceleratorError as error:
        raise _http_error(error) from error


@router.get(
    "/{accelerator}/links",
    response_model=AcceleratorLinksResponse,
    summary=(
        "Get observability links Lens can resolve for an accelerator monitoring installation, such as Grafana or "
        "Prometheus URLs."
    ),
    description=(
        "Get observability links Lens can resolve for an accelerator monitoring installation, such as Grafana or "
        "Prometheus URLs."
    ),
    operation_id="get_accelerator_monitoring_links",
)
async def links(
    accelerator: str,
    http_request: Request,
    monitoring_namespace: Annotated[str | None, Query(max_length=63)] = None,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorLinksResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return await get_links(accelerator, monitoring_namespace=monitoring_namespace, cluster_id=cluster_id)
    except AcceleratorError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to resolve accelerator observability links")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "ACCELERATOR_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error


@router.get(
    "/{accelerator}/admin-script",
    response_model=AcceleratorAdminScriptResponse,
)
async def admin_script(
    accelerator: str,
    http_request: Request,
    namespace: Annotated[str | None, Query(max_length=63)] = None,
    access_mode: Annotated[GpuAccess | None, Query()] = None,
    monitoring_namespace: Annotated[str | None, Query(max_length=63)] = None,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorAdminScriptResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        return get_admin_script(
            accelerator,
            namespace=namespace,
            access_mode=access_mode,
            monitoring_namespace=monitoring_namespace,
            cluster_id=cluster_id,
        )
    except AcceleratorError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error


@router.post(
    "/{accelerator}/recheck",
    response_model=AcceleratorRecheckResponse,
)
async def recheck(
    accelerator: str,
    http_request: Request,
    namespace: Annotated[str | None, Query(max_length=63)] = None,
    access_mode: Annotated[GpuAccess | None, Query()] = None,
    monitoring_namespace: Annotated[str | None, Query(max_length=63)] = None,
    cluster_id: str | None = Query(default=None, max_length=64),
) -> AcceleratorRecheckResponse:
    cluster_id = authorize_monitoring_cluster_request(
        current_principal(http_request),
        cluster_id,
        "monitoring:accelerator:read",
        require_cluster_access_fn=require_cluster_access,
    )
    try:
        target_ns = namespace or get_provider(accelerator).capability().default_namespace
        return await recheck_accelerator(
            accelerator,
            validate_namespace(target_ns),
            access_mode,
            monitoring_namespace=monitoring_namespace,
            cluster_id=cluster_id,
        )
    except AcceleratorError as error:
        raise _http_error(error) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail={"code": "CLUSTER_NOT_FOUND", "message": str(error)}) from error
    except Exception as error:
        logger.exception("Unable to recheck accelerator observability")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "ACCELERATOR_QUERY_FAILED",
                "message": redact_monitoring_error(str(error)),
                "retryable": True,
            },
        ) from error
