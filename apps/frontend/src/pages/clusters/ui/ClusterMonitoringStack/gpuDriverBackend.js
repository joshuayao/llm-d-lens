// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Client for the Intel GPU DRA driver / device plugin installer API. This is
// a separate, decoupled API from acceleratorObservabilityBackend.js, which
// only installs the xpumd *telemetry* chart on top of an already-present
// driver -- this one installs the driver/plugin itself.

const BASE_PATH = '/api/v1/monitoring/gpu-driver';

import { requestMonitoringJson as requestJson, requestMonitoringJsonWithMeta as requestJsonWithMeta } from '../../../../shared/api/monitoringClient';
import { executionHeaders, executionToken } from '../../../../shared/api/httpClient';


export function getGpuDriverStatus(accessMode, { clusterId, hardware, signal } = {}) {
    const query = new URLSearchParams({ access_mode: accessMode });
    if (clusterId) query.set('cluster_id', clusterId);
    if (hardware) query.set('hardware', hardware);
    return requestJson(`${BASE_PATH}/status?${query.toString()}`, { signal });
}

export async function installGpuDriver(accessMode, { clusterId, hardware, signal, planHash, token } = {}) {
    const query = new URLSearchParams();
    if (clusterId) query.set('cluster_id', clusterId);
    if (hardware) query.set('hardware', hardware);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const request = {
        method: 'POST',
        signal,
        headers: executionHeaders({ planHash, token }, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ access_mode: accessMode }),
    };
    // Existing callers pass clusterId/hardware but no execution options and
    // still expect the plain body; only a guarded call returns the token.
    if (planHash === undefined && token === undefined) {
        return requestJson(`${BASE_PATH}/install${suffix}`, request);
    }
    const { body, response } = await requestJsonWithMeta(`${BASE_PATH}/install${suffix}`, request);
    return { body, token: executionToken(response) };
}

// Polls status until the driver/plugin is ready, or the timeout elapses.
export async function waitForGpuDriverReady(accessMode, { clusterId, hardware, timeoutMs = 300000, intervalMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const status = await getGpuDriverStatus(accessMode, { clusterId, hardware });
        if (status.ready) return status;
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for the accelerator ${accessMode === 'dra' ? 'DRA driver' : 'device plugin'} to become ready`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}
