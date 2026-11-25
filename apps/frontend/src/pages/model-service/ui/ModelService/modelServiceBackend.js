// API client for the model service domain (tokens, visible models, usage).
import { requestJson } from '../../../../shared/api/httpClient';
import { streamSseRequest } from '../../../../shared/api/sse.js';
import { errorMessage } from '../../../../shared/lib/errorMessage';
import { buildHandoffModalState, markClusterStatusSynced, normalizeHandoffMode } from '../../model/modelService';

const base = '/api/v1/model-service';
const tokenPath = (tokenId) => `${base}/tokens/${encodeURIComponent(tokenId)}`;
const jsonHeaders = { 'Content-Type': 'application/json' };

export async function listModelTokens({ signal } = {}) {
    const payload = await requestJson(`${base}/tokens`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Model token list response is invalid');
    return payload.items;
}

export function createModelToken(name) {
    return requestJson(`${base}/tokens`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name }),
    });
}

export function regenerateModelToken(name) {
    return requestJson(`${base}/tokens/regenerate`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name }),
    });
}

export async function revokeModelToken(tokenId) {
    await requestJson(tokenPath(tokenId), { method: 'DELETE' });
}

export async function listModelNames({ signal } = {}) {
    const payload = await requestJson(`${base}/models`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Model list response is invalid');
    return payload.items;
}

export function getModelServiceConnection({ signal } = {}) {
    return requestJson(`${base}/connection`, { signal });
}

export async function listUsageRecords({ limit = 100, signal } = {}) {
    const payload = await requestJson(`${base}/usage/records?limit=${encodeURIComponent(limit)}`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Usage response is invalid');
    return payload.items;
}

export async function listUsageTimeseries({ days = 30, signal } = {}) {
    const payload = await requestJson(`${base}/usage/timeseries?days=${encodeURIComponent(days)}`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Usage timeseries response is invalid');
    return payload.items;
}

// --- admin -------------------------------------------------------------------

const admin = `${base}/admin`;
const accessPath = (groupId) => `${admin}/groups/${encodeURIComponent(groupId)}/access`;

export async function getModelAccess(groupId, { signal } = {}) {
    const [grants, options] = await Promise.all([
        requestJson(accessPath(groupId), { signal }),
        requestJson(`${accessPath(groupId)}/options`, { signal }),
    ]);
    if (!Array.isArray(grants?.items) || !Array.isArray(options?.users) || !Array.isArray(options?.groups)) {
        throw new Error('Model access response is invalid');
    }
    return { grants: grants.items, users: options.users, groups: options.groups };
}

export function grantModelAccess(groupId, { subjectType, subjectId }) {
    return requestJson(accessPath(groupId), {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ subjectType, subjectId }),
    });
}

export function revokeModelAccess(groupId, bindingId) {
    return requestJson(`${accessPath(groupId)}/${encodeURIComponent(bindingId)}`, { method: 'DELETE' });
}

export async function listGroups({ signal } = {}) {
    const payload = await requestJson(`${admin}/groups`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Group list response is invalid');
    return payload.items;
}

export function createGroup(body) {
    return requestJson(`${admin}/groups`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

export function publishModel(body) {
    return requestJson(`${admin}/groups/publish`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

export async function addModel({ name, clusterId, executionId }) {
    const publicName = name.trim();
    const [groups, members] = await Promise.all([listGroups(), listMembers()]);
    if (members.some((member) => member.clusterId === clusterId && member.executionId === executionId)) {
        throw new Error('This deployment has already been added to a model. Select another provider.');
    }
    const group = groups.find((item) => item.clusterId === clusterId && item.name === publicName);
    if (!group) {
        const createdGroup = await publishModel({ name: publicName, clusterId, executionId });
        return {
            group: createdGroup,
            created: true,
            ...(createdGroup?.reconcileStatus !== undefined ? { reconcileStatus: createdGroup.reconcileStatus } : {}),
            ...(createdGroup?.handoff !== undefined ? { handoff: createdGroup.handoff } : {}),
        };
    }
    const providers = members.filter((member) => member.groupId === group.id);
    const weight = 1;
    const result = await updateTrafficDistribution(group.id, {
        expectedWeights: Object.fromEntries(providers.map((member) => [member.executionId, member.weight])),
        members: [
            ...providers.map((member) => ({ executionId: member.executionId, weight: member.weight })),
            { executionId, weight },
        ],
    });
    return {
        group,
        created: false,
        weight,
        operation: result.operation,
        ...(result?.reconcileStatus !== undefined ? { reconcileStatus: result.reconcileStatus } : {}),
        ...(result?.handoff !== undefined ? { handoff: result.handoff } : {}),
    };
}

export function setGroupStatus(groupId, status) {
    return requestJson(`${admin}/groups/${encodeURIComponent(groupId)}/status`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ status }),
    });
}

export function updateGroup(groupId, body) {
    return requestJson(`${admin}/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body),
    });
}

export function deleteGroup(groupId) {
    return requestJson(`${admin}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
}

export async function setProvidersStatus(groupId, status) {
    const payload = await requestJson(`${admin}/groups/${encodeURIComponent(groupId)}/providers/status`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ status }),
    });
    if (!Array.isArray(payload?.items)) throw new Error('Provider status response is invalid; refresh before retrying.');
    const items = payload.items;
    Object.defineProperties(items, {
        reconcileStatus: { value: payload.reconcileStatus ?? null, enumerable: false, configurable: true },
        handoff: { value: payload.handoff ?? null, enumerable: false, configurable: true },
    });
    return items;
}

export async function listMembers(groupId, { signal } = {}) {
    const query = groupId ? `?group_id=${encodeURIComponent(groupId)}` : '';
    const payload = await requestJson(`${admin}/members${query}`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Member list response is invalid');
    return payload.items;
}

export async function listPublishableDeployments({ signal } = {}) {
    const payload = await requestJson(`${admin}/deployments`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Deployments response is invalid');
    return payload.items;
}

export function createMember(body) {
    return requestJson(`${admin}/members`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
}

export function updateMember(memberId, body) {
    return requestJson(`${admin}/members/${encodeURIComponent(memberId)}`, {
        method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body),
    });
}

export async function updateTrafficDistribution(groupId, body) {
    const payload = await requestJson(`${admin}/groups/${encodeURIComponent(groupId)}/traffic`, {
        method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body),
    });
    if (!Array.isArray(payload?.items) || !payload?.operation?.status) {
        throw new Error('Traffic distribution response is invalid; refresh before retrying.');
    }
    return payload;
}

export function deleteMember(memberId) {
    return requestJson(`${admin}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
}

export function getUsageAnalytics({ since, until, interval = 'day', groupBy = 'model', userIds, groupIds, clusterIds, signal } = {}) {
    const params = new URLSearchParams({ interval, group_by: groupBy });
    if (since) params.set('since', since);
    if (until) params.set('until', until);
    (userIds || []).forEach((id) => params.append('user_id', id));
    (groupIds || []).forEach((id) => params.append('group_id', id));
    (clusterIds || []).forEach((id) => params.append('cluster_id', id));
    return requestJson(`${admin}/usage/analytics?${params.toString()}`, { signal });
}

export async function listAllUsage({ groupIds, clusterIds, limit = 100, signal } = {}) {
    const params = new URLSearchParams();
    (groupIds || []).forEach((id) => params.append('group_id', id));
    (clusterIds || []).forEach((id) => params.append('cluster_id', id));
    params.set('limit', String(limit));
    const payload = await requestJson(`${admin}/usage?${params.toString()}`, { signal });
    if (!Array.isArray(payload?.items)) throw new Error('Admin usage response is invalid');
    return payload.items;
}

// --- gateway operations ------------------------------------------------------

const gateway = `${admin}/gateway`;

export function getGatewayStatus({ signal } = {}) {
    return requestJson(`${gateway}/status`, { signal });
}

export function probeGateway() {
    return requestJson(`${gateway}/probe`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({}) });
}

export function preflightCluster(clusterId) {
    return requestJson(`${gateway}/preflight`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ clusterId }),
    });
}

// Install (or reuse) the cluster's shared Gateway using the user-selected provider.
export function installGateway(clusterId, provider) {
    return requestJson(`${gateway}/install`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ clusterId, provider }),
    });
}

// Read a cluster's live Inference Payload Processor config (from its ConfigMap).
export function getGatewayIppConfig(clusterId) {
    const query = new URLSearchParams({ clusterId });
    return requestJson(`${gateway}/ipp-config?${query.toString()}`);
}

// Save a cluster's Inference Payload Processor config (PayloadProcessorConfig body).
export function setGatewayIppConfig(clusterId, config) {
    return requestJson(`${gateway}/ipp-config`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ clusterId, config }),
    });
}

// Start/stop a data-plane component Deployment (Gateway data plane / EPP / model server).
export function scaleComponent({ clusterId, namespace, name, replicas, kind = 'deployment' }) {
    return requestJson(`${gateway}/scale`, {
        method: 'POST', headers: jsonHeaders, body: JSON.stringify({ clusterId, namespace, name, replicas, kind }),
    });
}

// Run any data-plane operation and stream its log lines (SSE `log`/`complete`/`error`).
export function reconcileGateway(payload, onEvent, signal) {
    return streamSseRequest(`${gateway}/reconcile/stream`, { clusterId: payload.clusterId }, onEvent, signal);
}

export function streamGatewayOperation(payload, onEvent, signal) {
    return streamSseRequest(`${gateway}/stream`, payload, onEvent, signal);
}

export function streamComponentLogs(payload, onEvent, signal) {
    return streamSseRequest(`${gateway}/logs`, payload, onEvent, signal);
}

// Read current Non-Admin Orchestration administrator remediation script and pending operation summary.
export function getGatewayRemediation(clusterId, { mode, markerNamespace, signal } = {}) {
    const params = new URLSearchParams({ clusterId });
    if (mode) params.set('mode', mode);
    if (markerNamespace) params.set('markerNamespace', markerNamespace);
    return requestJson(`${gateway}/remediation?${params.toString()}`, { signal });
}

// Generate and persist an idempotent Orchestration administrator script for Non-Admin handoff.
export function generateGatewayRemediation(body) {
    return requestJson(`${gateway}/remediation`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
    });
}

export function clusterHandoffMode(cluster) {
    return normalizeHandoffMode(cluster?.handoffMode || cluster?.mode || 'routes');
}

export function componentHandoffAction(action) {
    if (action === 'handoff-routes') return { mode: 'routes', persist: false };
    if (action === 'handoff-repair') return { mode: 'gateway_repair', persist: false };
    if (action === 'handoff-ipp') return { mode: 'ipp_config', persist: false };
    return null;
}

export function fetchClusterHandoff(cluster, mode = clusterHandoffMode(cluster), { persist = false } = {}) {
    const normalizedMode = normalizeHandoffMode(mode);
    return persist
        ? generateGatewayRemediation({ clusterId: cluster.clusterId, mode: normalizedMode })
        : getGatewayRemediation(cluster.clusterId, { mode: normalizedMode });
}

// Verify whether an Orchestration administrator script handoff has completed on the cluster.
export function verifyGatewayRemediation(body = {}) {
    const payload = { ...body };
    if (!payload.mode) {
        delete payload.mode;
    }
    return requestJson(`${gateway}/remediation/verify`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
    });
}

export async function applyMutationHandoffResult(result, { clusterId = '', clusters = [], setHandoffModal, setStatus } = {}) {
    const resolvedId = result?.handoff?.clusterId || result?.clusterId || clusterId;
    if (result?.reconcileStatus === 'admin_handoff_required') {
        if (result.handoff) {
            setHandoffModal?.(buildHandoffModalState(result.handoff, { clusterId: resolvedId, clusters }));
            return 'admin_handoff_required';
        }
        if (resolvedId) {
            try {
                const freshHandoff = await getGatewayRemediation(resolvedId, {
                    mode: clusterHandoffMode(result),
                });
                setHandoffModal?.(buildHandoffModalState(freshHandoff, { clusterId: resolvedId, clusters }));
            } catch {
                // Cluster status refresh still surfaces the pending banner if script fetch fails.
            }
            return 'admin_handoff_required';
        }
    }
    if (resolvedId) {
        setHandoffModal?.((current) => (
            current && current.handoff?.clusterId === resolvedId ? null : current
        ));
        setStatus?.((current) => markClusterStatusSynced(current, resolvedId));
    }
    return 'synced';
}

export async function performHandoffRecheck({
    handoffModal,
    setHandoffModal,
    setStatus,
    setNotice,
    load,
}) {
    const currentHandoff = handoffModal?.handoff;
    const clusterId = currentHandoff?.clusterId;
    if (!clusterId || handoffModal?.busy || handoffModal?.refreshing) return null;
    setHandoffModal((current) => (current ? { ...current, busy: true, error: '' } : current));
    try {
        const mode = currentHandoff.mode ? normalizeHandoffMode(currentHandoff.mode) : undefined;
        const verifyResult = await verifyGatewayRemediation({
            clusterId,
            expectedHash: currentHandoff.desiredHash || undefined,
            markerNamespace: currentHandoff.markerNamespace || undefined,
            mode,
        });
        if (verifyResult.verified) {
            setHandoffModal((current) => (
                current && current.handoff?.clusterId === clusterId
                    ? {
                        ...current,
                        busy: false,
                        refreshing: false,
                        error: '',
                        verifyResult,
                        handoff: {
                            ...current.handoff,
                            reconcileStatus: verifyResult.reconcileStatus || 'synced',
                            pendingOperations: [],
                            ...(verifyResult.desiredHash ? { desiredHash: verifyResult.desiredHash } : {}),
                            ...(verifyResult.markerNamespace ? { markerNamespace: verifyResult.markerNamespace } : {}),
                            ...(verifyResult.markerName ? { markerName: verifyResult.markerName } : {}),
                        },
                    }
                    : current
            ));
            if ((verifyResult.reconcileStatus || 'synced') === 'synced') {
                setStatus?.((current) => markClusterStatusSynced(current, clusterId));
            }
            setNotice?.('Orchestration administrator route sync verified.');
            await load?.({ quiet: true });
            return verifyResult;
        }

        const needsScriptRefresh = verifyResult.markerStatus === 'stale'
            || Boolean(verifyResult.desiredHash && verifyResult.desiredHash !== currentHandoff.desiredHash);
        if (needsScriptRefresh) {
            try {
                const freshHandoff = await getGatewayRemediation(clusterId, {
                    mode: normalizeHandoffMode(currentHandoff.mode),
                });
                setHandoffModal((current) => (
                    current && current.handoff?.clusterId === clusterId
                        ? {
                            ...current,
                            busy: false,
                            refreshing: false,
                            error: '',
                            verifyResult,
                            handoff: { ...current.handoff, ...freshHandoff, clusterId },
                        }
                        : current
                ));
            } catch (refreshFailure) {
                setHandoffModal((current) => (
                    current && current.handoff?.clusterId === clusterId
                        ? {
                            ...current,
                            busy: false,
                            refreshing: false,
                            verifyResult,
                            error: errorMessage(refreshFailure, 'Failed to refresh Orchestration administrator script'),
                        }
                        : current
                ));
            }
            await load?.({ quiet: true });
            return verifyResult;
        }

        setHandoffModal((current) => (
            current && current.handoff?.clusterId === clusterId
                ? { ...current, busy: false, refreshing: false, error: '', verifyResult }
                : current
        ));
        return verifyResult;
    } catch (failure) {
        setHandoffModal((current) => (
            current && current.handoff?.clusterId === clusterId
                ? { ...current, busy: false, refreshing: false, error: errorMessage(failure, 'Failed to verify Orchestration administrator handoff') }
                : current
        ));
        return null;
    }
}

export async function performHandoffScriptRefresh({ handoffModal, setHandoffModal, setStatus }) {
    const currentHandoff = handoffModal?.handoff;
    const clusterId = currentHandoff?.clusterId;
    if (!clusterId || handoffModal?.busy || handoffModal?.refreshing) return null;
    setHandoffModal((current) => (current ? { ...current, refreshing: true, error: '' } : current));
    try {
        const freshHandoff = await getGatewayRemediation(clusterId, {
            mode: normalizeHandoffMode(currentHandoff.mode),
        });
        const hasPendingOps = Array.isArray(freshHandoff?.pendingOperations) && freshHandoff.pendingOperations.length > 0;
        const isSynced = freshHandoff?.reconcileStatus === 'synced' && !hasPendingOps;
        setHandoffModal((current) => (
            current && current.handoff?.clusterId === clusterId
                ? {
                    ...current,
                    busy: false,
                    refreshing: false,
                    error: '',
                    verifyResult: null,
                    handoff: {
                        ...current.handoff,
                        ...freshHandoff,
                        ...(isSynced ? { pendingOperations: [] } : {}),
                        clusterId,
                    },
                }
                : current
        ));
        if (isSynced) {
            setStatus?.((current) => markClusterStatusSynced(current, clusterId));
        }
        return freshHandoff;
    } catch (failure) {
        setHandoffModal((current) => (
            current && current.handoff?.clusterId === clusterId
                ? {
                    ...current,
                    busy: false,
                    refreshing: false,
                    error: errorMessage(failure, 'Failed to refresh Orchestration administrator script'),
                }
                : current
        ));
        return null;
    }
}

export async function performClusterBannerRecheck(cluster, {
    bannerRecheckingId,
    setBannerRecheckingId,
    setHandoffModal,
    setStatus,
    setNotice,
    setError,
    load,
}) {
    if (!cluster?.clusterId || bannerRecheckingId) return null;
    const clusterId = cluster.clusterId;
    const clusterLabel = cluster.clusterName || clusterId;
    const explicitMode = cluster.handoffMode || cluster.mode;
    const mode = clusterHandoffMode(cluster);
    setBannerRecheckingId(clusterId);
    try {
        const verifyResult = await verifyGatewayRemediation({
            clusterId,
            markerNamespace: cluster.handoffNamespace || undefined,
            mode: explicitMode ? mode : undefined,
        });
        if (verifyResult.verified) {
            setHandoffModal?.((current) => (
                current && current.handoff?.clusterId === clusterId ? null : current
            ));
            if ((verifyResult.reconcileStatus || 'synced') === 'synced') {
                setStatus?.((current) => markClusterStatusSynced(current, clusterId));
            }
            setNotice?.(`Orchestration administrator route sync verified for ${clusterLabel}.`);
            await load?.({ quiet: true });
            return verifyResult;
        }
        try {
            const handoff = await getGatewayRemediation(clusterId, { mode });
            setHandoffModal(buildHandoffModalState(handoff, {
                clusterId,
                clusters: [{ clusterId, clusterName: clusterLabel }],
                verifyResult,
            }));
        } catch (refreshFailure) {
            if (mode !== 'routes') {
                const fallbackHandoff = await getGatewayRemediation(clusterId, { mode: 'routes' });
                setHandoffModal(buildHandoffModalState(fallbackHandoff, {
                    clusterId,
                    clusters: [{ clusterId, clusterName: clusterLabel }],
                    verifyResult,
                }));
            } else {
                throw refreshFailure;
            }
        }
        await load?.({ quiet: true });
        return verifyResult;
    } catch (failure) {
        setError?.(errorMessage(failure, 'Failed to verify Orchestration administrator handoff'));
        return null;
    } finally {
        setBannerRecheckingId('');
    }
}
