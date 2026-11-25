import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MONITORING_NAMESPACE,
    monitoringLinkTarget,
    normalizeMonitoringNamespace,
    openMonitoringLink,
    resolveClusterMonitoringNamespace,
    resolveEffectiveMonitoringNamespace,
    resolveMonitoringNamespaceOverride,
} from './monitoringLinks.js';
import {
    getAcceleratorAdminScript,
    getAcceleratorLinks,
    getAcceleratorStatus,
    installAccelerator,
    preflightAcceleratorInstall,
    recheckAccelerator,
} from './acceleratorObservabilityBackend.js';
import {
    getClusterStackLinks,
    getClusterStackStatus,
    getDeploymentFlowMap,
} from './clusterMonitoringStackBackend.js';
import {
    checkPassed,
    checkLabel,
    checkTone,
    clusterHealthIsAbnormal,
    describeMonitoringNotice,
    getNonAdminAcceleratorAction,
    getNonAdminClusterStackAction,
    isOptionalAbsentComponent,
    monitoringCardDisplay,
    monitoringIsAbnormal,
    monitoringMetricStatus,
    summarizeMonitoringComponents,
} from './preflightPresentation.js';

test('monitoring links preserve advertised dashboard paths and unavailable reasons', () => {
    assert.equal(
        monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, local_port: 3001, dashboard_path: '/d/gpu' }] },
            'grafana',
            'lens.local',
        ),
        'http://lens.local:3001/d/gpu',
    );
    assert.throws(
        () => monitoringLinkTarget({ links: [{ kind: 'grafana', message: 'No service' }] }, 'grafana', 'lens.local'),
        /No service/,
    );
});

test('monitoring links use direct http/https URLs and join dashboard_path and pathSuffix cleanly', () => {
    assert.equal(
        monitoringLinkTarget(
            { links: [{ kind: 'prometheus', available: true, url: 'https://prom.example.com' }] },
            'prometheus',
            'lens.local',
        ),
        'https://prom.example.com/',
    );

    assert.equal(
        monitoringLinkTarget(
            {
                links: [{
                    kind: 'grafana',
                    available: true,
                    url: 'https://grafana.example.com/subpath/?orgId=1',
                    dashboard_path: '/d/llm-d-performance/llm-d-performance-dashboard',
                    local_port: 3001,
                }],
            },
            'grafana',
            'lens.local',
            { pathSuffix: '?var-namespace=prod' },
        ),
        'https://grafana.example.com/subpath/d/llm-d-performance/llm-d-performance-dashboard?orgId=1&var-namespace=prod',
    );

    assert.equal(
        monitoringLinkTarget(
            {
                links: [{
                    kind: 'grafana',
                    available: true,
                    url: 'http://10.0.0.5:30300/d/gpu/',
                    dashboard_path: '/d/gpu',
                }],
            },
            'grafana',
            'lens.local',
            { pathSuffix: '/panel?var-namespace=inference' },
        ),
        'http://10.0.0.5:30300/d/gpu/panel?var-namespace=inference',
    );
});

test('monitoring links support fallbackPath, queryParams, and local_port fallback with pathSuffix', () => {
    assert.equal(
        monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, url: 'https://grafana.example.com/' }] },
            'grafana',
            'lens.local',
            {
                fallbackPath: '/d/llm-d-performance/llm-d-performance-dashboard',
                queryParams: { 'var-namespace': 'vllm-ns' },
            },
        ),
        'https://grafana.example.com/d/llm-d-performance/llm-d-performance-dashboard?var-namespace=vllm-ns',
    );

    assert.equal(
        monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, local_port: 3001, dashboard_path: '/d/perf/' }] },
            'grafana',
            'lens.local',
            { pathSuffix: '?var-namespace=staging' },
        ),
        'http://lens.local:3001/d/perf?var-namespace=staging',
    );

    assert.equal(
        monitoringLinkTarget(
            { links: [{ kind: 'prometheus', available: true, local_port: 9090 }] },
            'prometheus',
            'lens.local',
        ),
        'http://lens.local:9090',
    );
});

test('monitoring links reject unsafe URL schemes and missing endpoints', () => {
    assert.throws(
        () => monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, url: 'javascript:alert(1)', local_port: 3001 }] },
            'grafana',
            'lens.local',
        ),
        /Unsupported dashboard URL scheme/,
    );
    assert.throws(
        () => monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, url: 'data:text/html,<script>alert(1)</script>' }] },
            'grafana',
            'lens.local',
        ),
        /Unsupported dashboard URL scheme/,
    );
    assert.throws(
        () => monitoringLinkTarget(
            { links: [{ kind: 'grafana', available: true, url: 'not a valid url' }] },
            'grafana',
            'lens.local',
        ),
        /invalid/i,
    );
    assert.throws(
        () => monitoringLinkTarget(
            { links: [{ kind: 'prometheus', available: true }] },
            'prometheus',
            'lens.local',
        ),
        /not available/,
    );
    for (const badPort of [0, -1, 65536, 3001.5, '3001', Number.NaN]) {
        assert.throws(
            () => monitoringLinkTarget(
                { links: [{ kind: 'prometheus', available: true, local_port: badPort }] },
                'prometheus',
                'lens.local',
            ),
            /not available/,
        );
    }
});

test('openMonitoringLink forwards options to window.open', () => {
    const previousWindow = globalThis.window;
    const calls = [];
    globalThis.window = {
        location: { hostname: 'lens.local' },
        open: (...args) => calls.push(args),
    };
    try {
        openMonitoringLink(
            { links: [{ kind: 'grafana', available: true, url: 'https://grafana.example.com/', dashboard_path: '/d/perf' }] },
            'grafana',
            { pathSuffix: '?var-namespace=demo' },
        );
        assert.deepEqual(calls, [
            ['https://grafana.example.com/d/perf?var-namespace=demo', '_blank', 'noopener,noreferrer'],
        ]);
    } finally {
        globalThis.window = previousWindow;
    }
});

test('preflight keeps advisory failures distinct from blockers', () => {
    assert.equal(checkPassed({ status: 'ready' }), true);
    assert.equal(checkTone({ blocking: false }), 'warning');
    assert.equal(checkLabel({ blocking: false }), 'Missing');
    assert.equal(checkTone({ blocking: true }), 'danger');
});

test('isOptionalAbsentComponent detects optional flag and optional missing diagnostics only', () => {
    assert.equal(isOptionalAbsentComponent(null), false);
    assert.equal(isOptionalAbsentComponent({ name: 'grafana', status: 'missing', optional: true }), true);
    assert.equal(
        isOptionalAbsentComponent({
            name: 'grafana',
            status: 'missing',
            diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }],
        }),
        true,
    );
    assert.equal(
        isOptionalAbsentComponent({
            name: 'accelerator_exporters',
            status: 'missing',
            diagnostics: [{ code: 'ACCELERATOR_METRICS_NOT_DETECTED' }],
        }),
        true,
    );
    assert.equal(
        isOptionalAbsentComponent({
            name: 'grafana',
            status: 'missing',
            diagnostics: [{ code: 'GRAFANA_URL_UNSET' }],
        }),
        false,
    );
    assert.equal(
        isOptionalAbsentComponent({
            name: 'grafana',
            status: 'degraded',
            diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }],
        }),
        false,
    );
});

test('summarizeMonitoringComponents excludes optional-absent components across CPU-only, GPU, and existing modes', () => {
    const existingCpuOnly = [
        { name: 'prometheus', status: 'ready' },
        { name: 'grafana', status: 'missing', diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }] },
        { name: 'kube_state_metrics', status: 'ready' },
        { name: 'node_exporter', status: 'ready' },
        { name: 'accelerator_exporters', status: 'missing', diagnostics: [{ code: 'ACCELERATOR_METRICS_NOT_DETECTED' }] },
    ];
    const cpuSummary = summarizeMonitoringComponents(existingCpuOnly);
    assert.equal(cpuSummary.ready, 3);
    assert.equal(cpuSummary.desired, 3);
    assert.equal(cpuSummary.affected.length, 0);

    const managedNonAdminUnsetGrafana = [
        { name: 'prometheus', status: 'ready' },
        { name: 'grafana', status: 'missing', diagnostics: [{ code: 'GRAFANA_URL_UNSET' }] },
        { name: 'kube_state_metrics', status: 'ready' },
        { name: 'node_exporter', status: 'ready' },
        { name: 'accelerator_exporters', status: 'missing', diagnostics: [{ code: 'ACCELERATOR_METRICS_NOT_DETECTED' }] },
    ];
    const nonAdminSummary = summarizeMonitoringComponents(managedNonAdminUnsetGrafana);
    assert.equal(nonAdminSummary.ready, 3);
    assert.equal(nonAdminSummary.desired, 4);
    assert.deepEqual(nonAdminSummary.affected.map((c) => c.name), ['grafana']);

    const emptySummary = summarizeMonitoringComponents(null);
    assert.deepEqual(emptySummary, { ready: 0, desired: 0, counted: [], affected: [] });
});

test('monitoringMetricStatus maps all statuses and distinguishes Not configured vs Not installed', () => {
    assert.deepEqual(monitoringMetricStatus({ status: 'ready' }), { status: 'ready', label: 'Ready' });
    assert.deepEqual(monitoringMetricStatus({ status: 'external' }), { status: 'external', label: 'External' });
    assert.deepEqual(monitoringMetricStatus({ status: 'installing' }), { status: 'installing', label: 'Installing' });
    assert.deepEqual(monitoringMetricStatus({ status: 'progressing' }), { status: 'progressing', label: 'Progressing' });
    assert.deepEqual(monitoringMetricStatus({ status: 'degraded' }), { status: 'degraded', label: 'Degraded' });
    assert.deepEqual(monitoringMetricStatus({ status: 'unreachable' }), { status: 'unreachable', label: 'Unreachable' });
    assert.deepEqual(monitoringMetricStatus({ status: 'unsupported' }), { status: 'inactive', label: 'Unsupported' });
    assert.deepEqual(monitoringMetricStatus({ status: 'failed' }), { status: 'failed', label: 'Failed' });
    assert.deepEqual(monitoringMetricStatus(null), { status: 'neutral', label: 'Unknown' });

    assert.deepEqual(
        monitoringMetricStatus({ status: 'absent', accessMode: 'admin', monitoringMode: 'managed' }),
        { status: 'absent', label: 'Not installed' },
    );
    assert.deepEqual(
        monitoringMetricStatus({ status: 'absent', accessMode: 'non_admin', monitoringMode: 'managed' }),
        { status: 'absent', label: 'Not configured' },
    );
    assert.deepEqual(
        monitoringMetricStatus({ status: 'absent', accessMode: 'admin', monitoringMode: 'existing' }),
        { status: 'absent', label: 'Not configured' },
    );
});

test('monitoringIsAbnormal and clusterHealthIsAbnormal handle monitoringRequired and transient states', () => {
    for (const okStatus of ['ready', 'external', 'installing', 'progressing', 'absent', 'unsupported']) {
        assert.equal(monitoringIsAbnormal({ status: okStatus }), false);
    }
    for (const badStatus of ['degraded', 'unreachable', 'failed']) {
        assert.equal(monitoringIsAbnormal({ status: badStatus }), true);
    }

    assert.equal(clusterHealthIsAbnormal(null), null);
    assert.equal(
        clusterHealthIsAbnormal({
            kubernetes: {
                monitoringRequired: true,
                components: { monitoring: { status: 'absent', installed: false } },
            },
        }),
        false,
    );
    assert.equal(
        clusterHealthIsAbnormal({
            kubernetes: {
                monitoringRequired: true,
                components: { monitoring: { status: 'degraded', installed: false } },
            },
        }),
        true,
    );
    assert.equal(
        clusterHealthIsAbnormal({
            kubernetes: {
                monitoringRequired: false,
                nodes: [{ ready: true, cpu: 8, memoryBytes: 16e9, gpuCount: 1 }],
                hardware: { cpuCores: 8, memoryBytes: 16e9, gpuCount: 1, diskUsagePercent: 40 },
                components: { monitoring: { status: 'installing', installed: true } },
            },
        }),
        false,
    );
    assert.equal(
        clusterHealthIsAbnormal({
            kubernetes: {
                monitoringRequired: false,
                nodes: [{ ready: true, cpu: 8, memoryBytes: 16e9, gpuCount: 1 }],
                hardware: { cpuCores: 8, memoryBytes: 16e9, gpuCount: 1, diskUsagePercent: 40 },
                components: { monitoring: { status: 'unreachable', installed: false } },
            },
        }),
        true,
    );
});

test('monitoringCardDisplay formats counts, hides zero denominator on unsupported/unreachable, and shows role/mode cues', () => {
    assert.deepEqual(
        monitoringCardDisplay({ ready: 8, desired: 8, status: 'ready', accessMode: 'admin', monitoringMode: 'managed' }),
        { value: 8, unit: '/ 8', detail: 'Admin · K8s stack (managed)' },
    );
    assert.deepEqual(
        monitoringCardDisplay({ ready: 3, desired: 3, status: 'ready', accessMode: 'admin', monitoringMode: 'existing' }),
        { value: 3, unit: '/ 3', detail: 'Admin · Prometheus HTTP (existing)' },
    );
    assert.deepEqual(
        monitoringCardDisplay({ ready: 4, desired: 4, status: 'ready', accessMode: 'non_admin', monitoringMode: 'managed' }),
        { value: 4, unit: '/ 4', detail: 'Non-admin · Prometheus HTTP (managed)' },
    );
    assert.deepEqual(
        monitoringCardDisplay({ ready: 4, desired: 4, status: 'ready', accessMode: 'non_admin', monitoringMode: 'existing' }),
        { value: 4, unit: '/ 4', detail: 'Non-admin · Prometheus HTTP (existing)' },
    );
    assert.deepEqual(
        monitoringCardDisplay({ ready: 0, desired: 0, status: 'unsupported', message: 'Not supported' }, { monitoringMode: 'managed' }),
        { value: '—', unit: '', detail: 'Not supported' },
    );
    assert.deepEqual(
        monitoringCardDisplay({ ready: 0, desired: 0, status: 'unreachable', accessMode: 'admin', monitoringMode: 'existing' }),
        { value: '—', unit: '', detail: 'Admin · Prometheus HTTP (existing)' },
    );
});

test('describeMonitoringNotice covers all 4 role/mode combos, excludes optional components, and uses Orchestration administrator phrasing', () => {
    assert.equal(
        describeMonitoringNotice({
            monitoring: { status: 'ready', accessMode: 'admin', monitoringMode: 'managed' },
        }),
        null,
    );
    assert.equal(
        describeMonitoringNotice({
            monitoring: { status: 'installing', accessMode: 'admin', monitoringMode: 'managed' },
        }),
        null,
    );

    const nonAdminRequiredAbsent = describeMonitoringNotice({
        monitoring: { status: 'absent', accessMode: 'non_admin', monitoringMode: 'managed' },
        monitoringRequired: true,
    });
    assert.equal(nonAdminRequiredAbsent.tone, 'info');
    assert.match(nonAdminRequiredAbsent.message, /Orchestration administrator setup script/);
    assert.match(nonAdminRequiredAbsent.message, /Edit cluster on the Clusters page/);
    assert.match(nonAdminRequiredAbsent.message, /Re-check/);
    assert.doesNotMatch(nonAdminRequiredAbsent.message, /Kubernetes administrator|Cluster administrator/);
    assert.doesNotMatch(nonAdminRequiredAbsent.message, /Open Observability to (configure|update)/i);

    const nonAdminRequiredDegraded = describeMonitoringNotice({
        monitoring: { status: 'degraded', accessMode: 'non_admin', monitoringMode: 'existing' },
        monitoringRequired: true,
    });
    assert.equal(nonAdminRequiredDegraded.tone, 'danger');
    assert.match(nonAdminRequiredDegraded.message, /Orchestration administrator repair script/);
    assert.match(nonAdminRequiredDegraded.message, /Edit cluster on the Clusters page/);
    assert.doesNotMatch(nonAdminRequiredDegraded.message, /Open Observability to (configure|update)/i);

    const adminExistingAbsent = describeMonitoringNotice({
        monitoring: { status: 'absent', accessMode: 'admin', monitoringMode: 'existing' },
    });
    assert.equal(adminExistingAbsent.tone, 'warning');
    assert.match(adminExistingAbsent.message, /Edit cluster on the Clusters page/);
    assert.match(adminExistingAbsent.message, /Re-check in Observability/);
    assert.doesNotMatch(adminExistingAbsent.message, /Cluster settings/i);
    assert.doesNotMatch(adminExistingAbsent.message, /Open Observability to (configure|update)/i);

    const adminExistingDegraded = describeMonitoringNotice({
        monitoring: {
            status: 'degraded',
            accessMode: 'admin',
            monitoringMode: 'existing',
            components: [
                { name: 'prometheus', status: 'ready' },
                { name: 'kube_state_metrics', status: 'missing' },
                { name: 'grafana', status: 'missing', diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }] },
                { name: 'accelerator_exporters', status: 'missing', diagnostics: [{ code: 'ACCELERATOR_METRICS_NOT_DETECTED' }] },
            ],
        },
    });
    assert.equal(adminExistingDegraded.tone, 'danger');
    assert.deepEqual(adminExistingDegraded.affectedComponents, ['kube state metrics']);
    assert.match(adminExistingDegraded.message, /Edit cluster on the Clusters page/);
    assert.match(adminExistingDegraded.message, /Re-check in Observability/);
    assert.doesNotMatch(adminExistingDegraded.message, /Cluster settings/i);
    assert.doesNotMatch(adminExistingDegraded.message, /Open Observability to (configure|update)/i);

    const nonAdminExistingAbsent = describeMonitoringNotice({
        monitoring: { status: 'absent', accessMode: 'non_admin', monitoringMode: 'existing' },
    });
    assert.equal(nonAdminExistingAbsent.tone, 'warning');
    assert.match(nonAdminExistingAbsent.message, /Edit cluster on the Clusters page/);
    assert.match(nonAdminExistingAbsent.message, /Re-check in Observability/);

    const nonAdminExistingUnreachable = describeMonitoringNotice({
        monitoring: { status: 'unreachable', accessMode: 'non_admin', monitoringMode: 'existing' },
    });
    assert.equal(nonAdminExistingUnreachable.tone, 'danger');
    assert.match(nonAdminExistingUnreachable.message, /Edit cluster on the Clusters page/);
    assert.match(nonAdminExistingUnreachable.message, /Re-check in Observability/);

    const adminManagedAbsent = describeMonitoringNotice({
        monitoring: { status: 'absent', accessMode: 'admin', monitoringMode: 'managed' },
    });
    assert.equal(adminManagedAbsent.tone, 'info');
    assert.match(adminManagedAbsent.message, /Observability/);
    assert.match(adminManagedAbsent.message, /Install/);

    const adminManagedDegraded = describeMonitoringNotice({
        monitoring: { status: 'degraded', accessMode: 'admin', monitoringMode: 'managed' },
    });
    assert.equal(adminManagedDegraded.tone, 'danger');
    assert.match(adminManagedDegraded.message, /Observability/);
    assert.match(adminManagedDegraded.message, /Reinstall/);

    const adminManagedUnreachable = describeMonitoringNotice({
        monitoring: { status: 'unreachable', accessMode: 'admin', monitoringMode: 'managed' },
    });
    assert.equal(adminManagedUnreachable.tone, 'danger');
    assert.match(adminManagedUnreachable.message, /Observability/);
    assert.match(adminManagedUnreachable.message, /Re-check/);

    const nonAdminManagedAbsent = describeMonitoringNotice({
        monitoring: { status: 'absent', accessMode: 'non_admin', monitoringMode: 'managed' },
    });
    assert.equal(nonAdminManagedAbsent.tone, 'info');
    assert.match(nonAdminManagedAbsent.message, /Observability/);
    assert.match(nonAdminManagedAbsent.message, /Install/);
    assert.match(nonAdminManagedAbsent.message, /Orchestration administrator setup script/);
    assert.match(nonAdminManagedAbsent.message, /Edit cluster on the Clusters page/);
    assert.match(nonAdminManagedAbsent.message, /Re-check/);
    assert.doesNotMatch(nonAdminManagedAbsent.message, /Open Observability to (configure|update)/i);

    const nonAdminDegraded = describeMonitoringNotice({
        monitoring: { status: 'degraded', accessMode: 'non_admin', monitoringMode: 'managed' },
    });
    assert.equal(nonAdminDegraded.tone, 'danger');
    assert.match(nonAdminDegraded.message, /Observability/);
    assert.match(nonAdminDegraded.message, /Reinstall/);
    assert.match(nonAdminDegraded.message, /Orchestration administrator repair script/);
    assert.match(nonAdminDegraded.message, /Edit cluster on the Clusters page/);
    assert.match(nonAdminDegraded.message, /Re-check/);
    assert.doesNotMatch(nonAdminDegraded.message, /Open Observability to (configure|update)/i);

    const promNotice = describeMonitoringNotice({
        monitoring: { status: 'ready', accessMode: 'non_admin', monitoringMode: 'managed' },
        kubernetesNotice: 'kube-state-metrics target(s) are not reporting yet',
        telemetrySource: 'prometheus',
        prometheusReachable: true,
    });
    assert.equal(promNotice.tone, 'warning');
    assert.equal(promNotice.title, 'Prometheus telemetry notice');
});

test('getNonAdminClusterStackAction gates install/reinstall strictly to actionable non-admin managed states', () => {
    assert.equal(getNonAdminClusterStackAction(null), null);
    assert.equal(getNonAdminClusterStackAction({ access_mode: 'admin', status: 'absent' }), null);
    assert.equal(
        getNonAdminClusterStackAction({
            access_mode: 'non_admin',
            status: 'absent',
            cluster: { reachable: false },
        }),
        null,
    );
    assert.equal(
        getNonAdminClusterStackAction({
            access_mode: 'non_admin',
            monitoring_mode: 'existing',
            status: 'absent',
        }),
        null,
    );
    for (const hiddenStatus of ['external', 'unsupported', 'installing', 'progressing']) {
        assert.equal(
            getNonAdminClusterStackAction({ access_mode: 'non_admin', status: hiddenStatus }),
            null,
        );
    }
    assert.equal(
        getNonAdminClusterStackAction({ access_mode: 'non_admin', status: 'absent' }),
        'install',
    );
    for (const reinstallStatus of ['degraded', 'unreachable', 'failed']) {
        assert.equal(
            getNonAdminClusterStackAction({ access_mode: 'non_admin', status: reinstallStatus }),
            'reinstall',
        );
    }
    assert.equal(
        getNonAdminClusterStackAction({
            access_mode: 'non_admin',
            status: 'ready',
            components: [
                { name: 'prometheus', status: 'ready' },
                { name: 'grafana', status: 'missing', diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }] },
                { name: 'accelerator_exporters', status: 'missing', diagnostics: [{ code: 'ACCELERATOR_METRICS_NOT_DETECTED' }] },
            ],
        }),
        null,
    );
    assert.equal(
        getNonAdminClusterStackAction({
            access_mode: 'non_admin',
            status: 'ready',
            components: [
                { name: 'prometheus', status: 'ready' },
                { name: 'kube_state_metrics', status: 'missing' },
            ],
        }),
        'reinstall',
    );
});

test('getNonAdminAcceleratorAction gates install/reinstall strictly to actionable non-admin reachable states', () => {
    assert.equal(getNonAdminAcceleratorAction(null), null);
    assert.equal(
        getNonAdminAcceleratorAction({ cluster_access_mode: 'admin', can_manage: true, status: 'absent' }),
        null,
    );
    assert.equal(
        getNonAdminAcceleratorAction({
            cluster_access_mode: 'non_admin',
            cluster_reachable: false,
            status: 'absent',
        }),
        null,
    );
    assert.equal(
        getNonAdminAcceleratorAction({
            cluster_reachable: false,
            can_manage: false,
            status: 'absent',
        }),
        null,
    );
    for (const hiddenStatus of ['unsupported', 'installing', 'progressing']) {
        assert.equal(
            getNonAdminAcceleratorAction({ cluster_access_mode: 'non_admin', status: hiddenStatus }),
            null,
        );
    }
    assert.equal(
        getNonAdminAcceleratorAction({ cluster_access_mode: 'non_admin', status: 'absent' }),
        'install',
    );
    assert.equal(
        getNonAdminAcceleratorAction({ can_manage: false, cluster_reachable: true, status: 'absent' }),
        'install',
    );
    for (const reinstallStatus of ['degraded', 'unreachable', 'failed']) {
        assert.equal(
            getNonAdminAcceleratorAction({ cluster_access_mode: 'non_admin', status: reinstallStatus }),
            'reinstall',
        );
    }
    assert.equal(
        getNonAdminAcceleratorAction({
            cluster_access_mode: 'non_admin',
            status: 'ready',
            components: [
                { name: 'device_telemetry', status: 'ready' },
                { name: 'grafana', status: 'missing', diagnostics: [{ code: 'GRAFANA_URL_OPTIONAL' }] },
            ],
        }),
        null,
    );
    assert.equal(
        getNonAdminAcceleratorAction({
            cluster_access_mode: 'non_admin',
            status: 'ready',
            components: [{ name: 'device_telemetry', status: 'degraded' }],
        }),
        'reinstall',
    );
});

test('resolveClusterMonitoringNamespace uses custom monitoringNamespace and falls back to llm-d-monitoring', () => {
    assert.equal(DEFAULT_MONITORING_NAMESPACE, 'llm-d-monitoring');
    assert.equal(
        resolveClusterMonitoringNamespace({ id: '2790b2ae', monitoringNamespace: 'llm-d-monitoring-123454' }),
        'llm-d-monitoring-123454',
    );
    assert.equal(
        resolveClusterMonitoringNamespace({ id: '2790b2ae', monitoringNamespace: '  llm-d-monitoring-123454  ' }),
        'llm-d-monitoring-123454',
    );
    assert.equal(
        resolveClusterMonitoringNamespace({ id: '2790b2ae', monitoring_namespace: 'llm-d-monitoring-snake' }),
        'llm-d-monitoring-snake',
    );
    assert.equal(resolveClusterMonitoringNamespace({ id: 'c-empty', monitoringNamespace: '' }), 'llm-d-monitoring');
    assert.equal(resolveClusterMonitoringNamespace({ id: 'c-blank', monitoringNamespace: '   ' }), 'llm-d-monitoring');
    assert.equal(resolveClusterMonitoringNamespace({ id: 'c-missing' }), 'llm-d-monitoring');
    assert.equal(resolveClusterMonitoringNamespace(null), 'llm-d-monitoring');
    assert.equal(normalizeMonitoringNamespace('', 'custom-fallback'), 'custom-fallback');
});

test('resolveEffectiveMonitoringNamespace and resolveMonitoringNamespaceOverride handle initial cluster, switch, and Inspect override', () => {
    const clusterA = { id: '2790b2ae', monitoringNamespace: 'llm-d-monitoring-123454' };
    const clusterB = { id: 'cluster-b', monitoringNamespace: 'llm-d-monitoring-prod' };
    const clusterDefault = { id: 'cluster-c' };

    // Initial cluster selection uses selectedCluster.monitoringNamespace
    assert.equal(
        resolveEffectiveMonitoringNamespace({
            clusterId: '2790b2ae',
            selectedCluster: clusterA,
            namespaceOverride: null,
        }),
        'llm-d-monitoring-123454',
    );

    // Explicit Inspect override applies to matching clusterId and trims input
    const overrideA = resolveMonitoringNamespaceOverride({
        clusterId: '2790b2ae',
        inputValue: '  custom-inspect-ns  ',
        selectedCluster: clusterA,
    });
    assert.deepEqual(overrideA, { clusterId: '2790b2ae', value: 'custom-inspect-ns' });
    assert.equal(
        resolveEffectiveMonitoringNamespace({
            clusterId: '2790b2ae',
            selectedCluster: clusterA,
            namespaceOverride: overrideA,
        }),
        'custom-inspect-ns',
    );

    // Switching clusterId ignores previous cluster override and uses new cluster's monitoringNamespace
    assert.equal(
        resolveEffectiveMonitoringNamespace({
            clusterId: 'cluster-b',
            selectedCluster: clusterB,
            namespaceOverride: overrideA,
        }),
        'llm-d-monitoring-prod',
    );

    // Blank or matching-default Inspect input clears override and reverts to cluster default
    assert.equal(
        resolveMonitoringNamespaceOverride({
            clusterId: '2790b2ae',
            inputValue: '   ',
            selectedCluster: clusterA,
        }),
        null,
    );
    assert.equal(
        resolveMonitoringNamespaceOverride({
            clusterId: '2790b2ae',
            inputValue: 'llm-d-monitoring-123454',
            selectedCluster: clusterA,
        }),
        null,
    );
    assert.equal(
        resolveMonitoringNamespaceOverride({
            clusterId: '',
            inputValue: 'custom-inspect-ns',
            selectedCluster: null,
        }),
        null,
    );

    // Fallback to llm-d-monitoring when selectedCluster.monitoringNamespace is absent
    assert.equal(
        resolveEffectiveMonitoringNamespace({
            clusterId: 'cluster-c',
            selectedCluster: clusterDefault,
            namespaceOverride: null,
        }),
        'llm-d-monitoring',
    );
});

test('monitoring backend clients forward custom monitoringNamespace across cluster stack, profiling, and all 6 accelerator endpoints', async () => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    try {
        await getClusterStackStatus('llm-d-monitoring-123454', { clusterId: '2790b2ae' });
        await getClusterStackLinks('llm-d-monitoring-123454', { clusterId: '2790b2ae' });
        await getDeploymentFlowMap('exec-1', {
            clusterId: '2790b2ae',
            monitoringNamespace: 'llm-d-monitoring-123454',
        });

        await getAcceleratorStatus('intel_gpu', {
            namespace: 'intel-xpumd',
            accessMode: 'dra',
            monitoringNamespace: 'llm-d-monitoring-123454',
            clusterId: '2790b2ae',
        });
        await getAcceleratorLinks('intel_gpu', {
            monitoringNamespace: 'llm-d-monitoring-123454',
            clusterId: '2790b2ae',
        });
        await getAcceleratorAdminScript('intel_gpu', {
            namespace: 'intel-xpumd',
            accessMode: 'dra',
            monitoringNamespace: 'llm-d-monitoring-123454',
            clusterId: '2790b2ae',
        });
        await recheckAccelerator('intel_gpu', {
            namespace: 'intel-xpumd',
            accessMode: 'dra',
            monitoringNamespace: 'llm-d-monitoring-123454',
            clusterId: '2790b2ae',
        });
        await preflightAcceleratorInstall(
            {
                accelerator: 'intel_gpu',
                access_mode: 'dra',
                namespace: 'intel-xpumd',
                monitoring_namespace: 'llm-d-monitoring-123454',
            },
            { clusterId: '2790b2ae' },
        );
        await installAccelerator(
            {
                accelerator: 'intel_gpu',
                access_mode: 'dra',
                namespace: 'intel-xpumd',
                monitoring_namespace: '  llm-d-monitoring-123454  ',
            },
            'idem-key-1',
            '2790b2ae',
        );

        assert.equal(
            requests[0].url,
            '/api/v1/monitoring/cluster-stack/status?namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(
            requests[1].url,
            '/api/v1/monitoring/cluster-stack/links?namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(
            requests[2].url,
            '/api/v1/monitoring/profiling/flow-map?execution_id=exec-1&cluster_id=2790b2ae&monitoring_namespace=llm-d-monitoring-123454',
        );
        assert.equal(
            requests[3].url,
            '/api/v1/monitoring/accelerators/intel_gpu/status?namespace=intel-xpumd&access_mode=dra&monitoring_namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(
            requests[4].url,
            '/api/v1/monitoring/accelerators/intel_gpu/links?monitoring_namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(
            requests[5].url,
            '/api/v1/monitoring/accelerators/intel_gpu/admin-script?namespace=intel-xpumd&access_mode=dra&monitoring_namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(
            requests[6].url,
            '/api/v1/monitoring/accelerators/intel_gpu/recheck?namespace=intel-xpumd&access_mode=dra&monitoring_namespace=llm-d-monitoring-123454&cluster_id=2790b2ae',
        );
        assert.equal(requests[6].init.method, 'POST');
        assert.equal(
            requests[7].url,
            '/api/v1/monitoring/accelerators/intel_gpu/installations/preflight?cluster_id=2790b2ae',
        );
        assert.deepEqual(JSON.parse(requests[7].init.body), {
            accelerator: 'intel_gpu',
            access_mode: 'dra',
            namespace: 'intel-xpumd',
            monitoring_namespace: 'llm-d-monitoring-123454',
        });
        assert.equal(
            requests[8].url,
            '/api/v1/monitoring/accelerators/intel_gpu/installations?cluster_id=2790b2ae',
        );
        assert.deepEqual(JSON.parse(requests[8].init.body), {
            accelerator: 'intel_gpu',
            access_mode: 'dra',
            namespace: 'intel-xpumd',
            monitoring_namespace: 'llm-d-monitoring-123454',
        });
    } finally {
        globalThis.fetch = previousFetch;
    }
});
