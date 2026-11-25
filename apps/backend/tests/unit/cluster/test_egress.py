"""Outbound-policy classification for kubeconfig API servers."""

from __future__ import annotations

import socket
from urllib.parse import urlparse

import pytest

from llm_d_lens.cluster import egress
from llm_d_lens.cluster.egress import (
    ALLOWLIST_ENV,
    EgressBlockedError,
    validate_kubeconfig_egress,
    validate_stored_cluster_egress,
)


def _kubeconfig(server: str) -> str:
    return f"""apiVersion: v1
kind: Config
clusters:
- name: target
  cluster:
    server: {server}
contexts: []
current-context: ""
users: []
"""


def _resolver(*addresses: str):
    return lambda _host, _port: list(addresses)


def _blocked(server: str, *, resolver=None, allowlist=None) -> EgressBlockedError:
    if resolver is None:
        resolver = _resolver(urlparse(server).hostname or "")
    with pytest.raises(EgressBlockedError) as excinfo:
        validate_kubeconfig_egress(
            _kubeconfig(server),
            allowlist=allowlist,
            resolver=resolver,
        )
    return excinfo.value


def test_https_private_target_is_allowed_by_default():
    target = validate_kubeconfig_egress(
        _kubeconfig("https://10.0.0.1:6443"),
        resolver=_resolver("10.0.0.1", "fd12::1"),
    )

    assert target.host == "10.0.0.1"
    assert target.port == 6443
    assert target.addresses == ("10.0.0.1", "fd12::1")
    assert target.pinned_address == "10.0.0.1"
    assert target.matched_by_allowlist is False


def test_https_defaults_to_port_443_and_pins_the_first_address():
    target = validate_kubeconfig_egress(
        _kubeconfig("https://cluster.example.test"),
        resolver=_resolver("10.2.3.4", "10.2.3.5"),
    )

    assert target.port == 443
    assert target.pinned_address == "10.2.3.4"


def test_http_is_rejected():
    assert _blocked("http://10.0.0.1:8080").reason == "http_not_allowed"


def test_loopback_is_rejected():
    assert _blocked("https://127.0.0.1:6443").reason == "loopback"
    assert _blocked("https://[::1]:6443", resolver=_resolver("::1")).reason == "loopback"


def test_ipv4_mapped_ipv6_follows_the_ipv4_classification():
    assert _blocked("https://[::ffff:127.0.0.1]:6443", resolver=_resolver("::ffff:127.0.0.1")).reason == "loopback"
    assert (
        _blocked(
            "https://[::ffff:169.254.169.254]:6443",
            resolver=_resolver("::ffff:169.254.169.254"),
        ).reason
        == "metadata"
    )


def test_link_local_is_rejected():
    assert _blocked("https://169.254.1.1:6443").reason == "link_local"
    assert _blocked("https://[fe80::1]:6443", resolver=_resolver("fe80::1")).reason == "link_local"


@pytest.mark.parametrize(
    "address",
    ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"],
)
def test_metadata_is_always_rejected(address):
    assert _blocked(f"https://[{address}]:6443" if ":" in address else f"https://{address}:6443").reason == "metadata"


def test_a_hostname_resolving_to_metadata_is_rejected():
    error = _blocked("https://metadata.example.test:6443", resolver=_resolver("169.254.169.254"))

    assert error.reason == "metadata"
    assert error.host == "metadata.example.test"
    assert error.address == "169.254.169.254"


def test_metadata_cannot_be_allowlisted():
    error = _blocked(
        "https://169.254.169.254:6443",
        resolver=_resolver("169.254.169.254"),
        allowlist="169.254.169.254",
    )

    assert error.reason == "metadata"


@pytest.mark.parametrize("server", ["https://0.0.0.0:6443", "https://[::]:6443"])  # noqa: S104 - comparison
def test_unspecified_addresses_are_rejected(server):
    address = "0.0.0.0" if "0.0.0.0" in server else "::"  # noqa: S104 - comparison, not a bind
    assert _blocked(server, resolver=_resolver(address)).reason == "unspecified"


def test_unspecified_address_cannot_be_allowlisted():
    assert (
        _blocked(
            "https://0.0.0.0:6443",  # noqa: S104 - comparison, not a bind
            resolver=_resolver("0.0.0.0"),  # noqa: S104 - comparison, not a bind
            allowlist="0.0.0.0",  # noqa: S104 - comparison, not a bind
        ).reason
        == "unspecified"
    )


def test_allowlist_permits_loopback_for_development():
    target = validate_kubeconfig_egress(
        _kubeconfig("https://127.0.0.1:6443"),
        allowlist="127.0.0.1",
        resolver=_resolver("127.0.0.1"),
    )

    assert target.pinned_address == "127.0.0.1"
    assert target.matched_by_allowlist is True


def test_allowlist_permits_link_local():
    target = validate_kubeconfig_egress(
        _kubeconfig("https://169.254.10.10:6443"),
        allowlist="169.254.10.0/24",
        resolver=_resolver("169.254.10.10"),
    )

    assert target.matched_by_allowlist is True


def test_allowlist_is_read_from_the_deployment_setting(monkeypatch):
    monkeypatch.setenv(ALLOWLIST_ENV, "127.0.0.1, ::1")
    target = validate_kubeconfig_egress(
        _kubeconfig("https://localhost:6443"),
        resolver=_resolver("127.0.0.1", "::1"),
    )

    assert target.addresses == ("127.0.0.1", "::1")
    assert target.matched_by_allowlist is True


def test_dns_failure_is_reported():

    def failing(_host: str, _port: int):
        raise socket.gaierror("name resolution failed")

    error = _blocked("https://missing.example.test:6443", resolver=failing)

    assert error.reason == "dns_failed"
    assert error.host == "missing.example.test"


def test_a_kubeconfig_without_a_server_is_rejected():
    with pytest.raises(EgressBlockedError) as excinfo:
        validate_kubeconfig_egress("apiVersion: v1\nkind: Config\nclusters: []\n")

    assert excinfo.value.reason == "no_server"


def test_a_malformed_kubeconfig_is_rejected():
    with pytest.raises(EgressBlockedError) as excinfo:
        validate_kubeconfig_egress("clusters: [not-a-cluster\n")

    assert excinfo.value.reason == "no_server"


def test_stored_cluster_egress_uses_the_database_kubeconfig(monkeypatch):
    import yaml

    from llm_d_lens.cluster import registry

    monkeypatch.setattr(
        registry,
        "read_kubeconfig",
        lambda _cluster_id: _kubeconfig("https://10.0.0.7:6443"),
    )
    target = validate_stored_cluster_egress("cluster-a", resolver=_resolver("10.0.0.7"))

    assert target.host == "10.0.0.7"
    assert yaml.safe_load(_kubeconfig("https://10.0.0.7:6443"))["clusters"][0]["cluster"]["server"] == target.server


def test_stored_cluster_egress_rejects_a_missing_kubeconfig(monkeypatch):
    from llm_d_lens.cluster import registry

    monkeypatch.setattr(registry, "read_kubeconfig", lambda _cluster_id: None)

    with pytest.raises(EgressBlockedError) as excinfo:
        validate_stored_cluster_egress("cluster-a")

    assert excinfo.value.reason == "no_server"


def test_custom_resolver_can_return_getaddrinfo_rows():
    def resolver(_host: str, _port: int):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.3.3.3", 6443))]

    target = validate_kubeconfig_egress(_kubeconfig("https://10.3.3.3:6443"), resolver=resolver)

    assert target.pinned_address == "10.3.3.3"


def test_extra_never_contains_the_kubeconfig():
    error = _blocked("https://127.0.0.1:6443")
    assert set(error.extra()) == {"reason", "host", "address"}
    assert "apiVersion" not in str(error.extra())


def test_egress_module_exports_the_public_helpers():
    assert egress.validate_kubeconfig_egress is validate_kubeconfig_egress
    assert egress.validate_stored_cluster_egress is validate_stored_cluster_egress
