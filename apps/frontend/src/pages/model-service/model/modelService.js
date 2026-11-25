export const MAX_TRAFFIC_WEIGHT = 1_000_000;

export function availableModelProviders(deployments, members, clusterId) {
    const published = new Set(
        members.filter((member) => member.clusterId === clusterId).map((member) => member.executionId),
    );
    return deployments.filter((deployment) => (
        deployment.clusterId === clusterId && deployment.status === 'ready'
        && deployment.endpointKind === 'llm-d-epp'
        && !published.has(deployment.executionId)
    ));
}

export function filterServiceFlow(clusters, memberGroups, { clusterId = '', modelQuery = '', status = '' } = {}) {
    const query = modelQuery.trim().toLowerCase();
    const selectedClusters = clusters.filter((cluster) => !clusterId || cluster.clusterId === clusterId);
    const selectedIds = new Set(selectedClusters.map((cluster) => cluster.clusterId));
    const groups = memberGroups
        .filter((group) => (!status || group.status === status) && group.name.toLowerCase().includes(query))
        .map((group) => ({
            ...group,
            clusters: group.clusters.filter((cluster) => selectedIds.has(cluster.clusterId)),
        }))
        .filter((group) => group.clusters.length > 0);
    const matchingIds = new Set(groups.flatMap((group) => group.clusters.map((cluster) => cluster.clusterId)));
    return {
        clusters: (query || status)
            ? selectedClusters.filter((cluster) => matchingIds.has(cluster.clusterId))
            : selectedClusters,
        memberGroups: groups,
    };
}

export function memberIsRoutable(member) {
    if (!member || member.status === 'disabled' || Number(member.weight) <= 0) return false;
    if (member.endpointKind && member.endpointKind !== 'llm-d-epp') return false;
    const components = member.components || {};
    return !['epp', 'inferencePool', 'modelServer'].some((key) => components[key] === 'missing');
}

export function routedTrafficTotal(members) {
    if (!Array.isArray(members)) return 0;
    return members.reduce((sum, member) => (
        memberIsRoutable(member) ? sum + Number(member.weight || 0) : sum
    ), 0);
}

export function effectiveTrafficShare(member, total) {
    if (!memberIsRoutable(member) || !total) return '0%';
    const weight = Number(member.weight || 0);
    const share = weight / total * 100;
    return share < 0.01 ? '<0.01%' : `${Number(share.toFixed(2))}%`;
}

export function parseTrafficWeight(value) {
    if (!/^\d+$/.test(String(value))) return null;
    const weight = Number(value);
    return Number.isInteger(weight) && weight >= 0 && weight <= MAX_TRAFFIC_WEIGHT ? weight : null;
}

export function trafficDistributionError(rows) {
    if (!rows.length || rows.length > 16) return 'Choose between 1 and 16 deployment providers.';
    if (new Set(rows.map((row) => row.executionId)).size !== rows.length) return 'Each deployment can be added only once.';
    if (rows.some((row) => parseTrafficWeight(row.weight) === null)) return 'Weights must be whole numbers from 0 to 1000000.';
    if (!rows.some((row) => row.status !== 'disabled' && parseTrafficWeight(row.weight) > 0)) {
        return 'At least one enabled deployment must have a positive weight.';
    }
    return '';
}

export function trafficTotal(rows) {
    if (rows.some((row) => parseTrafficWeight(row.weight) === null)) return null;
    return rows.reduce((sum, row) => sum + (row.status === 'disabled' ? 0 : parseTrafficWeight(row.weight)), 0);
}

export function trafficShare(row, total) {
    const weight = parseTrafficWeight(row.weight);
    if (weight === null || total === null) return 'Unknown';
    if (row.status === 'disabled' || total === 0 || weight === 0) return '0%';
    const percent = weight / total * 100;
    return percent < 0.01 ? '<0.01%' : `${Number(percent.toFixed(2))}%`;
}

const HANDOFF_MODES = new Set(['routes', 'gateway_repair', 'ipp_config', 'all']);

export function normalizeHandoffMode(mode) {
    return HANDOFF_MODES.has(mode) ? mode : 'routes';
}

export function buildHandoffModalState(handoff, { clusterId = '', clusters = [], verifyResult = null, error = '' } = {}) {
    if (!handoff) return null;
    const resolvedId = handoff.clusterId || clusterId;
    const normalizedHandoff = resolvedId && !handoff.clusterId ? { ...handoff, clusterId: resolvedId } : handoff;
    const clusterName = clusters.find((cluster) => cluster.clusterId === resolvedId)?.clusterName || resolvedId;
    return {
        handoff: normalizedHandoff,
        clusterName,
        verifyResult,
        busy: false,
        refreshing: false,
        error,
    };
}

export function markClusterStatusSynced(currentStatus, clusterId) {
    if (!currentStatus || !clusterId) return currentStatus;
    return {
        ...currentStatus,
        clusters: (currentStatus.clusters || []).map((item) => (
            item.clusterId === clusterId
                ? { ...item, reconcileStatus: 'synced', pendingOperationsCount: 0 }
                : item
        )),
    };
}

const UNSAFE_SCHEME_NAMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'mailto', 'tel', 'ftp', 'ws', 'wss']);

function hasControlOrWhitespace(value) {
    if (/\s/.test(value)) return true;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function stripControlChars(value) {
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code > 0x1f && code !== 0x7f) result += value[index];
    }
    return result;
}

function isBareIpv6(host) {
    return !host.startsWith('[') && !host.includes('/') && (host.match(/:/g)?.length ?? 0) >= 2;
}

function isHostWithPort(value) {
    return /^[^/:@]+:\d+(?:\/|$)/.test(value) || /^\[[^\]]+\]:\d+(?:\/|$)/.test(value);
}

function hasUnsafeSchemeOrCredentials(value) {
    if (!value || hasControlOrWhitespace(value)) return true;
    if (value.includes('@') || value.includes('\\')) return true;
    if (/^https?:\/\//i.test(value)) return false;
    const schemeMatch = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) return false;
    if (isBareIpv6(value)) return false;
    const scheme = schemeMatch[1].toLowerCase();
    if (UNSAFE_SCHEME_NAMES.has(scheme)) return true;
    return !isHostWithPort(value);
}

export function sanitizeHttpUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || hasControlOrWhitespace(trimmed)) return '';
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        if (parsed.username || parsed.password) return '';
        return trimmed;
    } catch {
        return '';
    }
}

function validPortNumber(port) {
    if (port === null || port === undefined || port === '' || typeof port === 'boolean') return null;
    const numeric = Number(port);
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535 ? numeric : null;
}

function formatHostPort(host, port) {
    const trimmed = String(host || '').trim();
    if (!trimmed || hasUnsafeSchemeOrCredentials(trimmed)) return '';
    const hasPort = /^[^/:]+:\d+$/.test(trimmed) || /^\[[^\]]+\]:\d+$/.test(trimmed);
    if (hasPort) return trimmed;
    const normalized = isBareIpv6(trimmed) ? `[${trimmed}]` : trimmed;
    const validPort = validPortNumber(port);
    return validPort ? `${normalized}:${validPort}` : normalized;
}

export function gatewayAddressLabel(cluster) {
    if (!cluster) return '';
    const port = cluster.gatewayPort ?? cluster.port ?? null;
    const publicUrl = String(cluster.gatewayPublicUrl ?? cluster.publicUrl ?? '').trim();
    if (publicUrl) {
        if (hasUnsafeSchemeOrCredentials(publicUrl)) return '';
        if (/^https?:\/\//i.test(publicUrl)) {
            const validated = sanitizeHttpUrl(publicUrl);
            return validated ? validated.replace(/\/+$/, '') : '';
        }
        if (publicUrl.includes('/')) {
            const validated = sanitizeHttpUrl(`http://${publicUrl}`);
            return validated ? publicUrl.replace(/\/+$/, '') : '';
        }
        return formatHostPort(publicUrl, port);
    }
    const address = String(cluster.gatewayAddress ?? cluster.address ?? '').trim();
    const nodeAddress = String(cluster.gatewayNodeAddress ?? cluster.nodeAddress ?? '').trim();
    if (port) {
        const host = nodeAddress || address;
        return host ? formatHostPort(host, port) : `Port ${port}`;
    }
    if (address) {
        if (hasUnsafeSchemeOrCredentials(address)) return '';
        if (/^https?:\/\//i.test(address)) {
            const validated = sanitizeHttpUrl(address);
            return validated ? validated.replace(/\/+$/, '') : '';
        }
        return isBareIpv6(address) ? `[${address}]` : address;
    }
    if (nodeAddress) {
        if (hasUnsafeSchemeOrCredentials(nodeAddress)) return '';
        return isBareIpv6(nodeAddress) ? `[${nodeAddress}]` : nodeAddress;
    }
    return '';
}

function appendV1Path(url) {
    if (!url) return '';
    const stripped = url.replace(/\/+$/, '');
    const candidate = stripped.endsWith('/v1') ? stripped : `${stripped}/v1`;
    return sanitizeHttpUrl(candidate);
}

export function connectionEndpointUrl(cluster) {
    if (!cluster) return '';
    const direct = String(cluster.baseUrl || '').trim();
    if (direct) return sanitizeHttpUrl(direct);
    const publicUrl = String(cluster.publicUrl ?? cluster.gatewayPublicUrl ?? '').trim();
    const port = cluster.port ?? cluster.gatewayPort ?? null;
    if (publicUrl) {
        if (hasUnsafeSchemeOrCredentials(publicUrl)) return '';
        if (/^https?:\/\//i.test(publicUrl)) return appendV1Path(publicUrl);
        if (publicUrl.includes('/')) return appendV1Path(`http://${publicUrl}`);
        const hostPort = formatHostPort(publicUrl, port);
        return hostPort ? appendV1Path(`http://${hostPort}`) : '';
    }
    const address = String(cluster.address ?? cluster.gatewayAddress ?? '').trim();
    const nodeAddress = String(cluster.nodeAddress ?? cluster.gatewayNodeAddress ?? '').trim();
    if (port) {
        const host = nodeAddress || address;
        const hostPort = host ? formatHostPort(host, port) : '';
        return hostPort ? sanitizeHttpUrl(`http://${hostPort}/v1`) : '';
    }
    if (address) {
        if (hasUnsafeSchemeOrCredentials(address)) return '';
        if (/^https?:\/\//i.test(address)) return appendV1Path(address);
        const formatted = isBareIpv6(address) ? `[${address}]` : address;
        return appendV1Path(`http://${formatted}`);
    }
    return '';
}

export function connectionAddressLabel(cluster) {
    if (!cluster) return '';
    const direct = String(cluster.address ?? cluster.gatewayAddress ?? cluster.nodeAddress ?? cluster.gatewayNodeAddress ?? '').trim();
    if (direct) {
        if (hasUnsafeSchemeOrCredentials(direct)) return '';
        if (/^https?:\/\//i.test(direct)) {
            const validated = sanitizeHttpUrl(direct);
            if (!validated) return '';
            try {
                return new URL(validated).hostname || '';
            } catch {
                return '';
            }
        }
        return direct;
    }
    const base = sanitizeHttpUrl(cluster.baseUrl) || connectionEndpointUrl(cluster);
    if (!base) return '';
    try {
        return new URL(base).hostname || '';
    } catch {
        return '';
    }
}

export function posixSingleQuote(value) {
    return `'${String(value ?? '').replace(/'/g, "'\\''")}'`;
}

export function buildModelCurlSamples({ baseUrl, model, autoInjectsBaseModel = false } = {}) {
    if (!model) return [];
    const safeBase = sanitizeHttpUrl(baseUrl).replace(/\/+$/, '');
    const endpoint = (path) => posixSingleQuote(`${safeBase}${path}`);
    const baseModelValue = stripControlChars(String(model.baseModel || model.modelRef || model.name || ''));
    const baseModelHeaderLine = autoInjectsBaseModel
        ? ''
        : ` \\\n  -H ${posixSingleQuote(`X-Gateway-Base-Model-Name: ${baseModelValue}`)}`;
    const modelName = String(model.name || '');
    return [
        {
            label: 'OpenAI · chat completions',
            command: `curl ${endpoint('/chat/completions')} \\\n  -H 'Authorization: Bearer lens-mk-...'${baseModelHeaderLine} \\\n  -H 'Content-Type: application/json' \\\n  -d ${posixSingleQuote(JSON.stringify({ model: modelName, messages: [{ role: 'user', content: 'Hello' }], stream: true, stream_options: { include_usage: true } }))}`,
        },
        {
            label: 'OpenAI · embeddings',
            command: `curl ${endpoint('/embeddings')} \\\n  -H 'Authorization: Bearer lens-mk-...'${baseModelHeaderLine} \\\n  -H 'Content-Type: application/json' \\\n  -d ${posixSingleQuote(JSON.stringify({ model: modelName, input: 'Hello' }))}`,
        },
        {
            label: 'Anthropic · messages (requires Anthropic support)',
            command: `curl ${endpoint('/messages')} \\\n  -H 'x-api-key: lens-mk-...' \\\n  -H 'anthropic-version: 2023-06-01'${baseModelHeaderLine} \\\n  -H 'content-type: application/json' \\\n  -d ${posixSingleQuote(JSON.stringify({ model: modelName, max_tokens: 1024, messages: [{ role: 'user', content: 'Hello' }] }))}`,
        },
    ];
}
