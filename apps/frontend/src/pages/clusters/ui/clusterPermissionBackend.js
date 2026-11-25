// Client for the configuration-first cluster API: provisioning plan,
// operation-scoped permission preflight/remediation, admin handoff status and
// user-operation execution. See
// docs/design/cluster-permission-preflight-design.md sections 4.4/4.5/4.6/5/8.

import {
    executionHeaders,
    executionToken,
    requestJson,
    requestJsonWithMeta,
} from '../../../shared/api/httpClient';

function clusterUrl(clusterId, suffix = '') {
    return `/api/cluster/clusters/${encodeURIComponent(clusterId)}${suffix}`;
}

/**
 * @typedef {Object} ClusterDetail
 * @property {Object} cluster The cluster record (draft flag, proxy, gateway, ...).
 * @property {Object|null} plan The stored provisioning plan.
 * @property {string|null} planHash
 * @property {number|null} planVersion
 * @property {Record<string, string>|null} executionOperations Operation ledger.
 * @property {string|null} executionCompletedAt ISO timestamp when the run completed, else null.
 * @property {string|null} executionCompletedPlanHash Plan hash recorded by that completion.
 * @property {boolean} [draftHfTokenSaved] True when an encrypted draft HF token is saved for this draft.
 */

const CLUSTER_READ_TIMEOUT_MS = 15000;

/**
 * GET /api/cluster/clusters/{id} — cluster record, plan and operation ledger.
 * A bounded timeout prevents a hung request from leaving the resume UI busy.
 */
export async function getCluster(
    clusterId,
    { signal, timeoutMs = CLUSTER_READ_TIMEOUT_MS } = {},
) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        const error = new Error('Loading the saved draft timed out. Retry.');
        error.name = 'TimeoutError';
        controller.abort(error);
    }, timeoutMs);
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
        return await requestJson(clusterUrl(clusterId), { signal: controller.signal });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
    }
}

/** GET /api/cluster/clusters/{id}/plan — stored plan plus its hashes. */
export function getPlan(clusterId) {
    return requestJson(clusterUrl(clusterId, '/plan'));
}

/** PUT /api/cluster/clusters/{id}/plan — validate, normalize and store a plan. */
export function putPlan(clusterId, plan, { ifMatch } = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (ifMatch) headers.set('If-Match', ifMatch);
    return requestJson(clusterUrl(clusterId, '/plan'), {
        method: 'PUT',
        headers,
        body: JSON.stringify(plan),
    });
}

/** PUT /api/cluster/clusters/{id}/draft-hf-token — store the draft HF token encrypted at rest. */
export function saveDraftHfToken(clusterId, token, { executionToken } = {}) {
    const headers = executionHeaders(
        { token: executionToken },
        { 'Content-Type': 'application/json' },
    );
    return requestJson(clusterUrl(clusterId, '/draft-hf-token'), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ token }),
    });
}

/** POST /api/cluster/clusters/{id}/permission-check — evaluate the stored plan. */
export function permissionCheck(clusterId) {
    return requestJson(clusterUrl(clusterId, '/permission-check'), { method: 'POST' });
}

/** POST /api/cluster/clusters/{id}/permission-remediation — admin operation script. */
export function permissionRemediation(clusterId) {
    return requestJson(clusterUrl(clusterId, '/permission-remediation'), { method: 'POST' });
}

/** GET /api/cluster/clusters/{id}/admin-handoff/status — marker state, read-only. */
export function adminHandoffStatus(clusterId) {
    return requestJson(clusterUrl(clusterId, '/admin-handoff/status'));
}

/** POST /api/cluster/clusters/{id}/admin-handoff/verify — verify marker and get token. */
export function verifyAdminHandoff(clusterId) {
    return executionRequest(clusterUrl(clusterId, '/admin-handoff/verify'), { method: 'POST' });
}

/** POST /api/cluster/clusters/{id}/execution/cancel — stop the active run. */
export function cancelExecution(clusterId, { token, force = false } = {}) {
    const body = { force: Boolean(force) };
    if (token) body.token = token;
    return requestJson(clusterUrl(clusterId, '/execution/cancel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function executionRequest(url, options) {
    const { body, response } = await requestJsonWithMeta(url, options);
    return { body, token: body?.token || executionToken(response) };
}

/**
 * POST /api/cluster/clusters/{id}/operations/{operationId}/execute — run one
 * user operation. The first user operation acquires the token; later operations
 * reuse it. `secretValues` is only sent for user-owned secret operations.
 */
export function executeOperation(clusterId, operationId, { planHash, token, secretValues } = {}) {
    const body = {};
    if (secretValues !== undefined) body.secretValues = secretValues;
    return executionRequest(
        clusterUrl(clusterId, `/operations/${encodeURIComponent(operationId)}/execute`),
        {
            method: 'POST',
            headers: executionHeaders(
                { planHash, token },
                Object.keys(body).length ? { 'Content-Type': 'application/json' } : undefined,
            ),
            body: Object.keys(body).length ? JSON.stringify(body) : undefined,
        },
    );
}

/** POST /api/cluster/clusters/{id}/execution/complete — lens operations + finalize. */
export function completeExecution(clusterId, { planHash, token } = {}) {
    return requestJson(clusterUrl(clusterId, '/execution/complete'), {
        method: 'POST',
        headers: executionHeaders({ planHash, token }),
    });
}

/**
 * DELETE /api/cluster/clusters/{id} — delete a cluster registration, optionally
 * confirming removal when admin cleanup cannot be verified or the cluster is unreachable.
 */
export function deleteCluster(clusterId, { confirmAdminCleanup = false } = {}) {
    const query = confirmAdminCleanup ? '?confirmAdminCleanup=true' : '';
    return requestJson(clusterUrl(clusterId, query), { method: 'DELETE' });
}

/**
 * Parse a 409 cluster_admin_cleanup_required or 502 cluster_gateway_cleanup_failed
 * handoff payload from a failed deleteCluster() error; returns null for other errors.
 */
export function parseDeleteCleanupHandoff(error) {
    const status = error?.status;
    const body = error?.body && typeof error.body === 'object' ? error.body : null;
    if (!body) return null;
    const code = error?.code || body.code || '';
    const isAdminRequired = status === 409 && code === 'cluster_admin_cleanup_required';
    const isUnreachableWithFallback = status === 502
        && code === 'cluster_gateway_cleanup_failed'
        && Boolean(body.confirmRequired || body.script);
    if (!isAdminRequired && !isUnreachableWithFallback) return null;
    return {
        code,
        clusterId: body.clusterId ?? null,
        detail: (typeof body.detail === 'string' && body.detail) || body.error || error?.message || '',
        cleanupDigest: body.cleanupDigest ?? null,
        operations: Array.isArray(body.operations) ? body.operations : [],
        completedOperations: Array.isArray(body.completedOperations) ? body.completedOperations : [],
        script: typeof body.script === 'string' ? body.script : '',
        scriptFilename: body.scriptFilename || 'lens-admin-cleanup.sh',
        instructions: body.instructions || '',
        marker: body.marker && typeof body.marker === 'object' ? body.marker : null,
        canVerifyMarker: Boolean(body.canVerifyMarker),
        confirmRequired: Boolean(body.confirmRequired || isUnreachableWithFallback),
        unreachable: Boolean(body.unreachable || isUnreachableWithFallback),
        warnings: Array.isArray(body.warnings) ? body.warnings : [],
    };
}

/**
 * Extract the operation handoff payload from a failed check/execution response.
 * The backend keeps these values at the top level of the problem body.
 */
export function permissionDetails(error) {
    const body = error?.body || {};
    return {
        status: body.status ?? null,
        missing: Array.isArray(body.missing) ? body.missing : [],
        adminOperations: Array.isArray(body.adminOperations) ? body.adminOperations : [],
        blockedOperations: Array.isArray(body.blockedOperations) ? body.blockedOperations : [],
        remainingOperations: Array.isArray(body.remainingOperations) ? body.remainingOperations : [],
        operationId: body.operationId ?? null,
        marker: body.marker ?? null,
        remediation: body.remediation ?? null,
        planHash: body.plan_hash ?? body.planHash ?? null,
    };
}
