"""Accelerator provider registry.

Each supported accelerator is a small provider that mirrors the ``cluster_stack``
service contract. Adding a new hardware type means registering a new provider, not
copying routes.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from llm_d_lens.monitoring.cluster_stack.models import ClusterStackStatusResponse

from .errors import AcceleratorError
from .models import (
    AcceleratorCapabilitiesResponse,
    AcceleratorCapability,
    AcceleratorInstallRequest,
    AcceleratorPreflightResponse,
    AcceleratorStatusResponse,
    GpuAccess,
)

if TYPE_CHECKING:
    from llm_d_lens.hardware.models import HardwareProfile


@dataclass(frozen=True)
class AcceleratorCleanupSpec:
    """Cleanup target metadata derived from a registered accelerator provider."""

    provider_id: str
    display_name: str
    release_name: str
    namespace: str


class AcceleratorProvider(Protocol):
    def capability(self) -> AcceleratorCapability: ...

    async def discover_status(
        self,
        namespace: str,
        cluster_id: str | None,
        *,
        access_mode: GpuAccess | None = None,
        monitoring_namespace: str | None = None,
        active_operation_id: str | None = None,
    ) -> AcceleratorStatusResponse: ...

    async def preflight(
        self,
        request: AcceleratorInstallRequest,
        cluster_id: str | None,
        *,
        monitoring_status: ClusterStackStatusResponse | None = None,
    ) -> AcceleratorPreflightResponse: ...

    async def prepare_nodes(
        self,
        cluster_id: str | None,
        *,
        access_mode: GpuAccess | None,
    ) -> None: ...

    def install_argv(
        self,
        request: AcceleratorInstallRequest,
        *,
        monitoring_namespace: str,
        monitoring_release: str,
    ) -> list[str]: ...

    def render_install_script(
        self,
        *,
        namespace: str | None = None,
        access_mode: GpuAccess | None = None,
        monitoring_namespace: str | None = "llm-d-monitoring",
        monitoring_release: str = "llmd",
        existing_monitoring: bool = False,
    ) -> str: ...

    def cleanup_spec(self, *, namespace: str | None = None) -> AcceleratorCleanupSpec: ...


_ACCELERATOR_REGISTRY: dict[str, AcceleratorProvider] = {}


def register(provider: AcceleratorProvider) -> None:
    _ACCELERATOR_REGISTRY[provider.capability().type] = provider


def provider_id_for_profile(profile: HardwareProfile | None) -> str | None:
    """Return the registered telemetry provider id declared by a hardware profile."""
    if profile is None or profile.telemetry is None:
        return None
    provider_id = profile.telemetry.provider_id
    return str(provider_id).strip() or None if provider_id else None


def get_registered_provider(provider_id: str) -> AcceleratorProvider | None:
    """Return a registered provider by id, loading built-in providers if needed."""
    if not provider_id:
        return None
    provider = _ACCELERATOR_REGISTRY.get(provider_id)
    if provider is None:
        importlib.import_module("llm_d_lens.monitoring.accelerator")
        provider = _ACCELERATOR_REGISTRY.get(provider_id)
    return provider


def get_provider(accelerator: str) -> AcceleratorProvider:
    provider = get_registered_provider(accelerator)
    if provider is None:
        raise AcceleratorError(
            "ACCELERATOR_NOT_SUPPORTED",
            f"Accelerator {accelerator!r} is not supported",
            status_code=404,
        )
    return provider


def capabilities() -> AcceleratorCapabilitiesResponse:
    return AcceleratorCapabilitiesResponse(
        accelerators=[provider.capability() for provider in _ACCELERATOR_REGISTRY.values()]
    )
