import json
from copy import deepcopy

import pytest

from llm_d_lens.configuration.guide_composition import compose_native_cpu_cache


def manifest(connector=None, image="runtime:1"):
    args = ["model"]
    if connector:
        args += ["--kv-transfer-config", json.dumps(connector)]
    return [
        {
            "kind": "Deployment",
            "metadata": {"name": "model"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "modelserver",
                                "image": image,
                                "args": args,
                                "resources": {"requests": {"memory": "1Gi"}, "limits": {"memory": "2Gi"}},
                            }
                        ]
                    }
                }
            },
        }
    ]


def donor():
    return manifest(
        {
            "kv_connector": "OffloadingConnector",
            "kv_role": "kv_both",
            "kv_connector_extra_config": {"cpu_bytes_to_use": 1024**3},
        }
    )


def test_composition_preserves_source_and_adds_host_budget():
    base = manifest()
    original = deepcopy(base)
    result = compose_native_cpu_cache(base, donor(), guide="optimized-baseline", capacity_gib=4)
    assert base == original
    server = result[0]["spec"]["template"]["spec"]["containers"][0]
    assert json.loads(server["args"][-1])["kv_connector_extra_config"]["cpu_bytes_to_use"] == 4 * 1024**3
    assert server["resources"]["requests"]["memory"] == str(5 * 1024**3)
    assert server["resources"]["limits"]["memory"] == str(6 * 1024**3)


@pytest.mark.parametrize(
    "guide,base,message",
    [
        ("pd-disaggregation", manifest(), "transport"),
        ("optimized-baseline", manifest({"kv_connector": "NixlConnector"}), "already owns"),
        ("precise-prefix-cache-routing", manifest(image="runtime:2"), "identical"),
    ],
)
def test_composition_rejects_unproven_or_conflicting_combinations(guide, base, message):
    with pytest.raises(ValueError, match=message):
        compose_native_cpu_cache(base, donor(), guide=guide, capacity_gib=4)


@pytest.mark.parametrize("capacity", [0, -1, True, float("nan"), float("inf"), 1025])
def test_invalid_budget_is_rejected(capacity):
    with pytest.raises(ValueError, match="capacity"):
        compose_native_cpu_cache(manifest(), donor(), guide="optimized-baseline", capacity_gib=capacity)


def test_composition_respects_an_explicit_prefix_cache_exclusion():
    base = manifest()
    base[0]["spec"]["template"]["spec"]["containers"][0]["args"].append("--no-enable-prefix-caching")
    with pytest.raises(ValueError, match="explicitly disabled"):
        compose_native_cpu_cache(base, donor(), guide="optimized-baseline", capacity_gib=4)


def pd_manifest():
    result = []
    for role in ("prefill", "decode"):
        docs = manifest(
            {
                "kv_connector": "NixlConnector",
                "kv_role": "kv_both",
                "engine_id": role,
                "kv_buffer_device": "cuda",
                "kv_connector_extra_config": {"num_threads": 2},
            }
        )
        docs[0]["metadata"]["name"] = role
        result.extend(docs)
    return result


def test_pd_preserves_transport_identity_environment_and_reserves_each_role():
    import yaml

    from llm_d_lens.configuration.guide_composition import runtime_probe
    from llm_d_lens.configuration.guide_settings import validate_configuration_extensions

    base = pd_manifest()
    original = deepcopy(base)
    result = compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=4)
    assert base == original
    for doc in result:
        pod = doc["spec"]["template"]["spec"]
        server = pod["containers"][0]
        config = json.loads(server["args"][-1])
        assert config["kv_connector"] == "MultiConnector"
        assert config["engine_id"] == doc["metadata"]["name"]
        transport, cache = config["kv_connector_extra_config"]["connectors"]
        assert transport == {
            "kv_connector": "NixlConnector",
            "kv_role": "kv_both",
            "kv_buffer_device": "cuda",
            "kv_connector_extra_config": {"num_threads": 2},
        }
        assert cache["kv_connector_extra_config"]["cpu_bytes_to_use"] == 4 * 1024**3
        assert server["resources"]["requests"]["memory"] == str(5 * 1024**3)
        assert pod["initContainers"] == [runtime_probe(server, config)]
    content = {
        "officialGuide": {"source": {"guide": "pd-disaggregation"}},
        "guideComposition": {"nativeCpuCacheGiB": 4},
    }
    validate_configuration_extensions(content, yaml.safe_dump_all(result))
    result[0]["spec"]["template"]["spec"]["initContainers"] = []
    with pytest.raises(ValueError, match="probe"):
        validate_configuration_extensions(content, yaml.safe_dump_all(result))


@pytest.mark.parametrize("connector", ["LMCacheConnectorV1", "MultiConnector", "UnknownConnector"])
def test_pd_unknown_transport_requires_an_adapter(connector):
    base = pd_manifest()
    base[0]["spec"]["template"]["spec"]["containers"][0]["args"][-1] = json.dumps(
        {"kv_connector": connector, "kv_role": "kv_both"}
    )
    with pytest.raises(ValueError, match="not yet supported"):
        compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=4)


def test_pd_preserves_split_transport_roles_without_mutating_source():
    base = pd_manifest()
    for doc, role in zip(base, ("kv_producer", "kv_consumer"), strict=True):
        server = doc["spec"]["template"]["spec"]["containers"][0]
        connector = json.loads(server["args"][-1])
        connector["kv_role"] = role
        server["args"][-1] = json.dumps(connector)
    original = deepcopy(base)
    result = compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=4)
    assert base == original
    for doc, role in zip(result, ("kv_producer", "kv_consumer"), strict=True):
        server = doc["spec"]["template"]["spec"]["containers"][0]
        config = json.loads(server["args"][-1])
        transport, cache = config["kv_connector_extra_config"]["connectors"]
        assert config["kv_role"] == role
        assert transport["kv_role"] == role
        assert cache["kv_role"] == "kv_both"


def test_pd_connector_in_command_is_replaced_once():
    from llm_d_lens.configuration.manifest_facts import _option

    base = pd_manifest()
    for doc in base:
        server = doc["spec"]["template"]["spec"]["containers"][0]
        server["command"] = ["vllm", "serve", *server.pop("args")]
    result = compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=2)
    for doc in result:
        server = doc["spec"]["template"]["spec"]["containers"][0]
        assert server["command"] == ["vllm", "serve"]
        assert server["args"].count("--kv-transfer-config") == 1
        assert json.loads(_option(server["args"], {"--kv-transfer-config"}, "test"))["kv_connector"] == "MultiConnector"


def test_pd_grouped_workloads_include_explicit_model_leaders():
    from llm_d_lens.configuration.guide_composition import composition_servers

    base = pd_manifest()
    for doc in base:
        pod = doc["spec"].pop("template")
        doc["kind"] = "LeaderWorkerSet"
        doc["spec"]["leaderWorkerTemplate"] = {"leaderTemplate": deepcopy(pod), "workerTemplate": pod}
    result = compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=4)
    assert len(composition_servers(result)) == 4
    for workload, server in composition_servers(result):
        assert json.loads(server["args"][-1])["kv_connector"] == "MultiConnector"
        assert workload["pod"]["initContainers"][0]["resources"] == server["resources"]


def precise_donor_manifest(block_size=64):
    return [
        {
            "kind": "Deployment",
            "metadata": {"name": "precise-decode"},
            "spec": {
                "template": {
                    "spec": {
                        "containers": [
                            {
                                "name": "modelserver",
                                "image": "runtime:1",
                                "command": ["vllm", "serve"],
                                "args": [
                                    "Qwen/Qwen3-32B",
                                    "--enable-scale-out",
                                    f"--block-size={block_size}",
                                    "--kv-events-config",
                                    '{"enable_kv_cache_events":true,"publisher":"zmq","endpoint":"$(KV_EVENTS_ENDPOINT)","replay_endpoint":"$(KV_EVENTS_REPLAY_ENDPOINT)","topic":"kv@$(POD_IP):$(POD_PORT)@Qwen/Qwen3-32B"}',
                                ],
                                "ports": [
                                    {"name": "kv-events", "containerPort": 5556, "protocol": "TCP"},
                                    {"name": "kv-replay", "containerPort": 5559, "protocol": "TCP"},
                                ],
                                "env": [
                                    {"name": "POD_IP", "valueFrom": {"fieldRef": {"fieldPath": "status.podIP"}}},
                                    {"name": "POD_PORT", "value": "8000"},
                                    {"name": "KV_EVENTS_ENDPOINT", "value": "tcp://*:5556"},
                                    {"name": "KV_EVENTS_REPLAY_ENDPOINT", "value": "tcp://*:5559"},
                                ],
                            }
                        ]
                    }
                }
            },
        }
    ]


def precise_router_values():
    return {
        "router": {
            "epp": {
                "replicas": 1,
                "pluginsConfigFile": "precise.yaml",
                "pluginsCustomConfig": {
                    "precise.yaml": """
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig
plugins:
  - type: token-producer
    parameters:
      modelName: Qwen/Qwen3-32B
      vllm:
        endpointDiscovery:
          attemptTimeout: 2s
        messagesRenderMode: auto
  - type: endpoint-notification-source
  - type: precise-prefix-cache-producer
    parameters:
      tokenProcessorConfig:
        blockSizeTokens: 64
      kvEventsConfig:
        topicFilter: kv@
        discoverPods: true
  - type: inflight-load-producer
    parameters:
      prefixMatchInfoProducerName: precise-prefix-cache-producer
  - type: prefix-cache-affinity-filter
    parameters:
      prefixMatchInfoProducerName: precise-prefix-cache-producer
  - type: token-load-scorer
dataLayer:
  sources:
    - pluginRef: endpoint-notification-source
      extractors:
        - pluginRef: precise-prefix-cache-producer
schedulingProfiles:
  - name: default
    plugins:
      - pluginRef: prefix-cache-affinity-filter
      - pluginRef: token-load-scorer
"""
                },
            }
        }
    }


def pd_with_router(block_size=128):
    base = pd_manifest()
    for doc, role, port in zip(base, ("prefill", "decode"), (8000, 8200), strict=True):
        doc["spec"]["template"]["metadata"] = {"labels": {"llm-d.ai/guide": "pd-disaggregation", "llm-d.ai/role": role}}
        server = doc["spec"]["template"]["spec"]["containers"][0]
        server["args"].append(f"--block-size={block_size}")
        server["ports"] = [{"name": "modelserver", "containerPort": port, "protocol": "TCP"}]
    base.extend(
        [
            {
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": {"name": "pd-disaggregation-epp", "namespace": "llm-d"},
                "spec": {
                    "replicas": 2,
                    "template": {
                        "spec": {
                            "containers": [{"name": "epp", "image": "epp:1"}],
                            "volumes": [{"name": "plugins", "configMap": {"name": "pd-epp-config"}}],
                        }
                    },
                },
            },
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": "pd-epp-config", "namespace": "llm-d"},
                "data": {
                    "pd-config.yaml": """
apiVersion: llm-d.ai/v1alpha1
kind: EndpointPickerConfig
plugins:
  - type: always-disagg-pd-decider
  - type: disagg-profile-handler
    parameters:
      deciders:
        prefill: always-disagg-pd-decider
  - type: prefill-filter
  - type: decode-filter
  - type: approx-prefix-cache-producer
  - type: inflight-load-producer
  - type: prefix-cache-affinity-filter
    parameters:
      peakPrefillThroughput: 33821
  - type: token-load-scorer
  - type: active-request-scorer
  - type: max-score-picker
schedulingProfiles:
  - name: prefill
    plugins:
      - pluginRef: prefill-filter
      - pluginRef: prefix-cache-affinity-filter
      - pluginRef: token-load-scorer
      - pluginRef: max-score-picker
  - name: decode
    plugins:
      - pluginRef: decode-filter
      - pluginRef: active-request-scorer
      - pluginRef: max-score-picker
"""
                },
            },
        ]
    )
    return base


def test_pd_precise_routing_composes_kv_events_prefill_render_service_and_pd_profiles():
    import yaml

    from llm_d_lens.configuration.guide_composition import (
        compose_precise_routing,
        has_precise_router_policy,
        reconcile_precise_routing,
    )
    from llm_d_lens.configuration.manifest_facts import _option
    from llm_d_lens.deploy.source_composition import rendered_optimizations

    base = pd_with_router(block_size=128)
    assert not has_precise_router_policy(base)
    with_cache = compose_native_cpu_cache(base, donor(), guide="pd-disaggregation", capacity_gib=4)
    composed = compose_precise_routing(
        with_cache,
        precise_donor_manifest(block_size=64),
        precise_router_values(),
        model="org/target-model",
        namespace="llm-d",
    )
    assert has_precise_router_policy(composed)

    for doc in composed[:2]:
        server = doc["spec"]["template"]["spec"]["containers"][0]
        assert json.loads(_option(server["args"], {"--kv-transfer-config"}, "test"))["kv_connector"] == "MultiConnector"
        assert "--enable-scale-out" in server["args"]
        events = json.loads(_option(server["args"], {"--kv-events-config"}, "test"))
        assert events["topic"] == "kv@$(POD_IP):$(POD_PORT)@org/target-model"
        assert _option(server["args"], {"--block-size"}, "test") == "128"
        assert {port["containerPort"] for port in server["ports"]} >= {5556, 5559}
        env_names = {entry["name"] for entry in server["env"]}
        assert {"POD_IP", "POD_PORT", "KV_EVENTS_ENDPOINT", "KV_EVENTS_REPLAY_ENDPOINT", "PYTHONHASHSEED"} <= env_names

    render_service = next(doc for doc in composed if doc["kind"] == "Service")
    assert render_service["metadata"]["name"] == "pd-disaggregation-render"
    assert render_service["spec"]["selector"] == {"llm-d.ai/guide": "pd-disaggregation", "llm-d.ai/role": "prefill"}
    assert render_service["spec"]["ports"] == [
        {"name": "render-http", "port": 8000, "targetPort": "modelserver", "protocol": "TCP"}
    ]

    epp_deploy = next(doc for doc in composed if doc["metadata"]["name"] == "pd-disaggregation-epp")
    assert epp_deploy["spec"]["replicas"] == 1
    picker = yaml.safe_load(composed[3]["data"]["pd-config.yaml"])
    plugin_types = [plugin["type"] for plugin in picker["plugins"]]
    assert "approx-prefix-cache-producer" not in plugin_types
    assert {
        "always-disagg-pd-decider",
        "disagg-profile-handler",
        "token-producer",
        "precise-prefix-cache-producer",
    } <= set(plugin_types)
    assert [profile["name"] for profile in picker["schedulingProfiles"]] == ["prefill", "decode"]
    token_plugin = next(p for p in picker["plugins"] if p["type"] == "token-producer")
    assert token_plugin["parameters"]["modelName"] == "org/target-model"
    assert token_plugin["parameters"]["vllm"] == {
        "url": "http://pd-disaggregation-render:8000",
        "messagesRenderMode": "auto",
    }
    precise_plugin = next(p for p in picker["plugins"] if p["type"] == "precise-prefix-cache-producer")
    assert precise_plugin["parameters"]["tokenProcessorConfig"]["blockSizeTokens"] == 128
    affinity = next(p for p in picker["plugins"] if p["type"] == "prefix-cache-affinity-filter")
    assert affinity["parameters"]["prefixMatchInfoProducerName"] == "precise-prefix-cache-producer"
    assert affinity["parameters"]["peakPrefillThroughput"] == 33821

    for doc in composed[:2]:
        server = doc["spec"]["template"]["spec"]["containers"][0]
        server["args"] = ["--block-size=256" if a == "--block-size=128" else a for a in server["args"]]
    reconcile_precise_routing(composed, "org/rebound-model")
    rebound_picker = yaml.safe_load(composed[3]["data"]["pd-config.yaml"])
    assert (
        next(p for p in rebound_picker["plugins"] if p["type"] == "token-producer")["parameters"]["modelName"]
        == "org/rebound-model"
    )
    assert (
        next(p for p in rebound_picker["plugins"] if p["type"] == "precise-prefix-cache-producer")["parameters"][
            "tokenProcessorConfig"
        ]["blockSizeTokens"]
        == 256
    )

    facts = rendered_optimizations(composed, "a" * 40)
    states = {item["id"]: item["state"] for item in facts["features"]}
    assert states["transfer"] == "configured"
    assert states["index"] == "configured"
    assert states["cache"] == "configured"


def test_precise_routing_composition_rejects_disabled_dependencies_and_mismatched_blocks():
    from llm_d_lens.configuration.guide_composition import compose_precise_routing

    disabled_prefix = pd_with_router()
    disabled_prefix[0]["spec"]["template"]["spec"]["containers"][0]["args"].append("--no-enable-prefix-caching")
    with pytest.raises(ValueError, match="disabled prefix caching"):
        compose_precise_routing(
            disabled_prefix, precise_donor_manifest(), precise_router_values(), model="m", namespace="llm-d"
        )

    mismatched_blocks = pd_with_router(block_size=64)
    mismatched_blocks[1]["spec"]["template"]["spec"]["containers"][0]["args"][-1] = "--block-size=128"
    with pytest.raises(ValueError, match="identical --block-size"):
        compose_precise_routing(
            mismatched_blocks, precise_donor_manifest(), precise_router_values(), model="m", namespace="llm-d"
        )
