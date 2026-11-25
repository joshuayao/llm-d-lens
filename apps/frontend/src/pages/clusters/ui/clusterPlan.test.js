import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MONITORING_NAMESPACE_PREFIX,
    buildPlan,
    defaultMonitoringNamespace,
    monitoringPlan,
    planSummary,
    validateContainerImageRef,
} from './clusterPlan.js';

const FULL_CONFIG = {
    gateway: {
        provider: 'istio',
        namespace: 'lens-gateway',
        namespaceMode: 'create',
        name: 'lens-gateway',
        publicUrl: 'https://gateway.example.com',
        port: '30080',
        authzHost: 'lens.example.com',
    },
    accelerators: [
        {
            vendor: 'intel',
            model: 'Max 1550',
            mode: 'plugin',
            operator: 'intel-gpu',
            profile: 'intel-gpu',
            rbac: 'namespaced+cluster',
        },
    ],
    storage: {
        kind: 'local-disk',
        volumeId: 'storage-abc12345',
        capacity: '100Gi',
        hostPath: '/models',
        readOnly: false,
        purposes: ['model-cache'],
    },
    hfTokenSecret: {
        tokenSource: 'create-secret',
        secretName: 'hf-token-abc',
        secretNamespace: 'llm-d-bench-storage-abc',
        secretNamespaceMode: 'create',
    },
    modelCache: {
        enabled: true,
        repoId: 'org/model',
        revision: 'main',
        storageVolumeRef: 'lens-models',
    },
    stack: {
        routerVersion: 'router-1',
        gieVersion: 'gie-2',
        ippVersion: 'ipp-3',
        lwsEnabled: true,
        crdsEnabled: true,
        imagePrepullEnabled: true,
        images: ['ghcr.io/llm-d/llm-d:latest'],
        imagesNamespace: 'lens-images',
        imagesNamespaceMode: 'create',
    },
    runtime: { inotifyEnabled: true, inotifyLimit: '16384' },
    spec: { replicas: 2, gpuPerReplica: 1 },
};

test('buildPlan emits the backend DTO with camelCase fields and coerced values', () => {
    const plan = buildPlan(FULL_CONFIG);
    assert.equal(plan.planVersion, 5);
    assert.deepEqual(plan.gateway, {
        provider: 'istio',
        namespace: 'lens-gateway',
        namespaceMode: 'create',
        name: 'lens-gateway',
        publicUrl: 'https://gateway.example.com',
        port: 30080,
        authzHost: 'lens.example.com',
        serviceType: null,
    });
    assert.deepEqual(plan.accelerators, [
        {
            vendor: 'intel',
            model: 'Max 1550',
            mode: 'plugin',
            operator: 'intel-gpu',
            profile: 'intel-gpu',
            rbac: ['namespaced', 'cluster'],
        },
    ]);
    assert.equal(plan.storage.kind, 'local-disk');
    assert.equal(plan.storage.volumeId, 'storage-abc12345');
    assert.equal(plan.storage.hostPath, '/models');
    assert.deepEqual(plan.storage.purposes, ['model-cache']);
    assert.equal(plan.modelCache.enabled, true);
    assert.equal(plan.modelCache.storageVolumeRef, 'lens-models');
    assert.equal(plan.stack.routerVersion, 'router-1');
    assert.equal(plan.stack.lwsEnabled, true);
    assert.equal(plan.runtime.inotifyLimit, 16384);
    assert.deepEqual(plan.spec, { replicas: 2, gpuPerReplica: 1 });
});

test('buildPlan fills backend defaults for empty and disabled state', () => {
    const plan = buildPlan();
    assert.equal(plan.planVersion, 5);
    assert.deepEqual(plan.gateway, {
        provider: '',
        namespace: '',
        namespaceMode: 'existing',
        name: '',
        publicUrl: null,
        port: null,
        authzHost: null,
        serviceType: null,
    });
    assert.deepEqual(plan.accelerators, []);
    assert.equal(plan.storage.kind, 'none');
    assert.equal(plan.storage.readOnly, false);
    assert.deepEqual(plan.storage.purposes, []);
    assert.equal(plan.hfTokenSecret.tokenSource, 'create-secret');
    assert.equal(plan.modelCache.enabled, false);
    assert.equal(plan.stack.lwsEnabled, false);
    assert.equal(plan.stack.crdsEnabled, false);
    assert.equal(plan.stack.imagePrepullEnabled, false);
    assert.equal(plan.stack.imagesNamespaceMode, 'create');
    assert.equal(plan.runtime.inotifyEnabled, true);
    assert.equal(plan.runtime.inotifyLimit, 8192);
    assert.deepEqual(plan.handoff, { namespace: 'default' });
    assert.deepEqual(plan.spec, {});
});

test('buildPlan accepts grouped and flat handoff namespace fields', () => {
    assert.deepEqual(buildPlan({ handoff: { namespace: 'lens-edit' } }).handoff, { namespace: 'lens-edit' });
    assert.deepEqual(buildPlan({ handoffNamespace: 'team-ns' }).handoff, { namespace: 'team-ns' });
    assert.deepEqual(buildPlan({ handoffNamespace: '   ' }).handoff, { namespace: 'default' });
});

test('buildPlan accepts flat wizard field names', () => {
    const plan = buildPlan({
        gatewayProvider: 'gke',
        gatewayPort: '31000',
        storageKind: 'nfs',
        storageCapacity: '1Ti',
        nfsServer: 'nfs.example.com',
        nfsPath: '/exports/models',
        secretNamespace: 'team-a',
        secretName: 'hf-team-a',
        prewarmEnabled: true,
        repoId: 'org/model',
        revision: 'v1',
        storageName: 'team-a-models',
        inotifyMaxUserInstances: '4096',
        replicas: 3,
        gpuPerReplica: 2,
    });
    assert.equal(plan.gateway.provider, 'gke');
    assert.equal(plan.gateway.port, 31000);
    assert.equal(plan.storage.kind, 'nfs');
    assert.equal(plan.storage.nfsServer, 'nfs.example.com');
    assert.equal(plan.hfTokenSecret.secretNamespace, 'team-a');
    assert.equal(plan.modelCache.enabled, true);
    assert.equal(plan.modelCache.storageVolumeRef, 'team-a-models');
    assert.equal(plan.runtime.inotifyLimit, 4096);
    assert.deepEqual(plan.spec, { replicas: 3, gpuPerReplica: 2 });
});

test('planSummary renders provider, accelerator, storage, cache, stack and spec', () => {
    const summary = planSummary(buildPlan(FULL_CONFIG));
    assert.match(summary.provider, /istio/);
    assert.match(summary.provider, /lens-gateway\/lens-gateway/);
    assert.match(summary.provider, /port 30080/);
    assert.match(summary.accelerators, /intel Max 1550 \(plugin\)/);
    assert.match(summary.storage, /local-disk/);
    assert.match(summary.storage, /100Gi/);
    assert.match(summary.storage, /\/models/);
    assert.match(summary.modelCache, /org\/model@main/);
    assert.match(summary.modelCache, /lens-models/);
    assert.match(summary.stack, /router router-1/);
    assert.match(summary.stack, /LWS/);
    assert.match(summary.stack, /CRDs/);
    assert.match(summary.spec, /replicas 2/);
    assert.match(summary.spec, /gpuPerReplica 1/);
});

test('planSummary handles an empty plan and preserves legacy monitoring namespaces', () => {
    const summary = planSummary(buildPlan());
    assert.equal(summary.provider, 'No gateway provider');
    assert.equal(summary.accelerators, 'No accelerators');
    assert.equal(summary.storage, 'No storage volume');
    assert.equal(summary.modelCache, 'Disabled');
    assert.equal(summary.stack, 'No stack components');
    assert.equal(summary.monitoring, 'managed · lens-monitoring');
    assert.equal(summary.spec, 'No deployment spec');
    assert.equal(planSummary({ monitoring: { enabled: true } }).monitoring, 'managed · lens-monitoring');
    assert.equal(
        planSummary({ monitoring: { enabled: true, mode: 'managed', namespace: 'llm-d-monitoring' } }).monitoring,
        'managed · llm-d-monitoring',
    );
});

test('defaultMonitoringNamespace formats DNS-1123 cluster-scoped namespaces within 63 characters', () => {
    assert.equal(MONITORING_NAMESPACE_PREFIX, 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace('283db094'), 'lens-monitoring-283db094');
    assert.equal(defaultMonitoringNamespace('cluster-1'), 'lens-monitoring-cluster-1');
    assert.equal(defaultMonitoringNamespace('  Team_Cluster--01!  '), 'lens-monitoring-team-cluster-01');
    assert.equal(defaultMonitoringNamespace(''), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace('   '), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace(null), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace(undefined), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace('---'), 'lens-monitoring');

    const truncated = defaultMonitoringNamespace(`${'a'.repeat(46)}-extra-suffix`);
    assert.equal(truncated.length <= 63, true);
    assert.equal(truncated.endsWith('-'), false);
    assert.match(truncated, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
});

test('monitoringPlan applies defaults when config is empty or cluster-scoped', () => {
    assert.deepEqual(monitoringPlan(), {
        enabled: true,
        mode: 'managed',
        namespace: 'lens-monitoring',
        prometheusUrl: null,
        grafanaUrl: null,
        prometheusNodePort: null,
        grafanaNodePort: null,
        host: null,
        installAcceleratorExporters: true,
    });
    assert.equal(monitoringPlan({ clusterId: '283db094' }).namespace, 'lens-monitoring-283db094');
    assert.equal(
        monitoringPlan({ clusterId: '283db094', monitoring: { namespace: 'llm-d-monitoring' } }).namespace,
        'llm-d-monitoring',
    );
});

test('monitoringPlan normalizes nested config, flat keys, and numeric ports', () => {
    assert.deepEqual(
        monitoringPlan({
            monitoring: {
                enabled: true,
                mode: 'existing',
                namespace: '  custom-obs  ',
                prometheusUrl: ' https://prom.example.com ',
                grafanaUrl: '   ',
                prometheusNodePort: '30900',
                grafanaNodePort: 'not-a-port',
                host: ' 10.0.0.15 ',
                installAcceleratorExporters: false,
            },
        }),
        {
            enabled: true,
            mode: 'existing',
            namespace: 'custom-obs',
            prometheusUrl: 'https://prom.example.com',
            grafanaUrl: null,
            prometheusNodePort: 30900,
            grafanaNodePort: null,
            host: '10.0.0.15',
            installAcceleratorExporters: false,
        },
    );

    assert.deepEqual(
        monitoringPlan({
            monitoringMode: 'existing',
            monitoringNamespace: 'team-monitoring',
            prometheusUrl: 'http://10.1.2.3:9090',
            grafanaUrl: 'http://10.1.2.3:3000',
            prometheusNodePort: 30901,
            grafanaNodePort: ' 30300 ',
            monitoringHost: '10.1.2.3',
            installAcceleratorExporters: false,
        }),
        {
            enabled: true,
            mode: 'existing',
            namespace: 'team-monitoring',
            prometheusUrl: 'http://10.1.2.3:9090',
            grafanaUrl: 'http://10.1.2.3:3000',
            prometheusNodePort: 30901,
            grafanaNodePort: 30300,
            host: '10.1.2.3',
            installAcceleratorExporters: false,
        },
    );

    assert.equal(monitoringPlan({ prometheusNodePort: '' }).prometheusNodePort, null);
    assert.equal(monitoringPlan({ prometheusNodePort: '   ' }).prometheusNodePort, null);
    assert.equal(monitoringPlan({ prometheusNodePort: false }).prometheusNodePort, null);
    assert.equal(monitoringPlan({ prometheusNodePort: '30900.5' }).prometheusNodePort, null);
    assert.equal(monitoringPlan({ monitoringNamespace: '   ' }).namespace, 'lens-monitoring');
    assert.equal(
        monitoringPlan({ clusterId: '283db094', monitoringNamespace: '   ' }).namespace,
        'lens-monitoring-283db094',
    );
});

test('buildPlan and planSummary include normalized monitoring configuration', () => {
    const plan = buildPlan({
        monitoringMode: 'existing',
        monitoringNamespace: 'obs',
        prometheusNodePort: '30900',
        grafanaUrl: 'https://grafana.example.com',
        installAcceleratorExporters: false,
    });
    assert.deepEqual(plan.monitoring, {
        enabled: true,
        mode: 'existing',
        namespace: 'obs',
        prometheusUrl: null,
        grafanaUrl: 'https://grafana.example.com',
        prometheusNodePort: 30900,
        grafanaNodePort: null,
        host: null,
        installAcceleratorExporters: false,
    });
    const summary = planSummary(plan);
    assert.match(summary.monitoring, /existing/);
    assert.match(summary.monitoring, /obs/);
    assert.match(summary.monitoring, /Prometheus NodePort 30900/);
    assert.match(summary.monitoring, /Grafana https:\/\/grafana\.example\.com/);
    assert.match(summary.monitoring, /exporters off/);
    assert.equal(planSummary({}).monitoring, 'Not configured');
});

test('monitoringPlan omits autoDiscovered and planSummary includes host when specified', () => {
    const normalized = monitoringPlan({
        monitoring: {
            mode: 'managed',
            namespace: 'llm-d-monitoring',
            host: '10.0.0.20',
            prometheusUrl: 'http://10.0.0.20:30900',
            autoDiscovered: ['prometheusUrl', 'host'],
        },
    });
    assert.equal('autoDiscovered' in normalized, false);
    assert.equal('auto_discovered' in normalized, false);
    assert.equal(normalized.host, '10.0.0.20');

    const summary = planSummary(buildPlan({
        clusterId: '283db094',
        monitoringMode: 'managed',
        monitoringHost: '10.0.0.20',
    }));
    assert.match(summary.monitoring, /managed · lens-monitoring-283db094 · host 10\.0\.0\.20/);
    assert.match(
        planSummary(buildPlan({
            monitoringMode: 'managed',
            monitoringNamespace: 'llm-d-monitoring',
            monitoringHost: '10.0.0.20',
        })).monitoring,
        /managed · llm-d-monitoring · host 10\.0\.0\.20/,
    );
});

test('buildPlan preserves storage namespace and namespaceMode while planSummary.storage stays compatible', () => {
    const grouped = buildPlan({
        storage: {
            kind: 'local-disk',
            namespace: 'lens-edit',
            namespaceMode: 'existing',
            capacity: '100Gi',
            hostPath: '/models',
        },
    });
    assert.equal(grouped.storage.namespace, 'lens-edit');
    assert.equal(grouped.storage.namespaceMode, 'existing');
    assert.equal(planSummary(grouped).storage, 'local-disk · 100Gi · /models');

    const flat = buildPlan({
        storageKind: 'nfs',
        storageNamespace: 'team-nfs',
        storageNamespaceMode: 'create',
        storageCapacity: '200Gi',
        nfsServer: 'nfs.example.com',
        nfsPath: '/exports',
    });
    assert.equal(flat.storage.namespace, 'team-nfs');
    assert.equal(flat.storage.namespaceMode, 'create');
    assert.equal(planSummary(flat).storage, 'nfs · 200Gi · nfs.example.com:/exports');
});

test('validateContainerImageRef accepts valid OCI references and empty defaults', () => {
    const sha256 = 'a'.repeat(64);
    const sha384 = 'b'.repeat(96);
    const sha512 = 'c'.repeat(128);
    for (const valid of [
        null,
        undefined,
        '',
        '   ',
        'ubuntu:22.04',
        'docker.io/vllm/vllm-openai:v0.8.5',
        'quay.io/modh/vllm:v0.8.5-rc1',
        'localhost/vllm:latest',
        'localhost:5000/vllm/vllm-openai:v0.8.5',
        'localhost:1/vllm:v1',
        'localhost:65535/vllm:v1',
        'registry.internal:5000/org/vllm:v0.8.5',
        'myregistry:5000/vllm:v1',
        '192.168.1.10:5000/vllm:v1',
        'MyRegistry.example.com/org/vllm:v1',
        `docker.io/vllm/vllm-openai@sha256:${sha256}`,
        `docker.io/vllm/vllm-openai:v0.8.5@sha256:${sha256}`,
        `docker.io/vllm/vllm-openai@sha384:${sha384}`,
        `docker.io/vllm/vllm-openai@sha512:${sha512}`,
    ]) {
        assert.equal(validateContainerImageRef(valid), '', `expected valid: ${String(valid)}`);
    }
});

test('validateContainerImageRef rejects unsafe, untagged, malformed, and oversized refs', () => {
    const sha256 = 'a'.repeat(64);
    const invalidCases = [
        123,
        'docker.io/vllm/vllm-openai:v1\n',
        'docker.io/vllm/vllm-openai:v1\x00',
        'docker.io/vllm/vllm-openai:v1\x7f',
        ' docker.io/vllm/vllm-openai:v1 ',
        'docker.io/vllm/vllm openai:v1',
        `docker.io/vllm/vllm-openai:${'a'.repeat(500)}`,
        '-v/foo:bar',
        'https://docker.io/vllm/vllm-openai:v1',
        'docker.io\\vllm\\vllm-openai:v1',
        "docker.io/vllm/vllm-openai:v1'",
        'docker.io/vllm/vllm-openai:v1"',
        'docker.io/vllm/vllm-openai:v1;rm -rf /',
        'docker.io/vllm/vllm-openai:v1&echo',
        'docker.io/vllm/vllm-openai:v1|cat',
        'docker.io/vllm/vllm-openai:$TAG',
        'docker.io/vllm/vllm-openai:`id`',
        'docker.io/vllm/vllm-openai:v1#comment',
        'docker.io/vllm/vllm-openai:v1=bad',
        'localhost:0/vllm:v1',
        'localhost:00080/vllm:v1',
        'registry:00080/repo:v1',
        'registry.internal:00500/org/vllm:v1',
        'localhost:65536/vllm:v1',
        'registry.internal:99999/org/vllm:v1',
        'docker.io/vllm/vllm-openai',
        'registry.internal:5000/org/vllm',
        'ubuntu',
        'docker.io/VLLM/vllm-openai:v1',
        'MyOrg/vllm:v1',
        'docker.io/vllm/../evil:v1',
        'docker.io/vllm//vllm-openai:v1',
        'docker.io/vllm/café:v1',
        'docker.io/vllm/vllm-openai@sha256:short',
        `docker.io/vllm/vllm-openai@sha256:${sha256}@sha256:${sha256}`,
        'vllm:v1:v2',
    ];
    for (const invalid of invalidCases) {
        const message = validateContainerImageRef(invalid);
        assert.notEqual(message, '', `expected invalid: ${String(invalid)}`);
    }
});

test('buildPlan and planSummary wire stack.vllmImage across nested, snake_case, and flat inputs', () => {
    assert.equal(buildPlan().stack.vllmImage, null);
    assert.equal(buildPlan({ stack: { vllmImage: '  registry.internal:5000/org/vllm:v1  ' } }).stack.vllmImage, 'registry.internal:5000/org/vllm:v1');
    assert.equal(buildPlan({ stack: { vllm_image: 'quay.io/org/vllm:v2' } }).stack.vllmImage, 'quay.io/org/vllm:v2');
    assert.equal(buildPlan({ vllmImage: 'localhost:5000/vllm:dev' }).stack.vllmImage, 'localhost:5000/vllm:dev');
    assert.equal(buildPlan({ stack: { vllmImage: '   ' } }).stack.vllmImage, null);

    const summary = planSummary(buildPlan({
        stack: { routerVersion: 'r1', vllmImage: 'registry.internal:5000/org/vllm:v1' },
    }));
    assert.match(summary.stack, /vLLM registry\.internal:5000\/org\/vllm:v1/);
});
