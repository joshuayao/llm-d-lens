export const DEFAULT_MONITORING_NAMESPACE = 'llm-d-monitoring';

export function normalizeMonitoringNamespace(value, fallback = DEFAULT_MONITORING_NAMESPACE) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || fallback;
}

export function resolveClusterMonitoringNamespace(cluster, fallback = DEFAULT_MONITORING_NAMESPACE) {
    const configured = cluster?.monitoringNamespace ?? cluster?.monitoring_namespace;
    return normalizeMonitoringNamespace(configured, fallback);
}

export function resolveEffectiveMonitoringNamespace({
    clusterId,
    selectedCluster,
    namespaceOverride,
    fallback = DEFAULT_MONITORING_NAMESPACE,
} = {}) {
    const clusterDefaultNamespace = resolveClusterMonitoringNamespace(selectedCluster, fallback);
    const overrideValue = Boolean(clusterId) && namespaceOverride?.clusterId === clusterId
        ? normalizeMonitoringNamespace(namespaceOverride.value, '')
        : '';
    return overrideValue || clusterDefaultNamespace;
}

export function resolveMonitoringNamespaceOverride({
    clusterId,
    inputValue,
    selectedCluster,
    fallback = DEFAULT_MONITORING_NAMESPACE,
} = {}) {
    if (!clusterId) return null;
    const clusterDefaultNamespace = resolveClusterMonitoringNamespace(selectedCluster, fallback);
    const nextValue = normalizeMonitoringNamespace(inputValue, '');
    if (!nextValue || nextValue === clusterDefaultNamespace) {
        return null;
    }
    return { clusterId, value: nextValue };
}

function validateHttpUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Dashboard URL is invalid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported dashboard URL scheme: ${parsed.protocol}`);
    }
    return parsed;
}

function splitPathAndSearch(part) {
    if (!part) return { path: '', search: '' };
    const text = String(part);
    const queryIndex = text.indexOf('?');
    if (queryIndex === -1) {
        return { path: text, search: '' };
    }
    return {
        path: text.slice(0, queryIndex),
        search: text.slice(queryIndex + 1),
    };
}

function normalizePath(path) {
    return String(path || '').replace(/^\/+|\/+$/g, '');
}

function mergeQueryParams(baseSearch, extraSearches, queryParams) {
    const params = new URLSearchParams(baseSearch || '');
    for (const search of extraSearches) {
        if (!search) continue;
        const extra = new URLSearchParams(search);
        for (const [key, value] of extra.entries()) {
            params.set(key, value);
        }
    }
    if (queryParams && typeof queryParams === 'object') {
        for (const [key, value] of Object.entries(queryParams)) {
            if (value !== undefined && value !== null && value !== '') {
                params.set(key, String(value));
            }
        }
    }
    return params.toString();
}

export function monitoringLinkTarget(
    payload,
    kind,
    hostname,
    { pathSuffix = '', fallbackPath = '', queryParams = null } = {},
) {
    const link = (payload?.links || []).find((entry) => entry.kind === kind);
    if (!link?.available) {
        throw new Error(link?.message || `${kind} dashboard is not available`);
    }

    const dashSpec = splitPathAndSearch(link.dashboard_path || fallbackPath || '');
    const suffixSpec = splitPathAndSearch(pathSuffix);
    const dashNorm = normalizePath(dashSpec.path);
    const suffixNorm = normalizePath(suffixSpec.path);

    const rawUrl = typeof link.url === 'string' ? link.url.trim() : '';
    if (rawUrl) {
        const parsed = validateHttpUrl(rawUrl);
        const baseNorm = normalizePath(parsed.pathname);
        const segments = [];
        if (baseNorm) segments.push(baseNorm);
        if (dashNorm && baseNorm !== dashNorm && !baseNorm.endsWith(`/${dashNorm}`)) {
            segments.push(dashNorm);
        }
        if (suffixNorm) segments.push(suffixNorm);

        parsed.pathname = segments.length ? `/${segments.join('/')}` : '/';
        const mergedSearch = mergeQueryParams(
            parsed.search,
            [dashSpec.search, suffixSpec.search],
            queryParams,
        );
        parsed.search = mergedSearch ? `?${mergedSearch}` : '';
        return parsed.toString();
    }

    if (!Number.isInteger(link.local_port) || link.local_port < 1 || link.local_port > 65535) {
        throw new Error(link?.message || `${kind} dashboard is not available`);
    }

    const segments = [dashNorm, suffixNorm].filter(Boolean);
    const pathPart = segments.length ? `/${segments.join('/')}` : '';
    const mergedSearch = mergeQueryParams('', [dashSpec.search, suffixSpec.search], queryParams);
    const queryPart = mergedSearch ? `?${mergedSearch}` : '';
    return `http://${hostname}:${link.local_port}${pathPart}${queryPart}`;
}

export function openMonitoringLink(payload, kind, options) {
    window.open(
        monitoringLinkTarget(payload, kind, window.location.hostname, options),
        '_blank',
        'noopener,noreferrer',
    );
}
