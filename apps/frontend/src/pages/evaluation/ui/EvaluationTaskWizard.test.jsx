import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthContext } from '../../auth/AuthContext.js';
import { EVALUATION_TRANSFER_KEYS } from '../model/transfer.js';
import EvaluationDashboard from './EvaluationDashboard.jsx';
import EvaluationTaskWizard, { DeploymentPlanReview } from './EvaluationTaskWizard.jsx';
import OptimizationEvaluationDetails from './OptimizationEvaluationDetails.jsx';

function renderWizard(t, intent, can = () => true) {
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: {
            getItem: (key) => key === EVALUATION_TRANSFER_KEYS.INTENT ? JSON.stringify(intent) : null,
            removeItem() {},
        },
    });
    t.after(() => {
        if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
        else delete globalThis.sessionStorage;
    });
    return renderToStaticMarkup(createElement(AuthContext.Provider, { value: { can } },
        createElement(EvaluationTaskWizard, { onNavigate() {} })));
}

function configurationStep(html) {
    const progress = html.match(/<ol\b[^>]*aria-label="Task creation progress"[^>]*>(.*?)<\/ol>/s);
    assert.ok(progress);
    return [...progress[1].matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)]
        .find((match) => match[2].includes('Configurations'))[1];
}

test('Model Market handoff starts the shared configuration step with a model-card return', (t) => {
    const html = renderWizard(t, {
        entrySource: 'model-market',
        operation: 'create-evaluation',
        initial_step: 'configurations',
        name: 'market-benchmark',
        deployment_name: 'market-serving',
        cluster_id: 'test-cluster',
        workloads: [{ model: 'Qwen/Qwen3-8B', replicas: 3, tensor_parallel_size: 2 }],
        runtime: { max_model_len: 8192 },
    });
    assert.match(html, /New Benchmark Task/);
    assert.doesNotMatch(configurationStep(html), /disabled=/);
    assert.match(configurationStep(html), /ring-cyan-400\/25/);
    assert.match(html, /Back to model card/);
    assert.doesNotMatch(html, /Continue to Benchmark|Execution plan/);
});

test('ordinary benchmark creation still starts at Evaluation Setup', (t) => {
    const html = renderWizard(t, null);
    assert.match(html, /New Benchmark Task/);
    assert.match(configurationStep(html), /disabled=/);
});

test('evaluation configuration links open the shared editor and retain benchmark steps', (testContext) => {
    const html = renderWizard(testContext, {
        entrySource: 'evaluation-setup',
        operation: 'create-evaluation',
        initial_step: 'configurations',
        return_target: 'optimization-evaluate-new',
        name: 'existing-evaluation',
        selected_artifact_ids: ['existing-configuration'],
    });
    assert.match(configurationStep(html), /ring-cyan-400\/25/);
    assert.match(html, /Continue to Benchmark/);
    assert.match(html, /Execution plan/);
    assert.doesNotMatch(html, /Back to model card/);
});

test('explicit Model Market source uses the shared configuration wizard, not the legacy screen', (testContext) => {
    const html = renderWizard(testContext, { entrySource: 'model-market', operation: 'deploy-only' });
    assert.match(html, /New Benchmark Task/);
    assert.match(configurationStep(html), /ring-cyan-400\/25/);
    assert.doesNotMatch(html, /Configure deployment/);
    assert.match(html, /Back to model card/);
    assert.doesNotMatch(html, /Execution plan/);
});

test('explicit Evaluation source overrides legacy operation and starts at Setup', (testContext) => {
    const html = renderWizard(testContext, { entrySource: 'evaluation-setup', operation: 'deploy-only' });
    assert.match(html, /New Benchmark Task/);
    assert.match(configurationStep(html), /disabled=/);
    assert.doesNotMatch(html, /Configure deployment/);
    assert.doesNotMatch(html, /Back to model card/);
    assert.match(html, /Execution plan/);
});

test('configuration handoff does not bypass benchmark-only permissions', (t) => {
    const html = renderWizard(t, {
        entrySource: 'model-market', operation: 'create-evaluation', initial_step: 'configurations',
    }, (permission) => permission === 'evaluate:run:create');
    assert.match(configurationStep(html), /disabled=/);
});

test('legacy deploy-only handoffs retain their deployment screen', (t) => {
    const html = renderWizard(t, { operation: 'deploy-only' });
    assert.match(html, /Configure deployment/);
    assert.doesNotMatch(html, /New Benchmark Task|Task creation progress/);
});

test('EvaluationTaskWizard DeploymentPlanReview renders Orchestration administrator handoff and disables Deploy when adminHandoff is active', () => {
    const html = renderToStaticMarkup(createElement(DeploymentPlanReview, {
        preparedReview: {
            plan: {
                id: 'plan-1',
                digest: 'sha256:plan-1',
                cases: [{ namespace: 'llmd-ds-1', manifest: 'kind: DisaggregatedSet' }],
                preflight: { status: 'pass', errors: [], unmodeled: [] },
            },
        },
        acknowledgeUnknown: false,
        setAcknowledgeUnknown() {},
        onClose() {},
        onConfirm() {},
        adminHandoff: {
            namespace: 'llmd-ds-1',
            report: { status: 'admin_required', adminOperations: [{ id: 'ns.create', title: 'Create namespace' }] },
            script: '#!/usr/bin/env bash\nkubectl apply -f -',
            identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
        },
        onVerifyBootstrap() {},
        onRegenerateBootstrap() {},
        onDismissAdminHandoff() {},
    }));
    assert.match(html, /Orchestration administrator namespace setup/);
    assert.match(html, /Re-check &amp; Deploy/);
    assert.match(html, />Dismiss<\/button>/);
    const deployButton = [...html.matchAll(/<button\b[^]*?<\/button>/g)].map((m) => m[0]).find((b) => b.includes('Deploy</button>') && !b.includes('Re-check'));
    assert.ok(deployButton);
    assert.match(deployButton, /disabled=""/);
});

function createWizardTestDom() {
    const makeNode = (tag, doc) => ({
        nodeType: tag === '#text' ? 3 : tag === '#comment' ? 8 : 1,
        nodeName: tag.toUpperCase(),
        tagName: tag.toUpperCase(),
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: doc,
        parentNode: null,
        childNodes: [],
        attributes: {},
        style: {},
        dataset: {},
        nodeValue: '',
        get textContent() {
            if (this.nodeType === 3) return this.nodeValue || '';
            if (this.nodeType === 8) return '';
            return this.childNodes.map((child) => child.textContent).join('');
        },
        set textContent(value) {
            const text = String(value);
            if (this.nodeType === 3) { this.nodeValue = text; return; }
            this.childNodes = text ? [doc.createTextNode(text)] : [];
            for (const child of this.childNodes) child.parentNode = this;
        },
        addEventListener() {},
        removeEventListener() {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
        removeAttribute(key) { delete this.attributes[key]; },
        getAttribute(key) { return key in this.attributes ? this.attributes[key] : null; },
        hasAttribute(key) { return key in this.attributes; },
        scrollIntoView() {},
        appendChild(child) {
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = this;
            this.childNodes.push(child);
            return child;
        },
        insertBefore(child, reference) {
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = this;
            const index = reference ? this.childNodes.indexOf(reference) : -1;
            if (index === -1) this.childNodes.push(child);
            else this.childNodes.splice(index, 0, child);
            return child;
        },
        removeChild(child) {
            const index = this.childNodes.indexOf(child);
            if (index !== -1) { this.childNodes.splice(index, 1); child.parentNode = null; }
            return child;
        },
        remove() {
            if (this.parentNode) this.parentNode.removeChild(this);
        },
        closest() { return null; },
        get firstChild() { return this.childNodes[0] || null; },
        get options() { return findDomElements(this, (el) => el.tagName === 'OPTION'); },
        get nextSibling() {
            if (!this.parentNode) return null;
            const index = this.parentNode.childNodes.indexOf(this);
            return index >= 0 ? this.parentNode.childNodes[index + 1] || null : null;
        },
        focus() {},
        blur() {},
    });
    const activeTimers = new Set();
    const activeIntervals = new Set();
    const win = {
        location: { search: '' },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
        setInterval: (fn, ms, ...args) => {
            const handle = setInterval(fn, ms, ...args);
            activeIntervals.add(handle);
            return handle;
        },
        clearInterval: (handle) => {
            activeIntervals.delete(handle);
            clearInterval(handle);
        },
        setTimeout: (fn, ms, ...args) => {
            const handle = setTimeout(() => {
                activeTimers.delete(handle);
                fn(...args);
            }, ms);
            activeTimers.add(handle);
            return handle;
        },
        clearTimeout: (handle) => {
            activeTimers.delete(handle);
            clearTimeout(handle);
        },
        scrollTo() {},
        requestAnimationFrame: (callback) => win.setTimeout(callback, 0),
        cancelAnimationFrame: (handle) => win.clearTimeout(handle),
        HTMLIFrameElement: function HTMLIFrameElement() {},
        HTMLElement: function HTMLElement() {},
        SVGElement: function SVGElement() {},
        Node: function Node() {},
    };
    const cleanupTimers = () => {
        for (const handle of activeTimers) clearTimeout(handle);
        for (const handle of activeIntervals) clearInterval(handle);
        activeTimers.clear();
        activeIntervals.clear();
    };
    const doc = {
        nodeType: 9,
        hidden: true,
        cookie: '',
        defaultView: win,
        documentElement: null,
        body: null,
        activeElement: null,
        createElement(tag) { return makeNode(tag, doc); },
        createElementNS(ns, tag) { const node = makeNode(tag, doc); node.namespaceURI = ns; return node; },
        createTextNode(text) { const node = makeNode('#text', doc); node.nodeValue = String(text); return node; },
        createComment(text) { const node = makeNode('#comment', doc); node.nodeValue = String(text); return node; },
        addEventListener() {},
        removeEventListener() {},
        getElementById() { return null; },
    };
    win.document = doc;
    doc.documentElement = makeNode('html', doc);
    doc.body = makeNode('body', doc);
    doc.documentElement.appendChild(doc.body);
    return { doc, win, cleanupTimers };
}

function findDomElements(root, predicate, acc = []) {
    if (!root || root.nodeType !== 1) return acc;
    if (predicate(root)) acc.push(root);
    for (const child of root.childNodes) findDomElements(child, predicate, acc);
    return acc;
}

function domReactProps(element) {
    const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'));
    return key ? element[key] : {};
}

function findFiberOnPublished(node) {
    const fiberKey = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
    if (!fiberKey) return null;
    const queue = [node[fiberKey]];
    const seen = new Set();
    while (queue.length) {
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        if (typeof fiber.memoizedProps?.onPublished === 'function') return fiber.memoizedProps.onPublished;
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
    }
    return null;
}

async function withWizardDom(t, intent, fetchHandler, runScenario) {
    const prevAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevHtml = globalThis.HTMLElement;
    const prevSvg = globalThis.SVGElement;
    const prevIframe = globalThis.HTMLIFrameElement;
    const prevFetch = globalThis.fetch;
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const store = new Map([[EVALUATION_TRANSFER_KEYS.INTENT, JSON.stringify(intent)]]);
    const { doc, win, cleanupTimers } = createWizardTestDom();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.document = doc;
    globalThis.window = win;
    globalThis.HTMLElement = win.HTMLElement;
    globalThis.SVGElement = win.SVGElement;
    globalThis.HTMLIFrameElement = win.HTMLIFrameElement;
    globalThis.fetch = fetchHandler;
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        value: {
            getItem: (key) => (store.has(key) ? store.get(key) : null),
            setItem: (key, val) => { store.set(key, String(val)); },
            removeItem: (key) => { store.delete(key); },
        },
    });
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
        cleanupTimers();
        await act(async () => { root.unmount(); });
        cleanupTimers();
        globalThis.IS_REACT_ACT_ENVIRONMENT = prevAct;
        if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
        if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
        if (prevHtml === undefined) delete globalThis.HTMLElement; else globalThis.HTMLElement = prevHtml;
        if (prevSvg === undefined) delete globalThis.SVGElement; else globalThis.SVGElement = prevSvg;
        if (prevIframe === undefined) delete globalThis.HTMLIFrameElement; else globalThis.HTMLIFrameElement = prevIframe;
        globalThis.fetch = prevFetch;
        if (prevStorage) Object.defineProperty(globalThis, 'sessionStorage', prevStorage);
        else delete globalThis.sessionStorage;
    });
    const findButton = (labelPattern) => findDomElements(
        doc.body,
        (el) => el.tagName === 'BUTTON' && labelPattern.test(el.textContent.trim()),
    )[0] || null;
    const clickButton = async (labelPattern) => {
        const button = findButton(labelPattern);
        assert.ok(button, `Expected button matching ${labelPattern}`);
        const props = domReactProps(button);
        assert.equal(Boolean(props.disabled), false, `Expected button ${labelPattern} to be enabled`);
        await act(async () => {
            await props.onClick?.({ preventDefault() {}, stopPropagation() {} });
        });
    };
    await runScenario({ root, doc, findButton, clickButton });
}

function wizardJson(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function baseWizardFetch(url) {
    if (url.startsWith('/api/cluster/clusters')) {
        return wizardJson({
            items: [{ id: 'cluster-a', name: 'Cluster A', ready: true, llmDRepoPath: '/opt/llm-d', llmDRef: 'v1' }],
        });
    }
    if (url.startsWith('/api/cluster/session')) {
        return wizardJson({ sessionId: 'sess-1', cluster: { id: 'cluster-a', name: 'Cluster A' } });
    }
    if (url.startsWith('/api/cluster/overview')) {
        return wizardJson({ kubernetes: { hardware: { kind: 'gpu' }, nodes: [] } });
    }
    if (url.startsWith('/api/guide-planning/catalog')) {
        return wizardJson({ guides: [{ id: 'pd-disaggregation', label: 'P/D Disaggregation' }] });
    }
    if (url.startsWith('/api/v1/configurations/capabilities')) {
        return wizardJson({ providers: [{ id: 'pd-disaggregation', label: 'P/D Disaggregation' }] });
    }
    if (url.startsWith('/api/v1/configurations/artifacts')) return wizardJson([]);
    if (url.startsWith('/api/v1/model-service/models')) return wizardJson({ items: [] });
    if (url.startsWith('/api/v1/storage/volumes')) return wizardJson({ items: [] });
    if (url.startsWith('/api/v1/hardware/profiles')) return wizardJson({ items: [] });
    if (url.startsWith('/api/v1/deployments/node-labels')) return wizardJson({ items: [] });
    return null;
}

const dsArtifact = {
    artifact_id: 'art-ds-1',
    deployable_configuration: {
        provider_ref: 'pd-disaggregation',
        content: {
            model: { name: 'Qwen/Qwen3-8B' },
            runtime: { storageVolumeId: 'vol-cache-1' },
            disaggregatedSet: { slices: 2 },
            officialGuide: { renderedManifest: 'kind: DisaggregatedSet\nmetadata:\n  name: ds-test\n' },
        },
        provenance: { placement: { replicas: 'prefer-same-node' } },
    },
};

test('EvaluationTaskWizard catches 403 deployment_admin_setup_required on executePreparedDeployment, renders Orchestration administrator script, and deploys after verify', async (t) => {
    const remediationPayloads = [];
    const verifyPayloads = [];
    const runPayloads = [];
    const navigated = [];
    let runAttempts = 0;

    await withWizardDom(
        t,
        {
            entrySource: 'model-market',
            operation: 'create-evaluation',
            initial_step: 'configurations',
            name: 'ds-deploy',
            deployment_name: 'qwen-pd',
            cluster_id: 'cluster-a',
            workloads: [{ model: 'Qwen/Qwen3-8B', guide: 'pd-disaggregation', replicas: 1, tensor_parallel_size: 1 }],
        },
        async (url, options = {}) => {
            const base = baseWizardFetch(url);
            if (base) return base;
            if (url === '/api/v1/deployments/plans') {
                return wizardJson({
                    id: 'plan-ds-1',
                    digest: 'sha256:plan-ds-1',
                    preflight: { status: 'pass', errors: [], unmodeled: [] },
                    cases: [{ namespace: 'llmd-ds-1', manifest: 'kind: DisaggregatedSet\nmetadata:\n  name: ds-test\n' }],
                });
            }
            if (url === '/api/v1/deployments/runs') {
                runAttempts += 1;
                runPayloads.push(JSON.parse(options.body));
                if (runAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Orchestration administrator setup is required before deploying.',
                        namespace: 'llmd-ds-1',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        adminOperations: [{ id: 'ns.create', title: 'Create namespace and RBAC' }],
                    }, 403);
                }
                return wizardJson({ id: 'deploy-run-1', status: 'queued' }, 202);
            }
            if (url === '/api/v1/deployments/permission-remediation') {
                remediationPayloads.push(JSON.parse(options.body));
                return wizardJson({
                    script: '#!/usr/bin/env bash\nkubectl apply -f -',
                    namespace: 'llmd-ds-1',
                    bootstrapDigest: 'digest-ds-1',
                });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                verifyPayloads.push(JSON.parse(options.body));
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-ds-1',
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, findButton, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationTaskWizard, { onNavigate: (view) => navigated.push(view) }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            const editorHost = findDomElements(doc.body, (el) => el.hasAttribute('data-evaluation-configuration-editor'))[0];
            assert.ok(editorHost, 'Expected EvaluationConfigurationEditor container');
            const onPublished = findFiberOnPublished(editorHost);
            assert.ok(onPublished, 'Expected onPublished handler on EvaluationConfigurationEditor');

            await act(async () => {
                await onPublished({ artifacts: [dsArtifact] });
            });

            assert.equal(runAttempts, 1);
            assert.equal(remediationPayloads.length, 1);
            assert.equal(remediationPayloads[0].cluster_id, 'cluster-a');
            assert.equal(remediationPayloads[0].namespace, 'llmd-ds-1');
            assert.equal(remediationPayloads[0].prepared_plan_id, 'plan-ds-1');
            assert.equal(remediationPayloads[0].storage_volume_id, 'vol-cache-1');
            assert.match(remediationPayloads[0].manifest, /kind: DisaggregatedSet/);
            assert.match(doc.body.textContent, /Orchestration administrator namespace setup/);
            assert.ok(findButton(/Re-check & Deploy/));

            await clickButton(/Re-check & Deploy/);

            assert.equal(verifyPayloads.length, 1);
            assert.equal(verifyPayloads[0].prepared_plan_id, 'plan-ds-1');
            assert.equal(verifyPayloads[0].expected_digest, 'digest-ds-1');
            assert.equal(runAttempts, 2);
            assert.equal(runPayloads[1].prepared_plan_id, 'plan-ds-1');
            assert.equal(runPayloads[1].expected_plan_digest, 'sha256:plan-ds-1');
            assert.equal(runPayloads[1].acknowledge_unknown, false);
            assert.deepEqual(navigated, ['optimization-deployments']);
        },
    );
});

test('EvaluationTaskWizard preserves acknowledgeUnknown=true across 403 bootstrap handoff and verify retry', async (t) => {
    const runPayloads = [];
    const verifyPayloads = [];
    const navigated = [];
    let runAttempts = 0;

    await withWizardDom(
        t,
        {
            entrySource: 'model-market',
            operation: 'create-evaluation',
            initial_step: 'configurations',
            name: 'ds-unknown',
            deployment_name: 'qwen-pd-unk',
            cluster_id: 'cluster-a',
            workloads: [{ model: 'Qwen/Qwen3-8B', guide: 'pd-disaggregation', replicas: 1, tensor_parallel_size: 1 }],
        },
        async (url, options = {}) => {
            const base = baseWizardFetch(url);
            if (base) return base;
            if (url === '/api/v1/deployments/plans') {
                return wizardJson({
                    id: 'plan-ds-unk',
                    digest: 'sha256:plan-ds-unk',
                    preflight: { status: 'unknown', errors: [], unmodeled: ['RuntimeClass inventory restricted'] },
                    cases: [{ namespace: 'llmd-ds-unk', manifest: 'kind: DisaggregatedSet\nmetadata:\n  name: ds-unk\n' }],
                });
            }
            if (url === '/api/v1/deployments/runs') {
                runAttempts += 1;
                runPayloads.push(JSON.parse(options.body));
                if (runAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Orchestration administrator setup required.',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                    }, 403);
                }
                return wizardJson({ id: 'deploy-run-unk', status: 'queued' }, 202);
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                verifyPayloads.push(JSON.parse(options.body));
                return wizardJson({ verified: true, status: 'verified', namespace: 'llmd-ds-unk' });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationTaskWizard, { onNavigate: (view) => navigated.push(view) }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            const editorHost = findDomElements(doc.body, (el) => el.hasAttribute('data-evaluation-configuration-editor'))[0];
            const onPublished = findFiberOnPublished(editorHost);
            await act(async () => {
                await onPublished({ artifacts: [dsArtifact] });
            });

            const checkbox = findDomElements(doc.body, (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.getAttribute('type') === 'checkbox'))[0];
            assert.ok(checkbox, 'Expected unknown acknowledgement checkbox');
            await act(async () => {
                domReactProps(checkbox).onChange({ target: { checked: true } });
            });
            await clickButton(/^Deploy$/);
            assert.equal(runAttempts, 1);

            const handoffCheckbox = findDomElements(doc.body, (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.getAttribute('type') === 'checkbox'))[0];
            assert.equal(Boolean(domReactProps(handoffCheckbox).disabled), true, 'Expected acknowledgeUnknown checkbox to be disabled while adminHandoff is open');

            await clickButton(/Re-check & Deploy/);
            assert.equal(verifyPayloads.length, 1);
            assert.equal(verifyPayloads[0].namespace, 'llmd-ds-unk');
            assert.equal(runAttempts, 2);
            assert.equal(runPayloads[1].acknowledge_unknown, true);
            assert.equal(runPayloads[1].prepared_plan_id, 'plan-ds-unk');
            assert.deepEqual(navigated, ['optimization-deployments']);
        },
    );
});

test('EvaluationTaskWizard DeploymentPlanReview forwards handoffNamespace and handoffActionLabel', () => {
    const html = renderToStaticMarkup(createElement(DeploymentPlanReview, {
        preparedReview: {
            workflow: { id: 'wf-1' },
            plan: {
                id: 'plan-1',
                digest: 'sha256:plan-1',
                cases: [{ namespace: 'llmd-ds-1', manifest: 'kind: DisaggregatedSet' }],
                preflight: { status: 'pass', errors: [], unmodeled: [] },
            },
        },
        acknowledgeUnknown: false,
        setAcknowledgeUnknown() {},
        onClose() {},
        onConfirm() {},
        adminHandoff: {
            namespace: 'llmd-ds-1',
            namespaces: ['llmd-ds-1', 'llmd-ds-2'],
            report: { status: 'admin_required', adminOperations: [{ id: 'ns.create', title: 'Create namespace' }] },
            script: '#!/usr/bin/env bash\nkubectl apply -f -',
            identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
        },
        handoffNamespace: 'llmd-ds-1 (+1 more)',
        handoffActionLabel: 'Re-check & Start Evaluation',
        onVerifyBootstrap() {},
        onRegenerateBootstrap() {},
        onDismissAdminHandoff() {},
    }));
    assert.match(html, /llmd-ds-1 \(\+1 more\)/);
    assert.match(html, /Re-check &amp; Start Evaluation/);
});

const nonDsArtifactA = {
    artifact_id: 'art-eval-1',
    deployable_configuration: {
        provider_ref: 'optimized-baseline',
        content: {
            model: { name: 'Qwen/Qwen3-8B' },
            runtime: { modelServer: 'vllm', modelSource: 'huggingface', image: '' },
            decode: { replicaCount: 1, tensorParallelSize: 1, maxModelLen: 8192 },
            officialGuide: { renderedManifest: 'kind: Deployment\nmetadata:\n  name: eval-1\n' },
        },
        provenance: { cluster_ref: { id: 'cluster-a', session_id: 'sess-1' }, placement: { replicas: 'prefer-same-node' } },
    },
};

const nonDsArtifactB = {
    artifact_id: 'art-eval-2',
    deployable_configuration: {
        provider_ref: 'tiered-prefix-cache',
        content: {
            model: { name: 'Qwen/Qwen3-8B' },
            runtime: { modelServer: 'vllm', modelSource: 'huggingface', image: '' },
            decode: { replicaCount: 1, tensorParallelSize: 1, maxModelLen: 8192 },
            officialGuide: { renderedManifest: 'kind: Deployment\nmetadata:\n  name: eval-2\n' },
        },
        provenance: { cluster_ref: { id: 'cluster-a', session_id: 'sess-1' }, placement: { replicas: 'prefer-same-node' } },
    },
};

test('EvaluationTaskWizard non-DS evaluation create catches 403 multi-target setup, verifies per-target digests, and resubmits with target_namespaces', async (t) => {
    const createPayloads = [];
    const remediationPayloads = [];
    const verifyPayloads = [];
    const navigated = [];
    let createAttempts = 0;

    await withWizardDom(
        t,
        {
            entrySource: 'evaluation-setup',
            operation: 'create-evaluation',
            initial_step: 'configurations',
            name: 'eval-multi',
            deployment_name: 'qwen-eval',
            cluster_id: 'cluster-a',
            workloads: [{ model: 'Qwen/Qwen3-8B', guide: 'optimized-baseline', replicas: 1, tensor_parallel_size: 1 }],
        },
        async (url, options = {}) => {
            if (url.startsWith('/api/v1/configurations/capabilities')) {
                return wizardJson({
                    providers: [
                        { id: 'optimized-baseline', label: 'Optimized Baseline' },
                        { id: 'tiered-prefix-cache', label: 'Tiered Prefix Cache' },
                    ],
                });
            }
            if (url.startsWith('/api/guide-planning/catalog')) {
                return wizardJson({
                    guides: [
                        { id: 'optimized-baseline', label: 'Optimized Baseline' },
                        { id: 'tiered-prefix-cache', label: 'Tiered Prefix Cache' },
                    ],
                });
            }
            const base = baseWizardFetch(url);
            if (base) return base;
            if (url === '/api/v1/evaluate/evaluations') {
                createAttempts += 1;
                createPayloads.push(JSON.parse(options.body));
                if (createAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Orchestration administrator setup required for 2 namespaces.',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-eval-1',
                        namespaces: ['llmd-eval-1', 'llmd-eval-2'],
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        adminOperations: [{ id: 'llmd-eval-1:ns.create', title: 'Create namespace' }],
                        targets: [
                            { key: 'setup-1:guide', namespace: 'llmd-eval-1', providerRef: 'optimized-baseline', usesRouter: true, sufficient: false },
                            { key: 'setup-2:guide', namespace: 'llmd-eval-2', providerRef: 'tiered-prefix-cache', usesRouter: true, sufficient: false },
                        ],
                    }, 403);
                }
                return wizardJson({ id: 'wf-multi-1', status: 'queued' }, 202);
            }
            if (url === '/api/v1/deployments/permission-remediation') {
                remediationPayloads.push(JSON.parse(options.body));
                return wizardJson({
                    script: '#!/usr/bin/env bash\necho multi-bootstrap',
                    scriptFilename: 'lens-deploy-bootstrap-batch-12345678.sh',
                    namespace: 'llmd-eval-1',
                    namespaces: ['llmd-eval-1', 'llmd-eval-2'],
                    bootstrapDigest: 'combined-digest-must-not-be-used-per-target',
                    targets: [
                        { key: 'setup-1:guide', namespace: 'llmd-eval-1', bootstrapDigest: 'digest-target-1', alreadySufficient: false },
                        { key: 'setup-2:guide', namespace: 'llmd-eval-2', bootstrapDigest: 'digest-target-2', alreadySufficient: false },
                    ],
                });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                verifyPayloads.push(JSON.parse(options.body));
                if (verifyPayloads.length === 1) {
                    return wizardJson({
                        verified: false,
                        status: 'stale',
                        namespace: 'llmd-eval-1',
                        namespaces: ['llmd-eval-1', 'llmd-eval-2'],
                        message: 'Target 1 marker is stale and target 2 is pending.',
                        targets: [
                            { key: 'setup-1:guide', namespace: 'llmd-eval-1', verified: false, status: 'stale', bootstrapDigest: 'observed-stale-digest' },
                            { key: 'setup-2:guide', namespace: 'llmd-eval-2', verified: false, status: 'pending', bootstrapDigest: null },
                        ],
                    });
                }
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-eval-1',
                    namespaces: ['llmd-eval-1', 'llmd-eval-2'],
                    targets: [
                        { key: 'setup-1:guide', namespace: 'llmd-eval-1', verified: true },
                        { key: 'setup-2:guide', namespace: 'llmd-eval-2', verified: true },
                    ],
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, findButton, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationTaskWizard, { onNavigate: (view) => navigated.push(view) }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            const editorHost = findDomElements(doc.body, (el) => el.hasAttribute('data-evaluation-configuration-editor'))[0];
            const onPublished = findFiberOnPublished(editorHost);
            await act(async () => {
                await onPublished({ artifacts: [nonDsArtifactA, nonDsArtifactB] });
            });

            await clickButton(/Continue to Benchmark/);
            await clickButton(/^Continue$/);
            await clickButton(/Start Evaluation/);

            assert.equal(createAttempts, 1);
            assert.equal(remediationPayloads.length, 1);
            assert.equal(remediationPayloads[0].cluster_id, 'cluster-a');
            assert.equal(remediationPayloads[0].targets.length, 2);
            assert.match(doc.body.textContent, /llmd-eval-1 \(\+1 more\)/);
            assert.ok(findButton(/Re-check & Start Evaluation/));

            // First verify fails as stale/pending; expected per-target digests must be preserved (never overwritten by stale/null observed digests)
            await clickButton(/Re-check & Start Evaluation/);
            assert.equal(verifyPayloads.length, 1);
            assert.equal(verifyPayloads[0].targets[0].expected_digest, 'digest-target-1');
            assert.equal(verifyPayloads[0].targets[1].expected_digest, 'digest-target-2');
            assert.equal(createAttempts, 1);
            assert.match(doc.body.textContent, /Target 1 marker is stale/);

            // Second verify must send the exact same original expected digests
            await clickButton(/Re-check & Start Evaluation/);

            assert.equal(verifyPayloads.length, 2);
            assert.equal('expected_digest' in verifyPayloads[1], false);
            assert.equal(verifyPayloads[1].targets[0].expected_digest, 'digest-target-1');
            assert.equal(verifyPayloads[1].targets[1].expected_digest, 'digest-target-2');
            assert.equal(createAttempts, 2);
            assert.deepEqual(createPayloads[1].target_namespaces, {
                'setup-1:guide': 'llmd-eval-1',
                'setup-2:guide': 'llmd-eval-2',
            });
            assert.deepEqual(navigated, ['optimization-evaluate']);
        },
    );
});

test('EvaluationTaskWizard DS awaiting_review auto-confirm and manual confirm handle 403 setup handoff', async (t) => {
    const dsClusterArtifact = {
        ...dsArtifact,
        deployable_configuration: {
            ...dsArtifact.deployable_configuration,
            content: {
                ...dsArtifact.deployable_configuration.content,
                runtime: { modelServer: 'vllm', modelSource: 'huggingface', image: '' },
            },
            provenance: { ...dsArtifact.deployable_configuration.provenance, cluster_ref: { id: 'cluster-a', session_id: 'sess-1' } },
        },
    };
    const confirmPayloads = [];
    const verifyPayloads = [];
    const navigated = [];
    let confirmAttempts = 0;

    await withWizardDom(
        t,
        {
            entrySource: 'evaluation-setup',
            operation: 'create-evaluation',
            initial_step: 'configurations',
            name: 'eval-ds',
            deployment_name: 'qwen-ds-eval',
            cluster_id: 'cluster-a',
            workloads: [{ model: 'Qwen/Qwen3-8B', guide: 'pd-disaggregation', replicas: 1, tensor_parallel_size: 1 }],
        },
        async (url, options = {}) => {
            const base = baseWizardFetch(url);
            if (base) return base;
            if (url === '/api/v1/evaluate/evaluations') {
                return wizardJson({
                    id: 'wf-ds-1',
                    cluster_id: 'cluster-a',
                    status: 'awaiting_review',
                    prepared_plans: [{
                        id: 'plan-ds-eval',
                        digest: 'sha256:plan-ds-eval',
                        cases: [{ namespace: 'llmd-ds-eval', manifest: 'kind: DisaggregatedSet' }],
                        preflight: { status: 'pass', errors: [], unmodeled: [] },
                    }],
                }, 202);
            }
            if (url === '/api/v1/evaluate/evaluations/wf-ds-1/confirm') {
                confirmAttempts += 1;
                confirmPayloads.push(JSON.parse(options.body));
                if (confirmAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'DS namespace setup required.',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-ds-eval',
                        namespaces: ['llmd-ds-eval'],
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-ds-eval', preparedPlanId: 'plan-ds-eval', sufficient: false }],
                    }, 403);
                }
                return wizardJson({ id: 'wf-ds-1', status: 'queued' });
            }
            if (url === '/api/v1/deployments/permission-remediation') {
                return wizardJson({
                    script: '#!/usr/bin/env bash\nkubectl apply -f -',
                    namespace: 'llmd-ds-eval',
                    namespaces: ['llmd-ds-eval'],
                    targets: [{ key: 'setup-1:guide', namespace: 'llmd-ds-eval', bootstrapDigest: 'digest-ds-eval', alreadySufficient: false }],
                });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                verifyPayloads.push(JSON.parse(options.body));
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-ds-eval',
                    targets: [{ key: 'setup-1:guide', namespace: 'llmd-ds-eval', verified: true }],
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationTaskWizard, { onNavigate: (view) => navigated.push(view) }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            const editorHost = findDomElements(doc.body, (el) => el.hasAttribute('data-evaluation-configuration-editor'))[0];
            const onPublished = findFiberOnPublished(editorHost);
            await act(async () => {
                await onPublished({ artifacts: [dsClusterArtifact] });
            });

            await clickButton(/Continue to Benchmark/);
            await clickButton(/^Continue$/);
            await clickButton(/Start Evaluation/);

            assert.equal(confirmAttempts, 1);
            assert.match(doc.body.textContent, /Orchestration administrator namespace setup/);
            assert.match(doc.body.textContent, /Deployment checks/);

            await clickButton(/Re-check & Start Evaluation/);

            assert.equal(verifyPayloads.length, 1);
            assert.equal(verifyPayloads[0].targets[0].expected_digest, 'digest-ds-eval');
            assert.equal(confirmAttempts, 2);
            assert.deepEqual(confirmPayloads[1].target_namespaces, { 'setup-1:guide': 'llmd-ds-eval' });
            assert.deepEqual(navigated, ['optimization-evaluate']);
        },
    );
});

test('EvaluationTaskWizard DS awaiting_review manual confirm preserves acknowledgeUnknown across 403 handoff', async (t) => {
    const dsClusterArtifact = {
        ...dsArtifact,
        deployable_configuration: {
            ...dsArtifact.deployable_configuration,
            content: {
                ...dsArtifact.deployable_configuration.content,
                runtime: { modelServer: 'vllm', modelSource: 'huggingface', image: '' },
            },
            provenance: { ...dsArtifact.deployable_configuration.provenance, cluster_ref: { id: 'cluster-a', session_id: 'sess-1' } },
        },
    };
    const manualConfirmPayloads = [];
    const manualNavigated = [];
    let manualConfirmAttempts = 0;

    await withWizardDom(
        t,
        {
            entrySource: 'evaluation-setup',
            operation: 'create-evaluation',
            initial_step: 'configurations',
            name: 'eval-ds-unk',
            deployment_name: 'qwen-ds-unk',
            cluster_id: 'cluster-a',
            workloads: [{ model: 'Qwen/Qwen3-8B', guide: 'pd-disaggregation', replicas: 1, tensor_parallel_size: 1 }],
        },
        async (url, options = {}) => {
            const base = baseWizardFetch(url);
            if (base) return base;
            if (url === '/api/v1/evaluate/evaluations') {
                return wizardJson({
                    id: 'wf-ds-unk',
                    cluster_id: 'cluster-a',
                    status: 'awaiting_review',
                    prepared_plans: [{
                        id: 'plan-ds-unk',
                        digest: 'sha256:plan-ds-unk',
                        cases: [{ namespace: 'llmd-ds-unk', manifest: 'kind: DisaggregatedSet' }],
                        preflight: { status: 'unknown', errors: [], unmodeled: ['RuntimeClass unknown'] },
                    }],
                }, 202);
            }
            if (url === '/api/v1/evaluate/evaluations/wf-ds-unk/confirm') {
                manualConfirmAttempts += 1;
                manualConfirmPayloads.push(JSON.parse(options.body));
                if (manualConfirmAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'DS namespace setup required.',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-ds-unk',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-ds-unk', sufficient: false }],
                    }, 403);
                }
                return wizardJson({ id: 'wf-ds-unk', status: 'queued' });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-ds-unk',
                    targets: [{ key: 'setup-1:guide', namespace: 'llmd-ds-unk', verified: true }],
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationTaskWizard, { onNavigate: (view) => manualNavigated.push(view) }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            const editorHost = findDomElements(doc.body, (el) => el.hasAttribute('data-evaluation-configuration-editor'))[0];
            const onPublished = findFiberOnPublished(editorHost);
            await act(async () => {
                await onPublished({ artifacts: [dsClusterArtifact] });
            });

            await clickButton(/Continue to Benchmark/);
            await clickButton(/^Continue$/);
            await clickButton(/Start Evaluation/);

            assert.equal(manualConfirmAttempts, 0);
            const checkbox = findDomElements(doc.body, (el) => el.tagName === 'INPUT' && (el.type === 'checkbox' || el.getAttribute('type') === 'checkbox'))[0];
            assert.ok(checkbox);
            await act(async () => {
                domReactProps(checkbox).onChange({ target: { checked: true } });
            });
            await clickButton(/^Deploy$/);
            assert.equal(manualConfirmAttempts, 1);

            await clickButton(/Re-check & Start Evaluation/);
            assert.equal(manualConfirmAttempts, 2);
            assert.equal(manualConfirmPayloads[1].acknowledge_unknown, true);
            assert.deepEqual(manualConfirmPayloads[1].target_namespaces, { 'setup-1:guide': 'llmd-ds-unk' });
            assert.deepEqual(manualNavigated, ['optimization-evaluate']);
        },
    );
});

test('OptimizationEvaluationDetails handles resumed awaiting_review confirm handoff, pending_admin_cleanup badge, and retry handoff', async (t) => {
    const confirmBodies = [];
    const retryBodies = [];
    let confirmAttempts = 0;
    let retryAttempts = 0;
    let workflowStatus = 'awaiting_review';

    await withWizardDom(
        t,
        {},
        async (url, options = {}) => {
            if (url === '/api/v1/evaluate/workflow-runs/wf-det-1/details') {
                return wizardJson({
                    workflow: {
                        id: 'wf-det-1',
                        name: 'Eval Details Handoff',
                        cluster_id: 'cluster-a',
                        status: workflowStatus,
                        prepared_plans: [{
                            id: 'plan-det-1',
                            digest: 'sha256:det-1',
                            cases: [{ namespace: 'llmd-det-1', manifest: 'kind: DisaggregatedSet' }],
                            preflight: { status: 'pass', errors: [], unmodeled: [] },
                        }],
                    },
                    cases: [{
                        case: {
                            id: 'case-1',
                            status: 'failed',
                            deployment_run_id: 'dep-run-1',
                            cleanup_status: 'pending_admin_cleanup',
                            cleanup_handoff: { namespace: 'llmd-det-1' },
                            configuration: { guide: 'optimized-baseline', model: 'Qwen/Qwen3-8B' },
                        },
                        deployment_cases: [{
                            id: 'dep-case-1',
                            guide: 'optimized-baseline',
                            status: 'failed',
                            namespace: 'llmd-det-1',
                            execution_id: 'exec-1',
                            execution_status: 'cleaned',
                        }],
                    }],
                });
            }
            if (url === '/api/v1/evaluate/evaluations/wf-det-1/confirm') {
                confirmAttempts += 1;
                confirmBodies.push(JSON.parse(options.body));
                if (confirmAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Setup required',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-det-1',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-det-1', sufficient: false }],
                    }, 403);
                }
                workflowStatus = 'failed';
                return wizardJson({ id: 'wf-det-1', status: 'queued' });
            }
            if (url === '/api/v1/evaluate/workflow-runs/wf-det-1/retry') {
                retryAttempts += 1;
                retryBodies.push(options.body ? JSON.parse(options.body) : null);
                if (retryAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Fresh namespace setup required for retry.',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-det-1-2',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-det-1-2', sufficient: false }],
                    }, 403);
                }
                return wizardJson({ id: 'wf-det-1', status: 'queued' });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                const body = JSON.parse(options.body);
                const ns = body.targets?.[0]?.namespace || body.namespace || 'llmd-det-1';
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: ns,
                    targets: [{ key: 'setup-1:guide', namespace: ns, verified: true }],
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            globalThis.window.location.search = '?evaluationId=wf-det-1&runKind=workflow';
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(OptimizationEvaluationDetails, { onNavigate() {} }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            await clickButton(/Review deployment plans/);
            await clickButton(/^Deploy$/);
            assert.equal(confirmAttempts, 1);
            await clickButton(/Re-check & Start Evaluation/);
            assert.equal(confirmAttempts, 2);
            assert.deepEqual(confirmBodies[1].target_namespaces, { 'setup-1:guide': 'llmd-det-1' });

            await clickButton(/^Deployments$/);
            assert.match(doc.body.textContent, /Pending admin cleanup/);
            await clickButton(/^Retry$/);
            assert.equal(retryAttempts, 1);
            assert.equal(retryBodies[0], null);
            await clickButton(/Re-check & Retry Evaluation/);
            assert.equal(retryAttempts, 2);
            assert.deepEqual(retryBodies[1], { target_namespaces: { 'setup-1:guide': 'llmd-det-1-2' } });
        },
    );
});

test('OptimizationEvaluationDetails surfaces post-verify retryEvaluationWorkflow failure in page alert', async (t) => {
    let retryAttempts = 0;
    await withWizardDom(
        t,
        {},
        async (url) => {
            if (url === '/api/v1/evaluate/workflow-runs/wf-det-err/details') {
                return wizardJson({
                    workflow: { id: 'wf-det-err', name: 'Eval Retry Error', cluster_id: 'cluster-a', status: 'failed' },
                    cases: [{
                        case: {
                            id: 'case-1',
                            status: 'failed',
                            deployment_run_id: 'dep-run-1',
                            cleanup_status: 'pending_admin_cleanup',
                            cleanup_handoff: { namespace: 'llmd-det-1' },
                            configuration: { guide: 'optimized-baseline', model: 'Qwen/Qwen3-8B' },
                        },
                        deployment_cases: [{
                            id: 'dep-case-1',
                            guide: 'optimized-baseline',
                            status: 'failed',
                            namespace: 'llmd-det-1',
                            execution_id: 'exec-1',
                        }],
                    }],
                });
            }
            if (url === '/api/v1/evaluate/workflow-runs/wf-det-err/retry') {
                retryAttempts += 1;
                if (retryAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Setup required',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-det-1-2',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-det-1-2', sufficient: false }],
                    }, 403);
                }
                return wizardJson({ detail: 'Cluster session expired during retry' }, 401);
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-det-1-2',
                    targets: [{ key: 'setup-1:guide', namespace: 'llmd-det-1-2', verified: true }],
                });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            globalThis.window.location.search = '?evaluationId=wf-det-err&runKind=workflow';
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(OptimizationEvaluationDetails, { onNavigate() {} }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            await clickButton(/^Deployments$/);
            await clickButton(/^Retry$/);
            await clickButton(/Re-check & Retry Evaluation/);
            assert.equal(retryAttempts, 2);
            assert.match(doc.body.textContent, /Cluster session expired during retry/);
        },
    );
});

test('EvaluationDashboard opens shared Modal handoff for workflow retry (403) and delete (409 cleanup)', async (t) => {
    const retryBodies = [];
    const cleanupVerifyBodies = [];
    let retryAttempts = 0;
    let deleteAttempts = 0;

    await withWizardDom(
        t,
        {},
        async (url, options = {}) => {
            if (url === '/api/v1/evaluate/workflow-runs') {
                return wizardJson({
                    items: [{
                        id: 'wf-dash-1',
                        kind: 'workflow',
                        name: 'Dashboard Eval 1',
                        cluster_id: 'cluster-a',
                        status: 'failed',
                        cases: [{ id: 'c1', kind: 'guide', status: 'failed' }],
                    }],
                });
            }
            if (url === '/api/v1/evaluate/runs') return wizardJson({ items: [] });
            if (url.startsWith('/api/v1/deployments/executions?')) return wizardJson([]);
            if (url === '/api/v1/evaluate/workflow-runs/wf-dash-1/retry') {
                retryAttempts += 1;
                retryBodies.push(options.body ? JSON.parse(options.body) : null);
                if (retryAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_admin_setup_required',
                        detail: 'Setup required',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-dash-1',
                        identity: { kind: 'ServiceAccount', name: 'lens-edit', namespace: 'lens-edit', overrideRequired: false },
                        script: '#!/usr/bin/env bash\nkubectl apply -f -',
                        targets: [{ key: 'setup-1:guide', namespace: 'llmd-dash-1', sufficient: false }],
                    }, 403);
                }
                return wizardJson({ id: 'wf-dash-1', status: 'queued' });
            }
            if (url === '/api/v1/deployments/admin-handoff/verify') {
                return wizardJson({
                    verified: true,
                    status: 'verified',
                    namespace: 'llmd-dash-1',
                    targets: [{ key: 'setup-1:guide', namespace: 'llmd-dash-1', verified: true }],
                });
            }
            if (url === '/api/v1/evaluate/workflow-runs/wf-dash-1' && options.method === 'DELETE') {
                deleteAttempts += 1;
                if (deleteAttempts === 1) {
                    return wizardJson({
                        code: 'deployment_cleanup_permission_denied',
                        detail: 'Namespace deletion requires administrator.',
                        executionId: 'exec-dash-1',
                        clusterId: 'cluster-a',
                        namespace: 'llmd-dash-1',
                        phase1Completed: true,
                        adminCleanup: {
                            cleanupDigest: 'cleanup-digest-1',
                            operations: [{ id: 'ns.delete', kind: 'Namespace', name: 'llmd-dash-1' }],
                            script: '#!/usr/bin/env bash\nkubectl delete ns llmd-dash-1',
                            scriptFilename: 'cleanup-llmd-dash-1.sh',
                            canVerifyMarker: true,
                        },
                    }, 409);
                }
                return wizardJson({ deleted: true });
            }
            if (url === '/api/v1/deployments/executions/exec-dash-1/cleanup-verify') {
                cleanupVerifyBodies.push(JSON.parse(options.body));
                return wizardJson({ deleted: true, verified: true, status: 'deleted' });
            }
            return wizardJson({});
        },
        async ({ root, doc, clickButton }) => {
            await act(async () => {
                root.render(
                    createElement(
                        AuthContext.Provider,
                        { value: { can: () => true } },
                        createElement(EvaluationDashboard, { onNavigate() {} }),
                    ),
                );
            });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });

            // Trigger Retry from task card
            const retryBtn = findDomElements(doc.body, (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Retry task')[0];
            assert.ok(retryBtn, 'Expected Retry button on task card');
            await act(async () => {
                await domReactProps(retryBtn).onClick?.({ preventDefault() {}, stopPropagation() {} });
            });
            assert.equal(retryAttempts, 1);
            await clickButton(/Re-check & Retry Evaluation/);
            assert.equal(retryAttempts, 2);
            assert.deepEqual(retryBodies[1], { target_namespaces: { 'setup-1:guide': 'llmd-dash-1' } });

            // Trigger Delete from task card (onClick fires confirmDelete without returning the promise)
            const deleteBtn = findDomElements(doc.body, (el) => el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'Delete task')[0];
            assert.ok(deleteBtn, 'Expected Delete button on task card');
            await act(async () => {
                domReactProps(deleteBtn).onClick?.({ preventDefault() {}, stopPropagation() {} });
                await new Promise((resolve) => setTimeout(resolve, 15));
            });
            await clickButton(/^Delete$/);
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 25));
            });
            assert.equal(deleteAttempts, 1);
            assert.match(doc.body.textContent, /Orchestration administrator namespace cleanup/);
            await clickButton(/Re-check & Delete/);
            assert.equal(cleanupVerifyBodies.length, 1);
            assert.equal(cleanupVerifyBodies[0].cleanupDigest, 'cleanup-digest-1');
            assert.equal(cleanupVerifyBodies[0].deleteRecordOnVerify, true);
            assert.equal(deleteAttempts, 2);
        },
    );
});