// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0

const BASE_PATH = '/api/v1/monitoring/cluster-stack';

import { requestMonitoringJson as requestJson } from '../../../../shared/api/monitoringClient';


function clusterQuery(namespace, clusterId) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (clusterId) query.set('cluster_id', clusterId);
    return query.toString();
}

export function getClusterStackStatus(namespace, { signal, clusterId } = {}) {
    const qs = clusterQuery(namespace, clusterId);
    return requestJson(`${BASE_PATH}/status${qs ? `?${qs}` : ''}`, { signal });
}

export function preflightClusterStackInstall(request, { signal, clusterId } = {}) {
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    return requestJson(`${BASE_PATH}/installations/preflight${query}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
}

export function installClusterStack(request, idempotencyKey, clusterId) {
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    return requestJson(`${BASE_PATH}/installations${query}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(request),
    });
}

export function getClusterStackOperation(operationId, { signal } = {}) {
    return requestJson(`${BASE_PATH}/operations/${encodeURIComponent(operationId)}`, { signal });
}

export function getClusterStackLinks(namespace, { signal, clusterId } = {}) {
    const qs = clusterQuery(namespace, clusterId);
    return requestJson(`${BASE_PATH}/links${qs ? `?${qs}` : ''}`, { signal });
}

export function getClusterStackAdminScript({ namespace, mode, includeAccelerators, clusterId, signal } = {}) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (mode) query.set('mode', mode);
    if (includeAccelerators !== undefined) query.set('include_accelerators', String(Boolean(includeAccelerators)));
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(`${BASE_PATH}/admin-script${qs ? `?${qs}` : ''}`, { signal });
}

export function recheckClusterStack(namespace, { clusterId } = {}) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(`${BASE_PATH}/recheck${qs ? `?${qs}` : ''}`, { method: 'POST' });
}

export function updateClusterMonitoringEndpoints(clusterId, payload) {
    return requestJson(`/api/cluster/clusters/${encodeURIComponent(clusterId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export function getDeploymentFlowMap(executionId, { signal, clusterId, monitoringNamespace } = {}) {
    const query = new URLSearchParams({ execution_id: executionId });
    if (clusterId) query.set('cluster_id', clusterId);
    if (monitoringNamespace) query.set('monitoring_namespace', monitoringNamespace);
    return requestJson(`/api/v1/monitoring/profiling/flow-map?${query.toString()}`, { signal });
}

export function getClusterDeploymentMonitoring(clusterId, { signal } = {}) {
    return requestJson(
        `/api/v1/monitoring/deployments?cluster_id=${encodeURIComponent(clusterId)}`,
        { signal },
    );
}

export function getDeploymentMonitoring(executionId, { signal, clusterId } = {}) {
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    return requestJson(
        `/api/v1/monitoring/deployments/${encodeURIComponent(executionId)}${query}`,
        { signal },
    );
}

export function manageDeploymentMonitoring(executionId, action, { clusterId } = {}) {
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    return requestJson(
        `/api/v1/monitoring/deployments/${encodeURIComponent(executionId)}/${encodeURIComponent(action)}${query}`,
        { method: 'POST' },
    );
}
