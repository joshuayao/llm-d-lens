import assert from 'node:assert/strict';
import test from 'node:test';
import {
    adminHandoffStatus,
    cancelExecution,
    completeExecution,
    deleteCluster,
    executeOperation,
    getCluster,
    getPlan,
    parseDeleteCleanupHandoff,
    permissionCheck,
    permissionDetails,
    permissionRemediation,
    putPlan,
    saveDraftHfToken,
    verifyAdminHandoff,
} from './clusterPermissionBackend.js';

test('cluster and plan reads target the encoded cluster routes', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return Response.json({ ok: true });
    });
    assert.deepEqual(await getCluster('a/b'), { ok: true });
    assert.deepEqual(await getPlan('a/b'), { ok: true });
    assert.equal(calls[0].url, '/api/cluster/clusters/a%2Fb');
    assert.equal(calls[1].url, '/api/cluster/clusters/a%2Fb/plan');
});

test('putPlan sends the plan body and optional If-Match header', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return Response.json({ planHash: 'new' });
    });
    const plan = { planVersion: 5, gateway: { provider: 'istio' } };
    assert.deepEqual(await putPlan('c1', plan, { ifMatch: 'old' }), { planHash: 'new' });
    assert.equal(calls[0].url, '/api/cluster/clusters/c1/plan');
    assert.equal(calls[0].options.method, 'PUT');
    assert.equal(calls[0].options.headers.get('If-Match'), 'old');
    assert.deepEqual(JSON.parse(calls[0].options.body), plan);
});

test('saveDraftHfToken sends the token and optional X-Lens-Execution-Token header', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 204 });
    });
    assert.deepEqual(await saveDraftHfToken('a/b', 'hf_secret'), {});
    assert.deepEqual(await saveDraftHfToken('c1', 'hf_next', { executionToken: 'run-token' }), {});

    assert.equal(calls[0].url, '/api/cluster/clusters/a%2Fb/draft-hf-token');
    assert.equal(calls[0].options.method, 'PUT');
    assert.equal(calls[0].options.headers.get('Content-Type'), 'application/json');
    assert.equal(calls[0].options.headers.get('X-Lens-Execution-Token'), null);
    assert.deepEqual(JSON.parse(calls[0].options.body), { token: 'hf_secret' });

    assert.equal(calls[1].url, '/api/cluster/clusters/c1/draft-hf-token');
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].options.headers.get('X-Lens-Execution-Token'), 'run-token');
    assert.deepEqual(JSON.parse(calls[1].options.body), { token: 'hf_next' });
});

test('permissionCheck and permissionRemediation post without a body', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return Response.json({ status: 'admin_required' });
    });
    await permissionCheck('c1');
    await permissionRemediation('c1');
    assert.equal(calls[0].url, '/api/cluster/clusters/c1/permission-check');
    assert.equal(calls[1].url, '/api/cluster/clusters/c1/permission-remediation');
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[1].options.body, undefined);
});

test('adminHandoffStatus is a read and verify returns the execution token', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith('/verify')) {
            return Response.json({ status: 'complete', token: 'run-token' });
        }
        return Response.json({ status: 'partial' });
    });
    assert.deepEqual(await adminHandoffStatus('c1'), { status: 'partial' });
    const verified = await verifyAdminHandoff('c1');
    assert.deepEqual(verified, {
        body: { status: 'complete', token: 'run-token' },
        token: 'run-token',
    });
    await executeOperation('c1', 'gateway.manifests', { planHash: 'plan-hash', token: verified.token });
    assert.equal(calls[0].url, '/api/cluster/clusters/c1/admin-handoff/status');
    assert.equal(calls[1].url, '/api/cluster/clusters/c1/admin-handoff/verify');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[2].options.headers.get('X-Lens-Execution-Token'), 'run-token');
});

test('executeOperation sends plan/token headers and only secret values when present', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return Response.json(
            { operationId: 'gateway.manifests', status: 'user_done' },
            { headers: { 'X-Lens-Execution-Token': 'next-token' } },
        );
    });
    await executeOperation('c1', 'gateway.manifests', { planHash: 'plan-hash' });
    await executeOperation('c1', 'cache.hf-secret', {
        planHash: 'plan-hash',
        token: 'run-token',
        secretValues: { HF_TOKEN: 'secret' },
    });
    assert.equal(calls[0].url, '/api/cluster/clusters/c1/operations/gateway.manifests/execute');
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers.get('X-Lens-Plan-Hash'), 'plan-hash');
    assert.equal(calls[0].options.headers.get('X-Lens-Execution-Token'), null);
    assert.deepEqual(JSON.parse(calls[1].options.body), { secretValues: { HF_TOKEN: 'secret' } });
    assert.equal(calls[1].options.headers.get('X-Lens-Execution-Token'), 'run-token');
});

test('completeExecution posts the plan hash and run token', async (t) => {
    let captured;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        captured = { url, options };
        return new Response(null, { status: 204 });
    });
    assert.deepEqual(await completeExecution('c1', { planHash: 'plan-hash', token: 'run-token' }), {});
    assert.equal(captured.url, '/api/cluster/clusters/c1/execution/complete');
    assert.equal(captured.options.headers.get('X-Lens-Plan-Hash'), 'plan-hash');
    assert.equal(captured.options.headers.get('X-Lens-Execution-Token'), 'run-token');
});

test('cancelExecution forwards the token and force flag', async (t) => {
    let captured;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        captured = { url, options };
        return new Response(null, { status: 204 });
    });
    assert.deepEqual(await cancelExecution('c1', { token: 'run-token' }), {});
    assert.equal(captured.url, '/api/cluster/clusters/c1/execution/cancel');
    assert.deepEqual(JSON.parse(captured.options.body), { force: false, token: 'run-token' });
});

test('permissionDetails reads operation re-split fields from the problem body', () => {
    const body = {
        status: 'admin_required',
        missing: [{ operationId: 'gateway.manifests', verb: 'create', resource: 'gateways' }],
        adminOperations: [{ id: 'gateway.manifests' }],
        blockedOperations: [],
        remainingOperations: ['gateway.manifests'],
        operationId: 'gateway.manifests',
        marker: { status: 'missing' },
        remediation: { path: '/api/cluster/clusters/c1/permission-remediation' },
        planHash: 'abc',
    };
    assert.deepEqual(permissionDetails({ body }), body);
    assert.deepEqual(permissionDetails(new Error('plain failure')), {
        status: null,
        missing: [],
        adminOperations: [],
        blockedOperations: [],
        remainingOperations: [],
        operationId: null,
        marker: null,
        remediation: null,
        planHash: null,
    });
});

test('getCluster times out instead of leaving resume busy forever', async (t) => {
    let signal;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        signal = options.signal;
        return new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
    });
    await assert.rejects(getCluster('c1', { timeoutMs: 5 }), /timed out/);
    assert.equal(signal.aborted, true);
});

test('getCluster forwards caller abort to the fetch request', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, options) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }));
    const controller = new AbortController();
    const pending = getCluster('c1', { signal: controller.signal, timeoutMs: 1000 });
    controller.abort(new Error('navigation cancelled'));
    await assert.rejects(pending, /navigation cancelled/);
});

test('deleteCluster sends DELETE and optional confirmAdminCleanup query param', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 204 });
    });

    assert.deepEqual(await deleteCluster('a/b'), {});
    assert.deepEqual(await deleteCluster('c1', { confirmAdminCleanup: true }), {});

    assert.equal(calls[0].url, '/api/cluster/clusters/a%2Fb');
    assert.equal(calls[0].options.method, 'DELETE');
    assert.equal(calls[1].url, '/api/cluster/clusters/c1?confirmAdminCleanup=true');
    assert.equal(calls[1].options.method, 'DELETE');
});

test('parseDeleteCleanupHandoff parses 409 admin cleanup and 502 unreachable handoffs', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
        if (url.includes('409-handoff')) {
            return Response.json(
                {
                    code: 'cluster_admin_cleanup_required',
                    detail: 'Admin cleanup needed',
                    clusterId: '409-handoff',
                    cleanupDigest: 'digest-1',
                    operations: [{ id: 'gateway.namespace', title: 'Delete gateway namespace', kind: 'namespace', name: 'lens-gateway-1', namespace: null, required: true }],
                    completedOperations: [{ id: 'hf-secret.secret', title: 'Delete HF secret', kind: 'secret', name: 'hf-token', namespace: 'lens-edit', required: true }],
                    script: '#!/usr/bin/env bash\nkubectl delete ns lens-gateway-1 --ignore-not-found=true',
                    scriptFilename: 'lens-admin-cleanup-1.sh',
                    instructions: 'Run once then re-check.',
                    marker: { namespace: 'lens-edit', name: 'lens-admin-cleanup-1', status: 'missing', verified: false, operations: [] },
                    canVerifyMarker: true,
                    confirmRequired: false,
                    unreachable: false,
                    warnings: ['Check namespace'],
                },
                { status: 409 },
            );
        }
        return Response.json(
            {
                code: 'cluster_gateway_cleanup_failed',
                detail: 'Cluster unreachable',
                clusterId: '502-handoff',
                cleanupDigest: 'digest-2',
                operations: [{ id: 'gateway.namespace', title: 'Delete gateway namespace', kind: 'namespace', name: 'lens-gateway-2', namespace: null, required: true }],
                script: '#!/usr/bin/env bash\nkubectl delete ns lens-gateway-2 --ignore-not-found=true',
                scriptFilename: 'lens-admin-cleanup-2.sh',
                confirmRequired: true,
                unreachable: true,
            },
            { status: 502 },
        );
    });

    await assert.rejects(deleteCluster('409-handoff'), (error) => {
        const handoff = parseDeleteCleanupHandoff(error);
        assert.equal(handoff?.code, 'cluster_admin_cleanup_required');
        assert.equal(handoff?.clusterId, '409-handoff');
        assert.equal(handoff?.cleanupDigest, 'digest-1');
        assert.equal(handoff?.operations.length, 1);
        assert.equal(handoff?.completedOperations.length, 1);
        assert.match(handoff?.script, /kubectl delete ns lens-gateway-1/);
        assert.equal(handoff?.scriptFilename, 'lens-admin-cleanup-1.sh');
        assert.equal(handoff?.canVerifyMarker, true);
        assert.equal(handoff?.confirmRequired, false);
        assert.equal(handoff?.unreachable, false);
        assert.deepEqual(handoff?.warnings, ['Check namespace']);
        return true;
    });

    await assert.rejects(deleteCluster('502-handoff'), (error) => {
        const handoff = parseDeleteCleanupHandoff(error);
        assert.equal(handoff?.code, 'cluster_gateway_cleanup_failed');
        assert.equal(handoff?.confirmRequired, true);
        assert.equal(handoff?.unreachable, true);
        assert.match(handoff?.script, /lens-gateway-2/);
        return true;
    });
});

test('parseDeleteCleanupHandoff returns null for non-handoff delete errors', () => {
    assert.equal(parseDeleteCleanupHandoff(null), null);
    assert.equal(parseDeleteCleanupHandoff(new Error('plain failure')), null);
    assert.equal(
        parseDeleteCleanupHandoff({ status: 409, code: 'cluster_has_available_deployments', body: { code: 'cluster_has_available_deployments' } }),
        null,
    );
    assert.equal(
        parseDeleteCleanupHandoff({ status: 409, code: 'cluster_has_storage_volumes', body: { code: 'cluster_has_storage_volumes' } }),
        null,
    );
    assert.equal(
        parseDeleteCleanupHandoff({ status: 502, code: 'cluster_gateway_cleanup_failed', body: { code: 'cluster_gateway_cleanup_failed', detail: 'Gateway failed' } }),
        null,
    );
    assert.equal(
        parseDeleteCleanupHandoff({ status: 500, code: '', body: { detail: 'Internal error' } }),
        null,
    );
    const scriptOnly502 = parseDeleteCleanupHandoff({
        status: 502,
        code: 'cluster_gateway_cleanup_failed',
        body: { code: 'cluster_gateway_cleanup_failed', script: '#!/usr/bin/env bash\necho ok' },
    });
    assert.equal(scriptOnly502?.confirmRequired, true);
    assert.equal(scriptOnly502?.unreachable, true);
});
