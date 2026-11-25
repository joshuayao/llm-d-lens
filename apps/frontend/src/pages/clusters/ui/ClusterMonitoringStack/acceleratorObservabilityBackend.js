// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0

const BASE_PATH = '/api/v1/monitoring/accelerators';

import { requestMonitoringJson as requestJson } from '../../../../shared/api/monitoringClient';


export function getAcceleratorCapabilities({ signal } = {}) {
    return requestJson(BASE_PATH, { signal });
}

function buildAcceleratorInstallPayload(request, monitoringNamespace) {
    const payload = { ...request };
    const effectiveMonitoringNs = typeof (monitoringNamespace ?? payload.monitoring_namespace) === 'string'
        ? (monitoringNamespace ?? payload.monitoring_namespace).trim()
        : '';
    if (effectiveMonitoringNs) {
        payload.monitoring_namespace = effectiveMonitoringNs;
    } else {
        delete payload.monitoring_namespace;
    }
    return payload;
}

export function getAcceleratorStatus(
    accelerator,
    { namespace, accessMode, monitoringNamespace, signal, clusterId } = {},
) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (accessMode) query.set('access_mode', accessMode);
    if (monitoringNamespace) query.set('monitoring_namespace', monitoringNamespace);
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(
        `${BASE_PATH}/${encodeURIComponent(accelerator)}/status${qs ? `?${qs}` : ''}`,
        { signal },
    );
}

export function preflightAcceleratorInstall(request, { monitoringNamespace, signal, clusterId } = {}) {
    const accelerator = request.accelerator;
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    const payload = buildAcceleratorInstallPayload(request, monitoringNamespace);
    return requestJson(`${BASE_PATH}/${encodeURIComponent(accelerator)}/installations/preflight${query}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export function installAccelerator(request, idempotencyKey, clusterId, { monitoringNamespace } = {}) {
    const accelerator = request.accelerator;
    const query = clusterId ? `?cluster_id=${encodeURIComponent(clusterId)}` : '';
    const payload = buildAcceleratorInstallPayload(request, monitoringNamespace);
    return requestJson(`${BASE_PATH}/${encodeURIComponent(accelerator)}/installations${query}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
    });
}

export function getAcceleratorOperation(accelerator, operationId, { signal } = {}) {
    return requestJson(
        `${BASE_PATH}/${encodeURIComponent(accelerator)}/operations/${encodeURIComponent(operationId)}`,
        { signal }
    );
}

export function getAcceleratorLinks(accelerator, { monitoringNamespace, signal, clusterId } = {}) {
    const query = new URLSearchParams();
    if (monitoringNamespace) query.set('monitoring_namespace', monitoringNamespace);
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(
        `${BASE_PATH}/${encodeURIComponent(accelerator)}/links${qs ? `?${qs}` : ''}`,
        { signal },
    );
}

export function getAcceleratorAdminScript(
    accelerator,
    { namespace, accessMode, monitoringNamespace, clusterId, signal } = {},
) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (accessMode) query.set('access_mode', accessMode);
    if (monitoringNamespace) query.set('monitoring_namespace', monitoringNamespace);
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(
        `${BASE_PATH}/${encodeURIComponent(accelerator)}/admin-script${qs ? `?${qs}` : ''}`,
        { signal },
    );
}

export function recheckAccelerator(
    accelerator,
    { namespace, accessMode, monitoringNamespace, clusterId } = {},
) {
    const query = new URLSearchParams();
    if (namespace) query.set('namespace', namespace);
    if (accessMode) query.set('access_mode', accessMode);
    if (monitoringNamespace) query.set('monitoring_namespace', monitoringNamespace);
    if (clusterId) query.set('cluster_id', clusterId);
    const qs = query.toString();
    return requestJson(
        `${BASE_PATH}/${encodeURIComponent(accelerator)}/recheck${qs ? `?${qs}` : ''}`,
        { method: 'POST' },
    );
}
