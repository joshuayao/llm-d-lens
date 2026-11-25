// Pure helpers that turn the create-cluster wizard's configuration state into
// the backend provisioning plan and derive the review/execution views.
// Field names follow the backend DTOs in
// apps/backend/src/llm_d_lens/cluster/plan.py (camelCase aliases).
// See docs/design/cluster-permission-preflight-design.md sections 4.1/4.2/8.

export const PLAN_VERSION = 5;
export const MONITORING_NAMESPACE_PREFIX = 'lens-monitoring';

const IMAGE_REF_MAX_LENGTH = 512;
const IMAGE_SHELL_YAML_META_RE = /[;&|$`()<>{}[\]*?#!~%,=]/;
const IMAGE_REGISTRY_RE = /^(?:localhost(?::([1-9]\d{0,4}))?|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+(?::([1-9]\d{0,4}))?|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?:([1-9]\d{0,4}))$/;
const IMAGE_REPO_SEGMENT_RE = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const IMAGE_TAG_RE = /^:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_DIGEST_RE = /^@sha(?:256:[0-9a-f]{64}|384:[0-9a-f]{96}|512:[0-9a-f]{128})$/;

function hasAsciiControlChar(value) {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

/**
 * Validate an optional OCI container image reference, returning `''` when valid
 * (including empty/whitespace-only, which means "use hardware profile default")
 * or an actionable validation message otherwise. Mirrors the backend
 * `validate_container_image_ref` grammar and injection guards.
 */
export function validateContainerImageRef(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw !== 'string') return 'Container image must be a string.';
    if (hasAsciiControlChar(raw)) {
        return 'Container image must not contain control characters.';
    }
    if (!raw.trim()) return '';
    if (raw !== raw.trim() || /\s/.test(raw)) {
        return 'Container image must not contain whitespace.';
    }
    if (raw.length > IMAGE_REF_MAX_LENGTH) {
        return `Container image must be ${IMAGE_REF_MAX_LENGTH} characters or fewer.`;
    }
    if (
        raw.startsWith('-')
        || raw.includes('://')
        || raw.includes('\\')
        || raw.includes("'")
        || raw.includes('"')
        || IMAGE_SHELL_YAML_META_RE.test(raw)
    ) {
        return 'Container image contains unsupported characters or syntax.';
    }

    let nameAndTag = raw;
    let digestPart = '';
    const atIndex = raw.indexOf('@');
    if (atIndex !== -1) {
        digestPart = raw.slice(atIndex);
        if (!IMAGE_DIGEST_RE.test(digestPart)) {
            return 'Container image digest must be a valid @sha256, @sha384, or @sha512 digest.';
        }
        nameAndTag = raw.slice(0, atIndex);
    }

    let namePart = nameAndTag;
    let tagPart = '';
    const lastSlash = nameAndTag.lastIndexOf('/');
    const lastColon = nameAndTag.lastIndexOf(':');
    if (lastColon > lastSlash) {
        tagPart = nameAndTag.slice(lastColon);
        if (!IMAGE_TAG_RE.test(tagPart)) {
            return 'Container image tag is invalid.';
        }
        namePart = nameAndTag.slice(0, lastColon);
    }

    if (!tagPart && !digestPart) {
        return 'Container image must include an explicit :tag or @sha256 digest.';
    }
    if (!namePart) {
        return 'Container image repository is required.';
    }

    const segments = namePart.split('/');
    if (segments.some((segment) => !segment)) {
        return 'Container image repository path must not contain empty segments.';
    }

    let repoSegments = segments;
    if (
        segments.length >= 2
        && (segments[0] === 'localhost' || segments[0].includes('.') || segments[0].includes(':'))
    ) {
        const regMatch = IMAGE_REGISTRY_RE.exec(segments[0]);
        if (!regMatch) {
            return 'Container image registry host is invalid.';
        }
        const portText = regMatch[1] || regMatch[2] || regMatch[3];
        if (portText) {
            const port = Number(portText);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                return 'Container image registry port must be between 1 and 65535.';
            }
        }
        repoSegments = segments.slice(1);
    }

    if (!repoSegments.length || repoSegments.some((segment) => !IMAGE_REPO_SEGMENT_RE.test(segment))) {
        return 'Container image repository must use lowercase OCI path segments.';
    }

    return '';
}

export function defaultMonitoringNamespace(clusterId) {
    const raw = String(clusterId ?? '').trim().toLowerCase();
    const maxSuffixLength = 63 - MONITORING_NAMESPACE_PREFIX.length - 1;
    const cleaned = raw
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxSuffixLength)
        .replace(/-+$/g, '');
    return cleaned ? `${MONITORING_NAMESPACE_PREFIX}-${cleaned}` : MONITORING_NAMESPACE_PREFIX;
}

function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
}

function optionalString(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function optionalInt(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function optionalPort(value) {
    if (value === undefined || value === null || typeof value === 'boolean') return null;
    const text = typeof value === 'string' ? value.trim() : value;
    if (text === '') return null;
    const number = Number(text);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function integerOrDefault(value, fallback) {
    const number = optionalInt(value);
    return number === null ? fallback : number;
}

function booleanOrDefault(value, fallback) {
    return value === undefined || value === null ? fallback : Boolean(value);
}

function normalizeList(value) {
    if (Array.isArray(value)) return [...value];
    if (value === undefined || value === null) return [];
    return [value];
}

function normalizeRbac(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') {
        return value
            .replace(/,/g, '+')
            .split('+')
            .map((part) => part.trim())
            .filter(Boolean);
    }
    return [];
}

function gatewayPlan(config) {
    const gateway = config.gateway || {};
    return {
        provider: firstDefined(gateway.provider, config.gatewayProvider, ''),
        namespace: firstDefined(gateway.namespace, config.gatewayNamespace, ''),
        namespaceMode: firstDefined(gateway.namespaceMode, config.gatewayNamespaceMode, 'existing'),
        name: firstDefined(gateway.name, config.gatewayName, ''),
        publicUrl: optionalString(firstDefined(gateway.publicUrl, config.gatewayPublicUrl)),
        port: optionalInt(firstDefined(gateway.port, config.gatewayPort)),
        authzHost: optionalString(firstDefined(gateway.authzHost, config.gatewayAuthzHost)),
        serviceType: optionalString(firstDefined(gateway.serviceType, config.gatewayServiceType)),
    };
}

function acceleratorPlans(config) {
    const accelerators = Array.isArray(config.accelerators) ? config.accelerators : [];
    return accelerators.filter(Boolean).map((accelerator) => ({
        vendor: firstDefined(accelerator.vendor, ''),
        model: optionalString(accelerator.model),
        mode: firstDefined(accelerator.mode, 'plugin'),
        operator: optionalString(accelerator.operator),
        profile: optionalString(accelerator.profile),
        rbac: normalizeRbac(accelerator.rbac),
    }));
}

function storagePlan(config) {
    const storage = config.storage || {};
    return {
        kind: firstDefined(storage.kind, config.storageKind, 'none'),
        volumeId: optionalString(firstDefined(storage.volumeId, config.volumeId, config.storageVolumeId)),
        namespace: optionalString(firstDefined(storage.namespace, config.storageNamespace)),
        namespaceMode: firstDefined(storage.namespaceMode, config.storageNamespaceMode, 'existing'),
        capacity: optionalString(firstDefined(storage.capacity, config.storageCapacity)),
        storageClass: optionalString(firstDefined(storage.storageClass, config.storageClass)),
        accessMode: optionalString(firstDefined(storage.accessMode, config.accessMode)),
        readOnly: booleanOrDefault(firstDefined(storage.readOnly, config.readOnly), false),
        purposes: normalizeList(firstDefined(storage.purposes, config.purposes)),
        hostPath: optionalString(firstDefined(storage.hostPath, config.hostPath)),
        nfsServer: optionalString(firstDefined(storage.nfsServer, config.nfsServer)),
        nfsPath: optionalString(firstDefined(storage.nfsPath, config.nfsPath)),
    };
}

function hfTokenSecretPlan(config) {
    const secret = config.hfTokenSecret || {};
    return {
        tokenSource: firstDefined(secret.tokenSource, config.tokenSource, 'create-secret'),
        secretName: optionalString(firstDefined(secret.secretName, config.secretName)),
        secretNamespace: firstDefined(secret.secretNamespace, config.secretNamespace, ''),
        secretNamespaceMode: firstDefined(secret.secretNamespaceMode, config.secretNamespaceMode, 'existing'),
    };
}

function modelCachePlan(config) {
    const cache = config.modelCache || {};
    return {
        enabled: booleanOrDefault(firstDefined(cache.enabled, config.prewarmEnabled), false),
        entryId: optionalString(firstDefined(cache.entryId, config.entryId)),
        repoId: optionalString(firstDefined(cache.repoId, config.repoId)),
        revision: optionalString(firstDefined(cache.revision, config.revision)),
        storageVolumeRef: optionalString(
            firstDefined(cache.storageVolumeRef, config.storageVolumeRef, config.storageName),
        ),
    };
}

function stackPlan(config) {
    const stack = config.stack || {};
    return {
        routerVersion: optionalString(firstDefined(stack.routerVersion, config.routerVersion)),
        gieVersion: optionalString(firstDefined(stack.gieVersion, config.gieVersion)),
        ippVersion: optionalString(firstDefined(stack.ippVersion, config.ippVersion)),
        lwsVersion: optionalString(firstDefined(stack.lwsVersion, config.lwsVersion)),
        lwsEnabled: booleanOrDefault(firstDefined(stack.lwsEnabled, config.lwsEnabled), false),
        crdsEnabled: booleanOrDefault(firstDefined(stack.crdsEnabled, config.crdsEnabled), false),
        imagePrepullEnabled: booleanOrDefault(
            firstDefined(stack.imagePrepullEnabled, config.imagePrepullEnabled),
            false,
        ),
        images: normalizeList(firstDefined(stack.images, config.images)),
        imagesNamespace: optionalString(firstDefined(stack.imagesNamespace, config.imagesNamespace)),
        imagesNamespaceMode: firstDefined(
            stack.imagesNamespaceMode,
            config.imagesNamespaceMode,
            'create',
        ),
        vllmImage: optionalString(firstDefined(stack.vllmImage, stack.vllm_image, config.vllmImage)),
    };
}

function runtimePlan(config) {
    const runtime = config.runtime || {};
    return {
        inotifyEnabled: booleanOrDefault(
            firstDefined(runtime.inotifyEnabled, config.inotifyEnabled),
            true,
        ),
        inotifyLimit: integerOrDefault(
            firstDefined(runtime.inotifyLimit, config.inotifyLimit, config.inotifyMaxUserInstances),
            8192,
        ),
    };
}

function handoffPlan(config) {
    const handoff = config.handoff || {};
    return {
        namespace: firstDefined(optionalString(handoff.namespace), optionalString(config.handoffNamespace), 'default'),
    };
}

export function monitoringPlan(config = {}) {
    const source = config && typeof config === 'object' ? config : {};
    const monitoring = source.monitoring && typeof source.monitoring === 'object' ? source.monitoring : {};
    return {
        enabled: booleanOrDefault(firstDefined(monitoring.enabled, source.monitoringEnabled), true),
        mode: firstDefined(optionalString(monitoring.mode), optionalString(source.monitoringMode), 'managed'),
        namespace: firstDefined(
            optionalString(monitoring.namespace),
            optionalString(source.monitoringNamespace),
            defaultMonitoringNamespace(source.clusterId),
        ),
        prometheusUrl: optionalString(
            firstDefined(monitoring.prometheusUrl, monitoring.prometheus_url, source.prometheusUrl),
        ),
        grafanaUrl: optionalString(
            firstDefined(monitoring.grafanaUrl, monitoring.grafana_url, source.grafanaUrl),
        ),
        prometheusNodePort: optionalPort(
            firstDefined(
                monitoring.prometheusNodePort,
                monitoring.prometheus_node_port,
                source.prometheusNodePort,
            ),
        ),
        grafanaNodePort: optionalPort(
            firstDefined(
                monitoring.grafanaNodePort,
                monitoring.grafana_node_port,
                source.grafanaNodePort,
            ),
        ),
        host: optionalString(firstDefined(monitoring.host, source.monitoringHost)),
        installAcceleratorExporters: booleanOrDefault(
            firstDefined(
                monitoring.installAcceleratorExporters,
                monitoring.install_accelerator_exporters,
                source.installAcceleratorExporters,
            ),
            true,
        ),
    };
}

function specPlan(config) {
    const spec = config.spec && typeof config.spec === 'object' ? { ...config.spec } : {};
    if (spec.replicas === undefined && config.replicas !== undefined) spec.replicas = config.replicas;
    if (spec.gpuPerReplica === undefined && config.gpuPerReplica !== undefined) {
        spec.gpuPerReplica = config.gpuPerReplica;
    }
    if (spec.resources === undefined && config.resources !== undefined) spec.resources = config.resources;
    return spec;
}

/**
 * Build the backend `ProvisioningPlan` DTO from wizard state.
 *
 * Accepts either grouped `{ gateway, storage, hfTokenSecret, modelCache,
 * stack, runtime, monitoring, spec }` sections or the flat wizard field names
 * (`gatewayProvider`, `storageKind`, `secretNamespace`, `prewarmEnabled`,
 * `inotifyMaxUserInstances`, `monitoringMode`, ...). Only DTO fields are emitted;
 * the backend fills the remaining defaults during normalization.
 */
export function buildPlan(config = {}) {
    return {
        gateway: gatewayPlan(config),
        accelerators: acceleratorPlans(config),
        storage: storagePlan(config),
        hfTokenSecret: hfTokenSecretPlan(config),
        modelCache: modelCachePlan(config),
        stack: stackPlan(config),
        runtime: runtimePlan(config),
        handoff: handoffPlan(config),
        monitoring: monitoringPlan(config),
        spec: specPlan(config),
        planVersion: firstDefined(config.planVersion, PLAN_VERSION),
    };
}

function formatValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function storageSummary(storage) {
    if (!storage || !storage.kind || storage.kind === 'none') return 'No storage volume';
    const detail = storage.kind === 'local-disk'
        ? storage.hostPath
        : storage.kind === 'nfs'
            ? (storage.nfsServer || storage.nfsPath
                ? `${storage.nfsServer || ''}:${storage.nfsPath || ''}`
                : null)
            : storage.storageClass;
    return [storage.kind, storage.capacity, detail].filter(Boolean).join(' · ');
}

function stackSummary(stack) {
    const vllmImage = stack.vllmImage ?? stack.vllm_image;
    const parts = [
        stack.routerVersion ? `router ${stack.routerVersion}` : null,
        stack.gieVersion ? `GIE ${stack.gieVersion}` : null,
        stack.ippVersion ? `IPP ${stack.ippVersion}` : null,
        vllmImage ? `vLLM ${vllmImage}` : null,
        stack.lwsEnabled ? 'LWS' : null,
        stack.crdsEnabled ? 'CRDs' : null,
        stack.imagePrepullEnabled ? 'image prepull' : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'No stack components';
}

function monitoringSummary(monitoring) {
    if (!monitoring || !Object.keys(monitoring).length) return 'Not configured';
    if (monitoring.enabled === false) return 'Disabled';
    const prometheusUrl = monitoring.prometheusUrl ?? monitoring.prometheus_url;
    const grafanaUrl = monitoring.grafanaUrl ?? monitoring.grafana_url;
    const prometheusNodePort = monitoring.prometheusNodePort ?? monitoring.prometheus_node_port;
    const grafanaNodePort = monitoring.grafanaNodePort ?? monitoring.grafana_node_port;
    const host = monitoring.host;
    const installExporters = monitoring.installAcceleratorExporters ?? monitoring.install_accelerator_exporters;
    const parts = [
        monitoring.mode || 'managed',
        monitoring.namespace || MONITORING_NAMESPACE_PREFIX,
        prometheusUrl
            ? `Prometheus ${prometheusUrl}`
            : prometheusNodePort
                ? `Prometheus NodePort ${prometheusNodePort}`
                : null,
        grafanaUrl
            ? `Grafana ${grafanaUrl}`
            : grafanaNodePort
                ? `Grafana NodePort ${grafanaNodePort}`
                : null,
        host ? `host ${host}` : null,
        installExporters === false ? 'exporters off' : null,
    ].filter(Boolean);
    return parts.join(' · ');
}

/**
 * Human-readable review summary of a plan (see the wizard's Review step).
 * Every value is a string so the UI can render it directly.
 */
export function planSummary(plan = {}) {
    const gateway = plan.gateway || {};
    const accelerators = Array.isArray(plan.accelerators) ? plan.accelerators : [];
    const storage = plan.storage || {};
    const cache = plan.modelCache || plan.model_cache || {};
    const stack = plan.stack || {};
    const monitoring = plan.monitoring || {};
    const spec = plan.spec && typeof plan.spec === 'object' ? plan.spec : {};

    return {
        provider: gateway.provider
            ? [
                gateway.provider,
                `${gateway.namespace || 'gateway'}/${gateway.name || 'gateway'}`,
                gateway.port ? `port ${gateway.port}` : null,
            ].filter(Boolean).join(' · ')
            : 'No gateway provider',
        accelerators: accelerators.length
            ? accelerators.map((accelerator) => {
                const name = [accelerator.vendor, accelerator.model].filter(Boolean).join(' ') || 'accelerator';
                return `${name} (${accelerator.mode || 'plugin'})`;
            }).join(', ')
            : 'No accelerators',
        storage: storageSummary(storage),
        modelCache: cache.enabled
            ? `${cache.repoId || 'repository'}@${cache.revision || 'main'} → ${cache.storageVolumeRef || 'storage volume'}`
            : 'Disabled',
        stack: stackSummary(stack),
        monitoring: monitoringSummary(monitoring),
        spec: Object.keys(spec).length
            ? Object.entries(spec).map(([key, value]) => `${key} ${formatValue(value)}`).join(', ')
            : 'No deployment spec',
    };
}
