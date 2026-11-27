import assert from 'node:assert/strict';
import test from 'node:test';
import {
    confirmEvaluationPlans,
    createEvaluation,
    evaluationApi,
    evaluationPlanReview,
    resolveEvaluationTarget,
    retryEvaluationWorkflow,
} from './client.js';
import { isDeploymentAdminSetupError, isDeploymentCleanupHandoffError } from '../../deployment/api/agenticDeploymentBackend.js';

test('resumed review confirms exactly the captured plan digests', async (t) => {
    const workflow = { id: 'workflow', prepared_plans: [{ id: 'plan', digest: 'sha256:reviewed', cases: [], preflight: { status: 'pass' } }] };
    const review = evaluationPlanReview(workflow);
    assert.equal(review.plan.preflight.status, 'pass');
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { plan_digests: { plan: 'sha256:reviewed' }, acknowledge_unknown: false });
        return Response.json({ status: 'queued' });
    });
    await confirmEvaluationPlans(review.workflow, false);
});

test('confirmEvaluationPlans forwards target_namespaces when provided and omits when empty', async (t) => {
    const workflow = { id: 'wf-1', prepared_plans: [{ id: 'plan-1', digest: 'sha256:p1', cases: [], preflight: { status: 'pass' } }] };
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return Response.json({ status: 'queued' });
    });

    await confirmEvaluationPlans(workflow, true, {});
    await confirmEvaluationPlans(workflow, false, { 'setup-1:guide': 'llmd-eval-1' });

    assert.deepEqual(bodies[0], { plan_digests: { 'plan-1': 'sha256:p1' }, acknowledge_unknown: true });
    assert.deepEqual(bodies[1], {
        plan_digests: { 'plan-1': 'sha256:p1' },
        acknowledge_unknown: false,
        target_namespaces: { 'setup-1:guide': 'llmd-eval-1' },
    });
});

test('retryEvaluationWorkflow omits empty body and forwards non-empty target_namespaces', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({ url, method: options.method, body: options.body });
        return Response.json({ id: 'wf-1', status: 'queued' });
    });

    await retryEvaluationWorkflow('wf/1');
    await retryEvaluationWorkflow('wf/1', {});
    await retryEvaluationWorkflow('wf/1', { 'setup-1:guide': 'llmd-eval-2' });

    assert.equal(calls[0].url, '/api/v1/evaluate/workflow-runs/wf%2F1/retry');
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[1].body, undefined);
    assert.deepEqual(JSON.parse(calls[2].body), { target_namespaces: { 'setup-1:guide': 'llmd-eval-2' } });
});

test('createEvaluation forwards non-empty target_namespaces and omits empty or null', async (t) => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return Response.json({ id: 'wf-2', status: 'queued' });
    });

    await createEvaluation({ name: 'eval', cluster_session_id: 's1', benchmark_plans: [], target_namespaces: {} });
    await createEvaluation({ name: 'eval', cluster_session_id: 's1', benchmark_plans: [], target_namespaces: null });
    await createEvaluation({ name: 'eval', cluster_session_id: 's1', benchmark_plans: [], target_namespaces: { 'setup-1:guide': 'llmd-ns' } });
    assert.equal('target_namespaces' in bodies[0], false);
    assert.equal('target_namespaces' in bodies[1], false);
    assert.deepEqual(bodies[2].target_namespaces, { 'setup-1:guide': 'llmd-ns' });
});

test('evaluation adapter preserves validation-array details, body, and handoff error codes', async (t) => {
    const detail = [{loc:['body','name'],msg:'Required'}];
    t.mock.method(globalThis, 'fetch', async () => Response.json({detail},{status:422}));
    await assert.rejects(evaluationApi('/test'), error => {
        assert.equal(error.message,'name: Required');
        assert.equal(error.status,422);
        assert.deepEqual(error.details,detail);
        assert.deepEqual(error.body,{detail});
        assert.equal(error.code, null);
        return true;
    });

    const setupPayload = { code: 'deployment_admin_setup_required', detail: 'Admin required', namespace: 'llmd-1', targets: [{ key: 'setup-1:guide', namespace: 'llmd-1' }] };
    t.mock.method(globalThis, 'fetch', async () => Response.json(setupPayload, { status: 403 }));
    await assert.rejects(evaluationApi('/test-setup'), error => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'deployment_admin_setup_required');
        assert.deepEqual(error.body, setupPayload);
        assert.equal(isDeploymentAdminSetupError(error), true);
        return true;
    });

    const cleanupPayload = { code: 'deployment_cleanup_permission_denied', detail: 'Cleanup required', executionId: 'exec-1', namespace: 'llmd-1' };
    t.mock.method(globalThis, 'fetch', async () => Response.json(cleanupPayload, { status: 409 }));
    await assert.rejects(evaluationApi('/test-cleanup'), error => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'deployment_cleanup_permission_denied');
        assert.deepEqual(error.body, cleanupPayload);
        assert.equal(isDeploymentCleanupHandoffError(error), true);
        return true;
    });
});


test('submission resolves the selected model service group id', () => {
    assert.equal(resolveEvaluationTarget({targetId: 'msg-1'}), 'msg-1');
    assert.throws(() => resolveEvaluationTarget({targetId: ''}), /Select an existing model service/);
});
