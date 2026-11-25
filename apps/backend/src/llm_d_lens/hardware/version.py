"""Kubernetes version gating for hardware driver access modes.

A profile may declare a per-mode ``min_kubernetes_version`` under ``driver.modes``
(e.g. Intel DRA and NVIDIA DRA both need modern Kubernetes). Resolving the
cluster's server version and comparing it lets the gpu-driver API fail fast with
an actionable message instead of surfacing a raw Helm/kubectl error.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from llm_d_lens.infrastructure import kubernetes as k8s

if TYPE_CHECKING:
    from .models import HardwareProfile


@dataclass(frozen=True)
class KubernetesVersionResult:
    """Classified outcome of probing a cluster's Kubernetes server version.

    ``reason`` is one of ``ok``, ``unauthorized``, ``forbidden``,
    ``unreachable``, ``timeout`` or ``egress_blocked``. ``version`` is only set
    for ``ok``; every other reason carries an actionable ``message``. An
    ``egress_blocked`` result also keeps the policy ``egress_reason`` so the
    route can preserve its existing key.
    """

    version: tuple[int, int, int] | None
    reason: str
    message: str | None = None
    egress_reason: str | None = None


def parse_version(value: str) -> tuple[int, int, int]:
    parts = [int(re.sub(r"\D", "", part) or 0) for part in str(value).split(".")[:3]]
    while len(parts) < 3:
        parts.append(0)
    return parts[0], parts[1], parts[2]


async def server_kubernetes_version(cluster_id: str | None) -> KubernetesVersionResult:
    """Probe the cluster server version and classify any failure reason.

    A stored cluster's kubeconfig is checked against the outbound policy before
    ``kubectl`` runs; a blocked target is reported as ``egress_blocked`` instead
    of raising so callers can surface the same reason field. ``kubectl``
    failures are separated into ``unauthorized`` (401), ``forbidden`` (403),
    ``timeout`` and ``unreachable``; a malformed response is ``unreachable``.
    """
    if cluster_id:
        from llm_d_lens.cluster.egress import EgressBlockedError, validate_stored_cluster_egress

        try:
            validate_stored_cluster_egress(cluster_id)
        except EgressBlockedError as error:
            return KubernetesVersionResult(
                None,
                "egress_blocked",
                str(error),
                egress_reason=error.reason,
            )
    try:
        result = await k8s.scoped_runner(cluster_id).run(["kubectl", "version", "-o", "json"], timeout=15)
    except TimeoutError:
        return KubernetesVersionResult(None, "timeout", "Timed out reaching the Kubernetes API")
    except FileNotFoundError as error:
        return KubernetesVersionResult(None, "unreachable", str(error) or "kubectl is not available")
    except OSError as error:
        return KubernetesVersionResult(None, "unreachable", str(error) or "Unable to run kubectl")
    if result.returncode != 0:
        text = f"{result.stdout or ''}\n{result.stderr or ''}".lower()
        if "unauthorized" in text or "401" in text:
            return KubernetesVersionResult(
                None,
                "unauthorized",
                "The kubeconfig credentials are invalid or expired",
            )
        if "forbidden" in text or "403" in text:
            return KubernetesVersionResult(
                None,
                "forbidden",
                "The kubeconfig identity is authenticated but is not allowed to read the Kubernetes version",
            )
        return KubernetesVersionResult(
            None,
            "unreachable",
            "Unable to reach the Kubernetes API with this kubeconfig",
        )
    try:
        server = json.loads(result.stdout).get("serverVersion") or {}
        version = parse_version(f"{server.get('major', '0')}.{server.get('minor', '0')}")
    except (json.JSONDecodeError, ValueError, TypeError):
        return KubernetesVersionResult(None, "unreachable", "Unable to parse the Kubernetes version response")
    return KubernetesVersionResult(version, "ok")


def access_mode_version_message(
    profile: HardwareProfile | None,
    access_mode: str,
    server: tuple[int, int, int] | None,
) -> str | None:
    """Actionable message when the access mode needs a newer Kubernetes, else None."""
    if profile is None or profile.driver is None or server is None:
        return None
    mode = profile.driver.mode(access_mode)
    minimum = mode.min_kubernetes_version if mode is not None else None
    if not minimum or server >= parse_version(minimum):
        return None
    version = f"v{server[0]}.{server[1]}.{server[2]}"
    alternative = "plugin" if access_mode == "dra" else "dra"
    return (
        f"The {access_mode} {profile.display_name} driver requires Kubernetes >= {minimum} "
        f"(cluster is {version}); use the {alternative} access mode instead."
    )
