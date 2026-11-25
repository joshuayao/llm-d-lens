"""Outbound policy for kubeconfig API servers.

The kubeconfig replacement endpoint sends a user-supplied credential to a
user-supplied server. This module resolves the server host and rejects targets
that must never be dialed (loopback, link-local, cloud metadata, unspecified
addresses) while still allowing the private ranges most Lens targets use.
See ``docs/design/cluster-permission-preflight-design.md`` sections 4.6, 9 and
16.

The shared helper is used by import, version, SSAR and execution; callers must
run it before dialing. The backend may pin :attr:`EgressTarget.pinned_address`
for its own HTTP client; the CLI path re-validates before each use.
"""

from __future__ import annotations

import ipaddress
import os
import socket
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlparse

import yaml

__all__ = [
    "ALLOWLIST_ENV",
    "EgressBlockedError",
    "EgressTarget",
    "validate_kubeconfig_egress",
    "validate_stored_cluster_egress",
]

#: Deployment setting: comma-separated hosts/CIDRs allowed in addition to the
#: default policy. It can permit loopback/link-local for local development but
#: never a cloud metadata address.
ALLOWLIST_ENV = "LENS_KUBECONFIG_EGRESS_ALLOWLIST"

EgressReason = Literal[
    "http_not_allowed",
    "loopback",
    "link_local",
    "metadata",
    "unspecified",
    "dns_failed",
    "no_server",
    "unreachable",
]

#: Cloud metadata endpoints that are denied even when an allowlist matches.
_METADATA_ADDRESSES = frozenset(
    {
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("169.254.170.2"),
        ipaddress.ip_address("fd00:ec2::254"),
        ipaddress.ip_address("100.100.100.200"),
    }
)

_RESOLVER = Callable[[str, int], Iterable[Any]]
_AllowEntry = ipaddress.IPv4Network | ipaddress.IPv6Network | str

_REASON_MESSAGES: dict[str, str] = {
    "http_not_allowed": "Kubeconfig server must use https",
    "loopback": "Kubeconfig server resolves to a loopback address",
    "link_local": "Kubeconfig server resolves to a link-local address",
    "metadata": "Kubeconfig server resolves to a cloud metadata address",
    "unspecified": "Kubeconfig server resolves to an unspecified address",
    "dns_failed": "Kubeconfig server host could not be resolved",
    "no_server": "Kubeconfig does not define a cluster server",
    "unreachable": "Kubeconfig server did not resolve to an address",
}


class EgressBlockedError(Exception):
    """A kubeconfig target violates the outbound policy."""

    def __init__(
        self,
        reason: EgressReason,
        *,
        host: str | None = None,
        address: str | None = None,
        message: str | None = None,
    ) -> None:
        self.reason: EgressReason = reason
        self.host = host
        self.address = address
        super().__init__(message or _REASON_MESSAGES.get(reason, "Kubeconfig server is not allowed"))

    def extra(self) -> dict[str, str | None]:
        """Problem-response fields; never contains kubeconfig content."""
        return {"reason": self.reason, "host": self.host, "address": self.address}


@dataclass(frozen=True)
class EgressTarget:
    """A validated kubeconfig target."""

    server: str
    host: str
    port: int
    addresses: tuple[str, ...]
    pinned_address: str
    matched_by_allowlist: bool


def _allowlist_entries(allowlist: str | Iterable[str] | None) -> tuple[_AllowEntry, ...]:
    if allowlist is None:
        raw: str | Iterable[str] = os.environ.get(ALLOWLIST_ENV, "")
    else:
        raw = allowlist
    parts = raw.split(",") if isinstance(raw, str) else [piece for item in raw for piece in str(item).split(",")]
    entries: list[_AllowEntry] = []
    for part in parts:
        token = part.strip()
        if not token:
            continue
        try:
            entries.append(ipaddress.ip_network(token, strict=False))
        except ValueError:
            entries.append(token.lower())
    return tuple(entries)


def _normalized_ip(
    value: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(value, ipaddress.IPv6Address) and value.ipv4_mapped is not None:
        return value.ipv4_mapped
    return value


def _host_matches_allowlist(host: str, entries: tuple[_AllowEntry, ...]) -> bool:
    lowered = host.lower()
    try:
        address = _normalized_ip(ipaddress.ip_address(host))
    except ValueError:
        address = None
    for entry in entries:
        if isinstance(entry, str):
            if entry == lowered:
                return True
        elif address is not None and address in entry:
            return True
    return False


def _address_matches_allowlist(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    entries: tuple[_AllowEntry, ...],
) -> bool:
    return any(not isinstance(entry, str) and address in entry for entry in entries)


def _resolve(host: str, port: int, resolver: _RESOLVER | None) -> tuple[str, ...]:
    try:
        raw = resolver(host, port) if resolver is not None else socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, OSError) as error:
        raise EgressBlockedError("dns_failed", host=host) from error

    addresses: list[str] = []
    for item in raw:
        candidate: Any = item
        if isinstance(item, tuple):
            if len(item) >= 5 and isinstance(item[4], tuple) and item[4]:
                candidate = item[4][0]
            elif item:
                candidate = item[0]
        if not isinstance(candidate, str):
            continue
        # A scoped IPv6 address ("fe80::1%eth0") is still the same address for
        # policy purposes.
        candidate = candidate.split("%", 1)[0]
        try:
            address = _normalized_ip(ipaddress.ip_address(candidate))
        except ValueError:
            continue
        text = str(address)
        if text not in addresses:
            addresses.append(text)
    if not addresses:
        raise EgressBlockedError("unreachable", host=host)
    return tuple(addresses)


def validate_kubeconfig_egress(
    kubeconfig_text: str,
    *,
    allowlist: str | Iterable[str] | None = None,
    resolver: _RESOLVER | None = None,
) -> EgressTarget:
    """Resolve and validate the first cluster's ``server`` before it is dialed.

    ``allowlist`` overrides ``LENS_KUBECONFIG_EGRESS_ALLOWLIST`` when supplied;
    both accept a comma-separated string or an iterable of host/CIDR entries.
    An allowlist can permit loopback/link-local targets but never a cloud
    metadata address.
    """

    try:
        parsed = yaml.safe_load(kubeconfig_text)
    except yaml.YAMLError as error:
        raise EgressBlockedError("no_server", message="Kubeconfig is not valid YAML") from error
    clusters = parsed.get("clusters") if isinstance(parsed, dict) else None
    first = clusters[0] if isinstance(clusters, list) and clusters else None
    cluster = first.get("cluster") if isinstance(first, dict) else None
    server = cluster.get("server") if isinstance(cluster, dict) else None
    if not isinstance(server, str) or not server.strip():
        raise EgressBlockedError("no_server")

    parsed_url = urlparse(server.strip())
    host = parsed_url.hostname
    if parsed_url.scheme.lower() != "https":
        raise EgressBlockedError("http_not_allowed", host=host)
    if not host:
        raise EgressBlockedError("no_server")
    try:
        port = parsed_url.port or 443
    except ValueError as error:
        raise EgressBlockedError("no_server", host=host) from error

    entries = _allowlist_entries(allowlist)
    matched_by_allowlist = _host_matches_allowlist(host, entries)
    addresses = _resolve(host, port, resolver)

    pinned_address: str | None = None
    for text in addresses:
        address = _normalized_ip(ipaddress.ip_address(text))
        if address in _METADATA_ADDRESSES:
            raise EgressBlockedError("metadata", host=host, address=text)
        if address.is_unspecified:
            raise EgressBlockedError("unspecified", host=host, address=text)
        allowlisted = matched_by_allowlist or _address_matches_allowlist(address, entries)
        if not allowlisted and address.is_loopback:
            raise EgressBlockedError("loopback", host=host, address=text)
        if not allowlisted and address.is_link_local:
            raise EgressBlockedError("link_local", host=host, address=text)
        if allowlisted:
            matched_by_allowlist = True
        if pinned_address is None:
            pinned_address = text

    if pinned_address is None:  # pragma: no cover - _resolve guarantees non-empty
        raise EgressBlockedError("unreachable", host=host)
    return EgressTarget(
        server=server.strip(),
        host=host,
        port=port,
        addresses=addresses,
        pinned_address=pinned_address,
        matched_by_allowlist=matched_by_allowlist,
    )


def validate_stored_cluster_egress(
    cluster_id: str,
    *,
    allowlist: str | Iterable[str] | None = None,
    resolver: _RESOLVER | None = None,
) -> EgressTarget:
    """Validate the kubeconfig currently stored for ``cluster_id``."""

    from . import registry

    text = registry.read_kubeconfig(cluster_id)
    if text is None:
        raise EgressBlockedError("no_server", message="Cluster has no stored kubeconfig")
    return validate_kubeconfig_egress(text, allowlist=allowlist, resolver=resolver)
