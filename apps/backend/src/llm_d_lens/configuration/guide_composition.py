"""Source-bound composition of donor KV-cache and precise-routing capabilities into a serving Guide."""

import json
import math
import re
from copy import deepcopy

import yaml
from kubernetes.utils.quantity import parse_quantity

from llm_d_lens.deploy.providers.guide_adapter import set_vllm_argument

from .manifest_facts import _invocation_tokens, _option, workload_roles


def compose_native_cpu_cache(base, donor, *, guide, capacity_gib):
    """Return a new manifest; never overwrite a transport connector or import a router."""
    if guide not in {"optimized-baseline", "precise-prefix-cache-routing", "pd-disaggregation"}:
        raise ValueError("No native CPU cache composition adapter exists for this Guide.")
    if (
        isinstance(capacity_gib, bool)
        or not isinstance(capacity_gib, (int, float))
        or not math.isfinite(capacity_gib)
        or not 0 < capacity_gib <= 1024
    ):
        raise ValueError("CPU cache capacity must be greater than zero and at most 1024 GiB per replica.")
    sources = [c for _, c in composition_servers(donor)]
    if not sources:
        raise ValueError("The native CPU cache source has no model server.")
    connectors = []
    for server in sources:
        tokens = _invocation_tokens(server, "cache source")
        value = json.loads(_option(tokens, {"--kv-transfer-config"}, "cache source") or "{}")
        if (
            not isinstance(value, dict)
            or value.get("kv_connector") != "OffloadingConnector"
            or value.get("kv_role") != "kv_both"
            or value.get("kv_connector_module_path")
        ):
            raise ValueError("Only the source-declared native OffloadingConnector with kv_both can be composed.")
        extra = value.get("kv_connector_extra_config", {})
        if (
            not isinstance(extra, dict)
            or type(extra.get("cpu_bytes_to_use")) is not int
            or set(extra) - {"cpu_bytes_to_use"}
        ):
            raise ValueError("The cache source requires unsupported connector dependencies.")
        connectors.append(value)
    if any(value != connectors[0] for value in connectors):
        raise ValueError("The source has inconsistent CPU cache connectors.")
    output = deepcopy(base)
    targets = composition_servers(output)
    if guide == "pd-disaggregation" and {w["role"] for w, _ in targets} != {"prefill", "decode"}:
        raise ValueError("P/D composition requires both prefill and decode transport roles.")
    if not targets:
        raise ValueError("The selected Guide has no supported model server.")
    source_images = {c.get("image") for c in sources}
    extra_bytes = int(capacity_gib * 1024**3)
    for workload, server in targets:
        if not server.get("image") or source_images != {server["image"]}:
            raise ValueError(
                "Composition requires identical source runtime images; choose compatible pinned Guide versions."
            )
        command = server.get("command") or []
        if command and command[0].rsplit("/", 1)[-1] in {"sh", "bash"}:
            raise ValueError("Composition requires a direct model-server invocation.")
        tokens = _invocation_tokens(server, "composition target")
        if any(
            t == "--no-enable-prefix-caching"
            or t.lower() == "--enable-prefix-caching=false"
            or (t == "--enable-prefix-caching" and i + 1 < len(tokens) and tokens[i + 1].lower() == "false")
            for i, t in enumerate(tokens)
        ):
            raise ValueError("CPU cache composition conflicts with explicitly disabled prefix caching.")
        existing = json.loads(_option(tokens, {"--kv-transfer-config"}, "composition target") or "{}")
        if not isinstance(existing, dict):
            raise ValueError("KV transfer configuration must be an object.")
        config = deepcopy(connectors[0])
        config["kv_connector_extra_config"]["cpu_bytes_to_use"] = extra_bytes
        if guide == "pd-disaggregation":
            expected_role = {"prefill": "kv_producer", "decode": "kv_consumer"}.get(workload["role"])
            if (
                existing.get("kv_connector") != "NixlConnector"
                or existing.get("kv_role") not in {"kv_both", expected_role}
                or existing.get("kv_connector_module_path")
            ):
                raise ValueError(
                    "Adding CPU KV cache to P/D is not yet supported for this transport. "
                    "The cache adapter requires the built-in NixlConnector with its role-preserving "
                    "kv_both, kv_producer, or kv_consumer configuration; use a P/D candidate without "
                    "CPU KV offload to preserve the original transport."
                )
            # Keep transport-specific settings in the child; engine identity belongs
            # to the wrapper and is inherited by both children in MultiConnector.
            transport = deepcopy(existing)
            transport.pop("engine_id", None)
            config = {
                **existing,
                "kv_connector": "MultiConnector",
                "kv_connector_extra_config": {"connectors": [transport, config]},
            }
            probe = runtime_probe(server, config)
            initializers = workload["pod"].setdefault("initContainers", [])
            if any(c.get("name") == probe["name"] for c in initializers):
                raise ValueError("The connector capability probe name is already in use.")
            initializers.append(probe)
        elif existing:
            raise ValueError(
                "The selected Guide already owns a KV connector; no composition adapter exists for this transport."
            )
        # Normalize only the direct invocation, handling options in command or args.
        server["command"] = ["vllm", "serve"]
        server["args"] = set_vllm_argument(tokens, "kv-transfer-config", "")[:-1] + [
            "--kv-transfer-config",
            json.dumps(config, separators=(",", ":")),
        ]

        resources = server.setdefault("resources", {})
        requests = resources.setdefault("requests", {})
        limits = resources.setdefault("limits", {})
        requested = parse_quantity(str(requests.get("memory", "0")))
        limited = parse_quantity(str(limits.get("memory", requests.get("memory", "0"))))
        requests["memory"] = str(int(requested) + extra_bytes)
        if "memory" in limits:
            limits["memory"] = str(int(max(requested, limited)) + extra_bytes)
        if guide == "pd-disaggregation":
            initializers[-1] = runtime_probe(server, config)
    return output


# Runs in the selected image before model startup, not on the Lens host. This is
# an import/schema capability check, not a claim of GPU correctness/performance.
RUNTIME_PROBE = """import json, sys
from importlib.metadata import version
runtime_version = version('vllm')
if runtime_version.split('+')[0] == '0.19.0':
    raise RuntimeError(
        'vLLM 0.19.0 has a known CPU offloading defect (#39500/#39617); '
        'use an image containing the upstream fix.'
    )
from vllm.config import KVTransferConfig
from vllm.distributed.kv_transfer.kv_connector.factory import KVConnectorFactory
config = json.loads(sys.argv[1])
for item in [config, *config['kv_connector_extra_config']['connectors']]:
    KVConnectorFactory.get_connector_class(KVTransferConfig(**item))
print(
    'vLLM ' + runtime_version
    + ': KV connector import and schema checks passed; workload validation is still required.'
)
"""


def runtime_probe(server, config):
    probe = {
        "name": "lens-kv-connector-check",
        "image": server["image"],
        "command": ["python3", "-c", RUNTIME_PROBE],
        "args": [json.dumps(config, separators=(",", ":"))],
    }
    for key in ("imagePullPolicy", "env", "envFrom", "volumeMounts", "securityContext", "resources"):
        if key in server:
            probe[key] = deepcopy(server[key])
    return probe


def composed_cache_config(connector, *, pd=False):
    """Validate the bounded adapter shape, returning its cache child."""
    if not isinstance(connector, dict):
        raise ValueError("Composed KV connector must be an object.")
    if pd:
        children = connector.get("kv_connector_extra_config", {}).get("connectors")
        transport_role = (
            children[0].get("kv_role")
            if isinstance(children, list) and children and isinstance(children[0], dict)
            else None
        )
        if (
            connector.get("kv_connector") != "MultiConnector"
            or not isinstance(children, list)
            or len(children) != 2
            or not all(isinstance(child, dict) for child in children)
            or children[0].get("kv_connector") != "NixlConnector"
            or transport_role not in {"kv_both", "kv_producer", "kv_consumer"}
            or connector.get("kv_role") != transport_role
            or any(child.get("kv_connector_module_path") for child in [connector, *children])
        ):
            raise ValueError("P/D composition requires ordered NixlConnector and OffloadingConnector children.")
        connector = children[1]
    if connector.get("kv_connector") != "OffloadingConnector" or connector.get("kv_role") != "kv_both":
        raise ValueError("Composed cache must use OffloadingConnector with kv_both.")
    return connector


def composition_servers(documents):
    """Include explicit leaders as well as worker templates in grouped workloads."""
    workloads = workload_roles(documents)
    for workload in list(workloads):
        leader = workload["spec"].get("leaderWorkerTemplate", {}).get("leaderTemplate", {}).get("spec")
        if leader:
            workloads.append({**workload, "pod": leader})
    return [(w, c) for w in workloads for c in w["pod"].get("containers", []) if c.get("name") == "modelserver"]


def _pod_template_labels(workload: dict) -> dict[str, str]:
    spec = workload.get("spec") or {}
    if workload.get("kind") == "Deployment":
        labels = (spec.get("template") or {}).get("metadata", {}).get("labels")
    else:
        worker = (spec.get("leaderWorkerTemplate") or {}).get("workerTemplate") or {}
        labels = (worker.get("metadata") or {}).get("labels")
    return dict(labels or workload.get("pod_labels") or {})


def _mounted_configmaps(documents: list[dict]) -> tuple[set[str], list[dict]]:
    mounted: set[str] = set()
    epp_deployments: list[dict] = []
    for doc in documents:
        if doc.get("kind") != "Deployment":
            continue
        pod = ((doc.get("spec") or {}).get("template") or {}).get("spec") or {}
        names = {
            vol["configMap"]["name"]
            for vol in (pod.get("volumes") or [])
            if isinstance(vol, dict) and isinstance((vol.get("configMap") or {}).get("name"), str)
        }
        mounted.update(names)
        if any(isinstance(c, dict) and c.get("name") == "epp" for c in (pod.get("containers") or [])) or names:
            epp_deployments.append(doc)
    return mounted, epp_deployments


def has_precise_router_policy(documents: list[dict]) -> bool:
    """Return True when a mounted EndpointPickerConfig already uses precise prefix-cache routing."""
    mounted, _ = _mounted_configmaps(documents)
    for doc in documents:
        if doc.get("kind") != "ConfigMap" or doc.get("metadata", {}).get("name") not in mounted:
            continue
        for key, text in (doc.get("data") or {}).items():
            if not re.search(r"\.ya?ml$|\.json$", str(key)) or not isinstance(text, str):
                continue
            try:
                configs = [item for item in yaml.safe_load_all(text) if isinstance(item, dict)]
            except yaml.YAMLError:
                continue
            for config in configs:
                if config.get("kind") == "EndpointPickerConfig" and any(
                    isinstance(plugin, dict)
                    and plugin.get("type") in {"precise-prefix-cache-producer", "precise-prefix-cache-scorer"}
                    for plugin in (config.get("plugins") or [])
                ):
                    return True
    return False


def compose_precise_routing(
    base: list[dict],
    donor: list[dict],
    router_values: dict,
    *,
    model: str,
    namespace: str,
) -> list[dict]:
    """Compose source-declared KV-event emission, render Service and precise EPP plugins onto a serving Guide."""
    sources = [container for _, container in composition_servers(donor)]
    if not sources:
        raise ValueError("The precise prefix-cache routing source has no model server.")
    donor_server = sources[0]
    donor_tokens = _invocation_tokens(donor_server, "precise source")
    events = json.loads(_option(donor_tokens, {"--kv-events-config"}, "precise source") or "{}")
    if (
        not isinstance(events, dict)
        or events.get("enable_kv_cache_events") is not True
        or events.get("publisher") != "zmq"
        or not isinstance(events.get("topic"), str)
        or not re.fullmatch(r"kv@[^@]+@.+", events["topic"])
    ):
        raise ValueError("The precise prefix-cache routing source has an unsupported --kv-events-config.")
    donor_block_raw = _option(donor_tokens, {"--block-size"}, "precise source")
    donor_block_size = int(donor_block_raw) if donor_block_raw is not None else 64
    needs_scale_out = "--enable-scale-out" in donor_tokens
    donor_ports = [
        deepcopy(port)
        for port in (donor_server.get("ports") or [])
        if isinstance(port, dict) and str(port.get("name") or "").startswith("kv-")
    ]
    if not donor_ports:
        raise ValueError("The precise prefix-cache routing source exposes no KV event ports.")
    donor_env_keys = {"POD_IP", "POD_PORT", "KV_EVENTS_ENDPOINT", "KV_EVENTS_REPLAY_ENDPOINT"}
    donor_env = [
        deepcopy(entry)
        for entry in (donor_server.get("env") or [])
        if isinstance(entry, dict) and entry.get("name") in donor_env_keys
    ]

    epp_spec = ((router_values.get("router") if isinstance(router_values, dict) else None) or {}).get("epp") or {}
    config_key = epp_spec.get("pluginsConfigFile")
    raw_custom = (epp_spec.get("pluginsCustomConfig") or {}).get(config_key or "")
    donor_picker = yaml.safe_load(raw_custom) if isinstance(raw_custom, str) else None
    if not isinstance(donor_picker, dict) or donor_picker.get("kind") != "EndpointPickerConfig":
        raise ValueError("The precise prefix-cache routing source has no EndpointPickerConfig.")
    donor_plugins = [item for item in (donor_picker.get("plugins") or []) if isinstance(item, dict)]
    token_plugin = next((item for item in donor_plugins if item.get("type") == "token-producer"), None)
    notification_plugin = next(
        (item for item in donor_plugins if item.get("type") == "endpoint-notification-source"), None
    )
    precise_plugin = next((item for item in donor_plugins if item.get("type") == "precise-prefix-cache-producer"), None)
    donor_data_layer = donor_picker.get("dataLayer")
    if (
        token_plugin is None
        or notification_plugin is None
        or precise_plugin is None
        or not isinstance(donor_data_layer, dict)
    ):
        raise ValueError("The precise prefix-cache routing source has incomplete EPP plugins.")

    output = deepcopy(base)
    targets = composition_servers(output)
    if not targets:
        raise ValueError("The selected Guide has no supported model server.")
    roles = {workload["role"] for workload, _ in targets}
    if "prefill" in roles and "decode" not in roles:
        raise ValueError("P/D precise routing composition requires both prefill and decode roles.")

    declared_sizes: set[int] = set()
    for _, server in targets:
        command = server.get("command") or []
        if command and command[0].rsplit("/", 1)[-1] in {"sh", "bash"}:
            raise ValueError("Precise routing composition requires a direct model-server invocation.")
        tokens = _invocation_tokens(server, "precise target")
        if any(
            t == "--no-enable-prefix-caching"
            or t.lower() == "--enable-prefix-caching=false"
            or (t == "--enable-prefix-caching" and i + 1 < len(tokens) and tokens[i + 1].lower() == "false")
            for i, t in enumerate(tokens)
        ):
            raise ValueError("Precise routing composition conflicts with explicitly disabled prefix caching.")
        if _option(tokens, {"--kv-events-config"}, "precise target") is not None:
            raise ValueError("The selected Guide already declares --kv-events-config.")
        raw_size = _option(tokens, {"--block-size"}, "precise target")
        if raw_size is not None:
            declared_sizes.add(int(raw_size))
    if len(declared_sizes) > 1:
        raise ValueError("Precise routing requires an identical --block-size across prefill and decode roles.")
    block_size = next(iter(declared_sizes)) if declared_sizes else donor_block_size

    events_payload = deepcopy(events)
    events_payload["topic"] = events_payload["topic"].rsplit("@", 1)[0] + "@" + model
    serialized_events = json.dumps(events_payload, separators=(",", ":"))
    for _, server in targets:
        tokens = _invocation_tokens(server, "precise target")
        args = set_vllm_argument(tokens, "block-size", str(block_size))
        if needs_scale_out and not any(
            arg == "--enable-scale-out" or arg.startswith("--enable-scale-out=") or arg == "--no-enable-scale-out"
            for arg in args
        ):
            args.append("--enable-scale-out")
        args = set_vllm_argument(args, "kv-events-config", "")[:-1] + ["--kv-events-config", serialized_events]
        server["command"] = ["vllm", "serve"]
        server["args"] = args

        ports = server.setdefault("ports", [])
        for donor_port in donor_ports:
            existing = next(
                (
                    p
                    for p in ports
                    if p.get("containerPort") == donor_port.get("containerPort")
                    or p.get("name") == donor_port.get("name")
                ),
                None,
            )
            if existing is not None and existing.get("containerPort") != donor_port.get("containerPort"):
                raise ValueError(f"Conflicting container port {donor_port.get('name')} on model server.")
            if existing is None:
                ports.append(deepcopy(donor_port))

        env = server.setdefault("env", [])
        existing_env = {entry.get("name"): entry for entry in env if isinstance(entry, dict) and entry.get("name")}
        for donor_entry in donor_env:
            key = donor_entry["name"]
            if key not in existing_env:
                env.append(deepcopy(donor_entry))
        if "PYTHONHASHSEED" not in existing_env:
            env.append({"name": "PYTHONHASHSEED", "value": "0"})

    render_role = "prefill" if "prefill" in roles else next(iter(roles))
    serving_workloads = [
        workload
        for workload in workload_roles(output)
        if any(c.get("name") == "modelserver" for c in workload["pod"].get("containers", []))
    ]
    render_workloads = [workload for workload in serving_workloads if workload["role"] == render_role]
    if not render_workloads:
        raise ValueError("No model-server workload matches the render endpoint role.")
    raw_labels = _pod_template_labels(render_workloads[0])
    preferred_keys = ("llm-d.ai/guide", "llm-d.ai/role", "app")
    selector = {k: str(raw_labels[k]) for k in preferred_keys if k in raw_labels} or {
        str(k): str(v) for k, v in raw_labels.items()
    }
    if not selector or any(
        workload["role"] != render_role and all(_pod_template_labels(workload).get(k) == v for k, v in selector.items())
        for workload in serving_workloads
    ):
        raise ValueError("Render Service requires pod labels uniquely identifying the target model-server role.")
    render_server = next(c for c in render_workloads[0]["pod"]["containers"] if c.get("name") == "modelserver")
    http_port = next(
        (
            p
            for p in (render_server.get("ports") or [])
            if isinstance(p, dict) and (p.get("name") == "modelserver" or p.get("containerPort") == 8000)
        ),
        None,
    )
    target_port = http_port["name"] if http_port and http_port.get("name") else 8000

    mounted, epp_deployments = _mounted_configmaps(output)
    service_names = {doc.get("metadata", {}).get("name") for doc in output if doc.get("kind") == "Service"}
    epp_name = next(
        (
            str(doc.get("metadata", {}).get("name") or "")
            for doc in epp_deployments
            if any(
                isinstance(c, dict) and c.get("name") == "epp"
                for c in doc["spec"]["template"]["spec"].get("containers", [])
            )
        ),
        "",
    )
    prefix = epp_name.removesuffix("-epp") if epp_name.endswith("-epp") and epp_name != "-epp" else "precise"
    render_service_name = f"{prefix}-render"
    if render_service_name in service_names:
        render_service_name = f"{prefix}-vllm-render"

    updated_configs = 0
    updated_cm_names: set[str] = set()
    for doc in output:
        if doc.get("kind") != "ConfigMap" or doc.get("metadata", {}).get("name") not in mounted:
            continue
        for key, text in list((doc.get("data") or {}).items()):
            if not re.search(r"\.ya?ml$|\.json$", str(key)) or not isinstance(text, str):
                continue
            try:
                configs = [item for item in yaml.safe_load_all(text) if item is not None]
            except yaml.YAMLError:
                continue
            changed = False
            for config in configs:
                if not isinstance(config, dict) or config.get("kind") != "EndpointPickerConfig":
                    continue
                plugins = [item for item in (config.get("plugins") or []) if isinstance(item, dict)]
                affinity = next((item for item in plugins if item.get("type") == "prefix-cache-affinity-filter"), None)
                if affinity is None:
                    raise ValueError("Enable prefix-cache affinity before enabling precise prefix-cache routing.")
                plugins = [
                    item
                    for item in plugins
                    if item.get("type")
                    not in {
                        "approx-prefix-cache-producer",
                        "token-producer",
                        "endpoint-notification-source",
                        "precise-prefix-cache-producer",
                        "precise-prefix-cache-scorer",
                    }
                ]
                token_copy = deepcopy(token_plugin)
                vllm_params = {
                    k: deepcopy(v)
                    for k, v in (token_copy.get("parameters", {}).get("vllm") or {}).items()
                    if k != "endpointDiscovery"
                }
                vllm_params["url"] = f"http://{render_service_name}:8000"
                token_copy.setdefault("parameters", {})["modelName"] = model
                token_copy["parameters"]["vllm"] = vllm_params
                notification_copy = deepcopy(notification_plugin)
                precise_copy = deepcopy(precise_plugin)
                precise_copy.setdefault("parameters", {}).setdefault("tokenProcessorConfig", {})["blockSizeTokens"] = (
                    block_size
                )
                precise_ref = precise_copy.get("name") or precise_copy["type"]
                affinity.setdefault("parameters", {})["prefixMatchInfoProducerName"] = precise_ref
                for plugin in plugins:
                    if plugin.get("type") == "inflight-load-producer":
                        plugin.setdefault("parameters", {})["prefixMatchInfoProducerName"] = precise_ref
                insert_at = next(
                    (
                        idx
                        for idx, item in enumerate(plugins)
                        if item.get("type") in {"inflight-load-producer", "prefix-cache-affinity-filter"}
                    ),
                    len(plugins),
                )
                plugins[insert_at:insert_at] = [token_copy, notification_copy, precise_copy]
                config["plugins"] = plugins

                data_layer = deepcopy(config.get("dataLayer")) if isinstance(config.get("dataLayer"), dict) else {}
                sources_list = list(data_layer.get("sources") or [])
                for donor_src in donor_data_layer.get("sources") or []:
                    if donor_src not in sources_list:
                        sources_list.append(deepcopy(donor_src))
                data_layer["sources"] = sources_list
                config["dataLayer"] = data_layer
                changed = True
                updated_configs += 1
            if changed:
                doc["data"][key] = yaml.safe_dump_all(configs, sort_keys=False, width=100000)
                updated_cm_names.add(doc["metadata"]["name"])
    if not updated_configs:
        raise ValueError("Precise routing composition requires a mounted EndpointPickerConfig.")

    for doc in epp_deployments:
        pod = ((doc.get("spec") or {}).get("template") or {}).get("spec") or {}
        cm_refs = {
            (vol.get("configMap") or {}).get("name") for vol in (pod.get("volumes") or []) if isinstance(vol, dict)
        }
        if cm_refs & updated_cm_names:
            doc.setdefault("spec", {})["replicas"] = 1

    output.append(
        {
            "apiVersion": "v1",
            "kind": "Service",
            "metadata": {
                "name": render_service_name,
                "namespace": namespace,
                "labels": {"app.kubernetes.io/component": "vllm-render"},
            },
            "spec": {
                "selector": selector,
                "ports": [
                    {
                        "name": "render-http",
                        "port": 8000,
                        "targetPort": target_port,
                        "protocol": "TCP",
                    }
                ],
            },
        }
    )
    return output


def reconcile_precise_routing(documents: list[dict], model: str) -> None:
    """Keep precise EPP tokenizer modelName and blockSizeTokens aligned with bound model-server flags."""
    if not has_precise_router_policy(documents):
        return
    servers = [container for _, container in composition_servers(documents)]
    sizes = {
        int(raw)
        for server in servers
        if (raw := _option(_invocation_tokens(server, "precise"), {"--block-size"}, "precise")) is not None
    }
    if len(sizes) > 1:
        raise ValueError("Precise routing requires one consistent model-server --block-size.")
    block_size = next(iter(sizes)) if sizes else None
    mounted, _ = _mounted_configmaps(documents)
    for doc in documents:
        if doc.get("kind") != "ConfigMap" or doc.get("metadata", {}).get("name") not in mounted:
            continue
        for key, text in list((doc.get("data") or {}).items()):
            if not re.search(r"\.ya?ml$|\.json$", str(key)) or not isinstance(text, str):
                continue
            try:
                configs = [item for item in yaml.safe_load_all(text) if item is not None]
            except yaml.YAMLError:
                continue
            changed = False
            for config in configs:
                if not isinstance(config, dict) or config.get("kind") != "EndpointPickerConfig":
                    continue
                for plugin in config.get("plugins") or []:
                    if not isinstance(plugin, dict):
                        continue
                    if plugin.get("type") == "token-producer":
                        plugin.setdefault("parameters", {})["modelName"] = model
                        changed = True
                    elif (
                        plugin.get("type") in {"precise-prefix-cache-producer", "precise-prefix-cache-scorer"}
                        and block_size is not None
                    ):
                        token_cfg = plugin.setdefault("parameters", {}).setdefault("tokenProcessorConfig", {})
                        token_cfg["blockSizeTokens"] = block_size
                        changed = True
            if changed:
                doc["data"][key] = yaml.safe_dump_all(configs, sort_keys=False, width=100000)
