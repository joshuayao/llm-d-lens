"""Tests for the cluster image pre-pull helper."""

import asyncio
import json

import pytest

from llm_d_lens import versions
from llm_d_lens.cluster import images as images_module
from llm_d_lens.cluster.images import (
    image_prepull_status,
    prepull_images,
    render_image_puller_daemonset,
    start_image_prepull,
)
from llm_d_lens.hardware.resolver import resolve_by_accelerator_key
from llm_d_lens.infrastructure.process import CommandResult


def test_prepull_images_covers_router_and_selected_model_servers():
    images = prepull_images(["nvidia", "intel"])

    assert versions.router_epp_image() in images
    assert versions.router_pd_sidecar_image() in images
    assert versions.inference_payload_processor_image() in images
    assert resolve_by_accelerator_key("nvidia").deployment.runtime_image in images
    assert resolve_by_accelerator_key("xpu").deployment.runtime_image in images


def test_prepull_images_includes_the_selected_gateway_provider():
    version = versions.gateway_provider_version("istio")
    images = prepull_images([], provider="istio")

    assert f"docker.io/istio/pilot:{version}" in images
    assert f"docker.io/istio/proxyv2:{version}" in images


def test_prepull_images_uses_the_pinned_versions_and_deduplicates():
    images = prepull_images(["nvidia", "nvidia", "cuda"])

    assert images.count(resolve_by_accelerator_key("nvidia").deployment.runtime_image) == 1


def test_render_puller_daemonset_pulls_every_image_privileged():
    manifest = render_image_puller_daemonset(
        ["ghcr.io/llm-d/llm-d-cuda:v0.9.0", "ghcr.io/llm-d/llm-d-xpu:v0.9.0"],
        namespace="lens-images",
        name="lens-image-puller",
        image="busybox:1.36",
    )

    # One container per image, each with its own readiness probe.
    assert manifest.count("crictl pull") == 2
    assert "name: pull-0" in manifest
    assert "name: pull-1" in manifest
    assert "lens-image-pull-done-0" in manifest
    assert "lens-image-pull-done-1" in manifest
    assert "privileged: true" in manifest
    assert "hostPID: true" in manifest


def test_prepull_images_uses_custom_vllm_image_instead_of_profile_defaults():
    custom = "registry.internal:5000/org/vllm:v0.8.5"
    images = prepull_images(["nvidia", "intel"], provider="istio", vllm_image=custom)

    assert versions.router_epp_image() in images
    assert versions.router_pd_sidecar_image() in images
    assert versions.inference_payload_processor_image() in images
    assert f"docker.io/istio/pilot:{versions.gateway_provider_version('istio')}" in images
    assert custom in images
    nvidia_default = resolve_by_accelerator_key("nvidia").deployment.runtime_image
    xpu_default = resolve_by_accelerator_key("xpu").deployment.runtime_image
    assert nvidia_default not in images
    assert xpu_default not in images

    # Blank vllm_image falls back to hardware profile defaults.
    fallback = prepull_images(["nvidia"], vllm_image="   ")
    assert nvidia_default in fallback

    with pytest.raises(ValueError):
        prepull_images(["nvidia"], vllm_image="untagged/repo")


def test_render_puller_daemonset_rejects_unsafe_image_refs_and_accepts_ports_and_digests():
    digest_ref = "registry.internal:5000/org/vllm:v0.8.5@" + "sha256:" + ("a" * 64)
    manifest = render_image_puller_daemonset(
        [digest_ref],
        namespace="lens-images",
        name="lens-image-puller",
        image="busybox:1.36",
    )
    assert digest_ref in manifest

    for bad_image in ("-privileged", "vllm:v1; id", "untagged/repo", "   "):
        with pytest.raises(ValueError):
            render_image_puller_daemonset(
                [bad_image],
                namespace="lens-images",
                name="lens-image-puller",
                image="busybox:1.36",
            )


def test_start_image_prepull_and_status_use_cluster_and_plan_vllm_image(monkeypatch):
    from types import SimpleNamespace

    from llm_d_lens.cluster import guard, registry
    from llm_d_lens.cluster.plan import normalize_plan

    applied: list[str] = []

    class FakeRunner:
        async def run(self, argv, *, input=None, timeout=None, **_kwargs):  # noqa: A002
            if argv[:2] == ["kubectl", "apply"] and input:
                applied.append(input)
                return CommandResult(tuple(argv), 0, "", "")
            if argv[:3] == ["kubectl", "get", "daemonset"]:
                return CommandResult(tuple(argv), 0, json.dumps({"status": {"desiredNumberScheduled": 1}}), "")
            if argv[:3] == ["kubectl", "get", "pods"]:
                return CommandResult(tuple(argv), 0, json.dumps({"items": []}), "")
            return CommandResult(tuple(argv), 1, "", "")

    cluster_id = "cid-prepull-custom"
    custom = "registry.internal:5000/org/vllm:v0.8.5"
    monkeypatch.setattr(images_module, "scoped_runner", lambda _cid: FakeRunner())
    monkeypatch.setattr(
        registry,
        "get_cluster",
        lambda cid: SimpleNamespace(id=cid, vllm_image=custom, gateway_provider="istio"),
    )
    images_module._LAST_IMAGES.pop(cluster_id, None)

    result = asyncio.run(start_image_prepull(cluster_id, ["nvidia"], provider="istio"))
    assert any(custom in payload for payload in applied)
    assert any(item["name"] == custom for item in result["images"])

    # Simulate process restart / admin script handoff where _LAST_IMAGES is empty.
    images_module._LAST_IMAGES.pop(cluster_id, None)
    plan = normalize_plan(
        {
            "gateway": {"provider": "istio", "namespace": "lens-gateway", "name": "lens-gateway"},
            "accelerators": [{"vendor": "nvidia", "mode": "plugin", "profile": "nvidia"}],
            "storage": {"kind": "none"},
            "hfTokenSecret": {"tokenSource": "existing-secret:hf", "secretNamespace": "lens-gateway"},
            "modelCache": {"enabled": False},
            "stack": {"imagePrepullEnabled": True, "vllmImage": custom},
            "runtime": {"inotifyEnabled": False},
            "spec": {"replicas": 1},
        },
        cluster_id=cluster_id,
    )
    monkeypatch.setattr(guard, "load_plan", lambda _cid: SimpleNamespace(plan=plan))
    status = asyncio.run(image_prepull_status(cluster_id))
    names = [item["name"] for item in status["images"]]
    assert custom in names
    assert resolve_by_accelerator_key("nvidia").deployment.runtime_image not in names
