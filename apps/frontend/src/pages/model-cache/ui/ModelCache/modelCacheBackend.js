// API client for the Model Cache module (GET/POST/DELETE /api/v1/model-cache/...).
// Mirrors the fetch/error-handling conventions used by storageManagementBackend.js.

import {
    executionHeaders,
    executionToken,
    requestJson,
    requestJsonWithMeta,
} from '../../../../shared/api/httpClient';

export async function listModelCacheEntries({ clusterId, storageVolumeId, signal } = {}) {
    const params = new URLSearchParams();
    if (clusterId) params.set('cluster_id', clusterId);
    if (storageVolumeId) params.set('storage_volume_id', storageVolumeId);
    const suffix = params.size ? `?${params.toString()}` : '';
    const payload = await requestJson(`/api/v1/model-cache/entries${suffix}`, { signal });
    if (!Array.isArray(payload.items)) throw new Error('Model cache entry list response is invalid');
    return payload.items;
}

export async function getModelCacheEntry(entryId, { signal } = {}) {
    const payload = await requestJson(`/api/v1/model-cache/entries/${encodeURIComponent(entryId)}`, { signal });
    return payload;
}

export async function createModelCacheEntry(payload, execution) {
    const url = '/api/v1/model-cache/entries';
    const request = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
    if (execution === undefined) return requestJson(url, request);
    const { body, response } = await requestJsonWithMeta(url, {
        ...request,
        headers: executionHeaders(execution, request.headers),
    });
    return { body, token: executionToken(response) };
}

export async function retryModelCacheEntry(entryId) {
    const body = await requestJson(`/api/v1/model-cache/entries/${encodeURIComponent(entryId)}/retry`, { method: 'POST' });
    return body;
}

// Syncs a single entry's hostPath download onto any cluster nodes that were
// added after the entry became ready (see `pendingSyncNodes` on the entry).
export async function syncModelCacheEntryNodes(entryId) {
    const body = await requestJson(`/api/v1/model-cache/entries/${encodeURIComponent(entryId)}/sync-nodes`, {
        method: 'POST',
    });
    return body;
}

// Bulk "fix all" action: syncs every entry (optionally scoped to a cluster)
// that has nodes pending sync. Returns the entries that were changed.
export async function syncAllModelCacheEntryNodes({ clusterId } = {}) {
    const params = new URLSearchParams();
    if (clusterId) params.set('cluster_id', clusterId);
    const suffix = params.size ? `?${params.toString()}` : '';
    const body = await requestJson(`/api/v1/model-cache/entries/sync-nodes${suffix}`, { method: 'POST' });
    if (!Array.isArray(body.items)) throw new Error('Model cache sync-nodes response is invalid');
    return body.items;
}

export async function deleteModelCacheEntry(entryId) {
    const body = await requestJson(`/api/v1/model-cache/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
    return body;
}

export async function getModelCacheEntryLogs(entryId, { node, signal } = {}) {
    const params = new URLSearchParams();
    if (node) params.set('node', node);
    const suffix = params.size ? `?${params.toString()}` : '';
    const payload = await requestJson(`/api/v1/model-cache/entries/${encodeURIComponent(entryId)}/logs${suffix}`, { signal });
    return payload.logs || '';
}

export async function searchHuggingFaceModels(query, { limit = 20, signal } = {}) {
    const params = new URLSearchParams({ query: query || '', limit: String(limit) });
    const payload = await requestJson(`/api/v1/model-cache/huggingface/search?${params.toString()}`, { signal });
    if (!Array.isArray(payload.items)) throw new Error('HuggingFace search response is invalid');
    return payload.items;
}

export async function getHuggingFaceModelDetail(repoId, { signal } = {}) {
    const encodedRepoId = String(repoId || '').split('/').map(encodeURIComponent).join('/');
    const payload = await requestJson(`/api/v1/model-cache/huggingface/models/${encodedRepoId}`, { signal });
    return payload;
}
