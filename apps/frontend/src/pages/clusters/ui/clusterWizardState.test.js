import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    EXECUTION_TOKEN_KEY_PREFIX,
    GATEWAY_DEFAULTS,
    MONITORING_NAMESPACE,
    MONITORING_NAMESPACE_PREFIX,
    RESUME_STEP_KEY,
    RESUME_STORAGE_KEY,
    STORAGE_NAMESPACE,
    STORAGE_NAMESPACE_PREFIX,
    WIZARD_STEP_IDS,
    adminVerificationReady,
    canExecuteOperationRun,
    canNavigateBackFromExecute,
    canRunPreflight,
    canResumeOperationRun,
    clearExecutionToken,
    clearResumeDraftId,
    clearResumeState,
    clusterDetailSyncForReport,
    completeFailureAction,
    createResumeGate,
    defaultMonitoringNamespace,
    defaultStorageNamespace,
    executeDisabledReason,
    executionCompletedForPlan,
    executionFailureAction,
    handoffFallbackFromVerifyError,
    hfTokenSatisfiedForRun,
    hfTokenSecretValid,
    loadExecutionToken,
    loadResumeDraftId,
    loadResumeStep,
    monitoringStepValid,
    monitoringValidationError,
    nextExecutionCompleted,
    operationLedgerForRun,
    operationProgressForLedger,
    permissionPanelVisible,
    planConfigFromWizardState,
    planFromWizardState,
    planInvalidatesRun,
    planSyncFromPermissionReport,
    planToWizardFields,
    plannedStorageVolumeName,
    proxyFieldsFromCluster,
    resumeStepForPlan,
    saveExecutionToken,
    saveResumeDraftId,
    saveResumeStep,
    shouldAutoCheckResumedPlan,
    shouldAutoVerifyHandoff,
    shouldClearResumeOnLoadError,
    shouldLoadHandoff,
    shouldShowSetupProgress,
    storageNamespaceValid,
    storageStepValid,
    validateContainerImageRef,
    verificationBlocksRun,
    verificationFailureAction,
    verifyRefreshesOperationLedger,
    versionCheckBlocks,
    versionCheckMessage,
    vllmImageValidationError,
    wizardStepCanAdvance,
} from './clusterWizardState.js';

function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); },
        removeItem: (key) => { delete data[key]; },
        snapshot: () => ({ ...data }),
    };
}

const STORED_PLAN = {
    gateway: {
        provider: 'istio',
        serviceType: 'NodePort',
        namespace: 'lens-gateway',
        name: 'lens-inference-gateway',
        port: 30080,
        publicUrl: '10.0.0.5',
        authzHost: 'lens.example.com',
    },
    accelerators: [
        { vendor: 'intel', mode: 'plugin', profile: 'intel-gpu' },
        { vendor: 'intel', mode: 'dra', profile: 'intel-gpu' },
    ],
    runtime: { inotifyEnabled: true, inotifyLimit: 4096 },
    stack: {
        routerVersion: 'router-v1',
        gieVersion: 'gie-v1',
        ippVersion: 'ipp-v1',
        lwsVersion: 'lws-v1',
        lwsEnabled: true,
        crdsEnabled: true,
        imagePrepullEnabled: true,
    },
    storage: {
        kind: 'local-disk',
        volumeId: 'storage-abc12345',
        capacity: '100Gi',
        hostPath: '/data/models',
        nfsServer: null,
        nfsPath: null,
    },
    modelCache: {
        enabled: true,
        entryId: 'mc-abc123',
        repoId: 'org/model',
        revision: 'v1',
        storageVolumeRef: 'team-models',
    },
    hfTokenSecret: {
        tokenSource: 'create-secret',
        secretName: 'hf-token-abc',
        secretNamespace: 'team-a',
    },
};

test('WIZARD_STEP_IDS is the configuration-first order', () => {
    assert.deepEqual(WIZARD_STEP_IDS, [
        'basics',
        'proxy',
        'gateway',
        'accelerator',
        'versions',
        'modelCache',
        'storage',
        'review',
        'execute',
    ]);
});

test('planToWizardFields maps every stored plan section back to wizard state', () => {
    const fields = planToWizardFields(STORED_PLAN);
    assert.equal(fields.gatewayProvider, 'istio');
    assert.equal(fields.gatewayNamespace, 'lens-gateway');
    assert.equal(fields.gatewayName, 'lens-inference-gateway');
    assert.equal(fields.gatewayPort, '30080');
    assert.equal(fields.gatewayPublicUrl, '10.0.0.5');
    assert.equal(fields.gatewayAuthzHost, 'lens.example.com');
    assert.equal(fields.gatewayServiceType, 'NodePort');
    assert.equal(fields.inotifyMaxUserInstances, '4096');
    assert.deepEqual(fields.selectedAccelerators, { intel: ['plugin', 'dra'] });
    assert.equal(fields.routerVersion, 'router-v1');
    assert.equal(fields.gieVersion, 'gie-v1');
    assert.equal(fields.ippVersion, 'ipp-v1');
    assert.equal(fields.lwsVersion, 'lws-v1');
    assert.equal(fields.storageKind, 'local-disk');
    assert.equal(fields.storageVolumeId, 'storage-abc12345');
    assert.equal(fields.storageCapacity, '100Gi');
    // Custom storageVolumeRef is restored into the editable storageName.
    assert.equal(fields.storageName, 'team-models');
    assert.equal(fields.hostPath, '/data/models');
    assert.equal(fields.secretNamespace, 'team-a');
    assert.equal(fields.secretName, 'hf-token-abc');
    assert.equal(fields.prewarmEnabled, true);
    assert.equal(fields.modelCacheEntryId, 'mc-abc123');
    assert.equal(fields.repoId, 'org/model');
    assert.equal(fields.revision, 'v1');
});

test('planToWizardFields leaves absent values undefined and a disabled cache explicit', () => {
    const fields = planToWizardFields({ gateway: { provider: '' } });
    assert.equal(fields.gatewayProvider, undefined);
    assert.equal(fields.prewarmEnabled, false);
    assert.equal(fields.selectedAccelerators, undefined);
    assert.equal(fields.storageKind, undefined);
    assert.equal(fields.routerVersion, undefined);
    assert.deepEqual(planToWizardFields(null), {});
});

test('proxyFieldsFromCluster restores a custom proxy instead of the auto default', () => {
    assert.deepEqual(
        proxyFieldsFromCluster({
            proxy: {
                mode: 'custom',
                httpProxy: 'http://proxy:3128',
                httpsProxy: 'http://proxy:3129',
                noProxy: 'localhost,.svc',
            },
        }),
        {
            proxyMode: 'custom',
            httpProxy: 'http://proxy:3128',
            httpsProxy: 'http://proxy:3129',
            noProxy: 'localhost,.svc',
        },
    );
    assert.deepEqual(proxyFieldsFromCluster({ proxy: { mode: 'auto' } }), {
        proxyMode: 'auto',
        httpProxy: '',
        httpsProxy: '',
        noProxy: '',
    });
    assert.equal(proxyFieldsFromCluster(null).proxyMode, 'auto');
});

test('plannedStorageVolumeName uses the actual name or the storage auto-name', () => {
    assert.equal(plannedStorageVolumeName({ storageKind: 'local-disk', storageName: 'team-models' }), 'team-models');
    assert.equal(plannedStorageVolumeName({ storageKind: 'local-disk', storageName: '' }), 'storage-local-disk');
    assert.equal(plannedStorageVolumeName({ storageKind: 'nfs', storageName: '  ' }), 'storage-nfs');
    assert.equal(plannedStorageVolumeName({ storageKind: 'none' }), null);
    // An explicit storageVolumeRef override is preserved when storageName is blank.
    assert.equal(
        plannedStorageVolumeName({ storageKind: 'local-disk', storageName: '', storageVolumeRef: 'team-models' }),
        'team-models',
    );
});

test('resume only drops the key for a missing or forbidden draft', () => {
    assert.equal(shouldClearResumeOnLoadError({ status: 404 }), true);
    assert.equal(shouldClearResumeOnLoadError({ status: 403 }), true);
    assert.equal(shouldClearResumeOnLoadError({ status: 500 }), false);
    assert.equal(shouldClearResumeOnLoadError({ status: 504 }), false);
    assert.equal(shouldClearResumeOnLoadError(new Error('network down')), false);
});

test('execution failure actions preserve 403 and block a live run', () => {
    assert.deepEqual(executionFailureAction({ code: 'execution_in_progress' }), {
        blocked: true,
        markFailed: false,
        clearRun: false,
        reclass: false,
        refreshSplit: false,
        reloadLedger: false,
        reason: 'in_progress',
    });
    assert.equal(executionFailureAction({ status: 403 }).reclass, true);
    assert.equal(executionFailureAction({ status: 403 }).clearRun, false);
    assert.equal(executionFailureAction({ code: 'kubernetes_permission_denied' }).clearRun, false);
    assert.equal(executionFailureAction({ code: 'operation_blocked' }).reclass, true);
    assert.equal(executionFailureAction({ status: 401 }).clearRun, true);
    assert.equal(executionFailureAction({ status: 504 }).clearRun, true);
    assert.equal(executionFailureAction({ status: 502 }).clearRun, true);
    assert.equal(executionFailureAction({ code: 'execution_token_invalid' }).reloadLedger, true);
    assert.equal(executionFailureAction({ code: 'permission_check_stale' }).refreshSplit, true);
    assert.deepEqual(executionFailureAction({ code: 'user_secret_required' }), {
        blocked: false,
        markFailed: true,
        clearRun: false,
        reclass: false,
        refreshSplit: false,
        reloadLedger: false,
        reason: 'secret_required',
    });
});

test('verify failure actions block a live run and refresh incomplete markers', () => {
    assert.deepEqual(verificationFailureAction({ code: 'execution_in_progress' }), {
        blocked: true,
        retainRun: true,
        refreshHandoff: false,
    });
    assert.equal(verificationFailureAction({ code: 'admin_handoff_incomplete' }).refreshHandoff, true);
    assert.equal(verificationFailureAction({ code: 'admin_handoff_stale' }).refreshHandoff, true);
    assert.equal(verificationFailureAction({ code: 'admin_handoff_unconfirmed' }).refreshHandoff, true);
});

test('versionCheckBlocks treats forbidden as a warning but blocks credentials and reachability errors', () => {
    assert.equal(versionCheckBlocks({ reachable: false, reason: 'forbidden' }), false);
    assert.equal(versionCheckBlocks({ reachable: false, reason: 'unauthorized' }), true);
    assert.equal(versionCheckBlocks({ reachable: false, reason: 'unreachable' }), true);
    assert.equal(versionCheckBlocks({ reachable: false }), true);
    assert.equal(versionCheckBlocks({ reachable: true, supported: false, version: '1.28' }), true);
    assert.equal(versionCheckBlocks({ reachable: true, supported: true }), false);
    assert.match(versionCheckMessage({ reachable: false, reason: 'unauthorized' }), /invalid or expired/);
});

test('resumeStepForPlan picks execute, review, the remembered step or proxy', () => {
    assert.equal(resumeStepForPlan(STORED_PLAN, { hasCluster: true }), 'review');
    assert.equal(resumeStepForPlan(STORED_PLAN, { hasCluster: true, finished: true }), 'execute');
    assert.equal(resumeStepForPlan(null, { hasCluster: true }), 'proxy');
    assert.equal(resumeStepForPlan(null, {}), 'basics');
    // A partial plan (Storage not configured) must not jump to Review.
    const partial = { storage: { kind: 'none' } };
    assert.equal(resumeStepForPlan(partial, { hasCluster: true }), 'proxy');
    assert.equal(resumeStepForPlan(partial, { hasCluster: true, lastStep: 'gateway' }), 'gateway');
    assert.equal(resumeStepForPlan(partial, { hasCluster: true, lastStep: 'review' }), 'proxy');
});

test('resume key round-trips through storage and clears', () => {
    const storage = memoryStorage();
    saveResumeDraftId('cluster-1', storage);
    saveResumeStep('storage', storage);
    assert.equal(loadResumeDraftId(storage), 'cluster-1');
    assert.equal(loadResumeStep(storage), 'storage');
    assert.equal(storage.snapshot()[RESUME_STORAGE_KEY], 'cluster-1');
    assert.equal(storage.snapshot()[RESUME_STEP_KEY], 'storage');
    clearResumeState(storage);
    assert.equal(loadResumeDraftId(storage), null);
    assert.equal(loadResumeStep(storage), null);
});

test('resume key tolerates missing or throwing storage', () => {
    assert.equal(loadResumeDraftId(undefined), null);
    assert.equal(loadResumeStep(undefined), null);
    const throwing = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    };
    assert.equal(loadResumeDraftId(throwing), null);
    assert.equal(loadResumeStep(throwing), null);
    assert.doesNotThrow(() => saveResumeDraftId('id', throwing));
    assert.doesNotThrow(() => saveResumeStep('storage', throwing));
    assert.doesNotThrow(() => clearResumeDraftId(throwing));
    assert.doesNotThrow(() => clearResumeState(throwing));
});

test('execution token survives a refresh per cluster and clears', () => {
    const storage = memoryStorage();
    saveExecutionToken('cluster-1', 'run-token', storage);
    assert.equal(loadExecutionToken('cluster-1', storage), 'run-token');
    assert.equal(storage.snapshot()[`${EXECUTION_TOKEN_KEY_PREFIX}cluster-1`], 'run-token');
    assert.equal(loadExecutionToken('cluster-2', storage), null);
    clearExecutionToken('cluster-1', storage);
    assert.equal(loadExecutionToken('cluster-1', storage), null);
    assert.equal(loadExecutionToken(undefined, storage), null);
    assert.doesNotThrow(() => saveExecutionToken(undefined, 'token', storage));
});

const FULL_STATE = {
    clusterId: 'cluster-1',
    gatewayProvider: 'istio',
    gatewayPort: '30080',
    gatewayPublicUrl: '10.0.0.5',
    gatewayAuthzHost: 'lens.example.com',
    inotifyMaxUserInstances: '4096',
    routerVersion: 'router-v1',
    gieVersion: 'gie-v1',
    ippVersion: 'ipp-v1',
    acceleratorVendors: [{ id: 'intel', profileId: 'intel-gpu' }],
    selectedAccelerators: { intel: ['plugin'] },
    storageKind: 'local-disk',
    storageVolumeId: 'storage-abc12345',
    storageCapacity: '100Gi',
    storageName: 'team-models',
    hostPath: '/data/models',
    prewarmEnabled: true,
    repoId: 'org/model',
    revision: 'main',
    secretNamespace: 'team-a',
    secretName: 'hf-token-abc',
    hfToken: 'hf_test',
};

test('planFromWizardState emits a valid plan with gateway defaults and the cache', () => {
    const plan = planFromWizardState(FULL_STATE);
    assert.equal(plan.gateway.provider, 'istio');
    assert.equal(plan.gateway.namespace, GATEWAY_DEFAULTS.namespace);
    assert.equal(plan.gateway.name, GATEWAY_DEFAULTS.name);
    assert.equal(plan.gateway.port, 30080);
    assert.deepEqual(plan.accelerators, [
        { vendor: 'intel', model: null, mode: 'plugin', operator: null, profile: 'intel-gpu', rbac: [] },
    ]);
    assert.equal(plan.storage.kind, 'local-disk');
    assert.equal(plan.storage.volumeId, 'storage-abc12345');
    assert.deepEqual(plan.storage.purposes, ['model-cache']);
    assert.equal(plan.modelCache.enabled, true);
    assert.equal(plan.modelCache.storageVolumeRef, 'team-models');
    assert.equal(plan.hfTokenSecret.secretNamespace, 'team-a');
    assert.equal(plan.runtime.inotifyLimit, 4096);
    assert.equal(plan.stack.imagePrepullEnabled, true);
    assert.equal(plan.stack.routerVersion, 'router-v1');
    assert.equal(plan.stack.gieVersion, 'gie-v1');
    assert.equal(plan.stack.ippVersion, 'ipp-v1');
});

test('planFromWizardState keeps the backend effective gateway namespace on later saves', () => {
    const plan = planFromWizardState({ ...FULL_STATE, gatewayNamespace: 'lens-gateway-abc123' });
    assert.equal(plan.gateway.namespace, 'lens-gateway-abc123');
    // Without a stored effective namespace a new plan starts from the default.
    assert.equal(planFromWizardState(FULL_STATE).gateway.namespace, GATEWAY_DEFAULTS.namespace);
});

test('planFromWizardState references the actual storage volume name', () => {
    const named = planFromWizardState({ ...FULL_STATE, storageName: 'team-models' });
    assert.equal(named.modelCache.storageVolumeRef, 'team-models');
    const autoNamed = planFromWizardState({ ...FULL_STATE, storageName: '' });
    assert.equal(autoNamed.modelCache.storageVolumeRef, 'storage-local-disk');
    assert.notEqual(autoNamed.modelCache.storageVolumeRef, 'model-cache');
});

test('planFromWizardState keeps early steps valid by deferring storage and cache', () => {
    const early = planConfigFromWizardState({
        ...FULL_STATE,
        storageCapacity: '',
        prewarmEnabled: true,
    });
    assert.deepEqual(early.storage, { kind: 'none' });
    assert.equal(early.modelCache.enabled, false);
    assert.equal(early.modelCache.storageVolumeRef, null);
    // The plan still carries the gateway/secret fields the backend requires.
    assert.equal(early.gateway.provider, 'istio');
    assert.equal(early.hfTokenSecret.secretNamespace, 'team-a');
});

test('planFromWizardState falls back to the cluster-scoped secret namespace', () => {
    const plan = planFromWizardState({ ...FULL_STATE, secretNamespace: '' });
    assert.equal(plan.hfTokenSecret.secretNamespace, 'llm-d-bench-storage-cluster-1');
    assert.equal(plan.hfTokenSecret.secretNamespaceMode, 'create');
});

test('storageStepValid requires the path and capacity for each kind', () => {
    assert.equal(storageStepValid({ storageKind: 'local-disk', hostPath: '/data', storageCapacity: '1Gi' }), true);
    assert.equal(storageStepValid({ storageKind: 'local-disk', hostPath: 'data', storageCapacity: '1Gi' }), false);
    assert.equal(storageStepValid({ storageKind: 'local-disk', hostPath: '/data', storageCapacity: '1G' }), false);
    assert.equal(storageStepValid({ storageKind: 'nfs', nfsServer: 'nfs', nfsPath: '/export', storageCapacity: '1Ti' }), true);
    assert.equal(storageStepValid({ storageKind: 'nfs', nfsServer: '', nfsPath: '/export', storageCapacity: '1Ti' }), false);
});

test('wizardStepCanAdvance encodes each step gate', () => {
    const base = {
        name: 'cluster',
        file: {},
        proxyMode: 'auto',
        gatewayProvider: 'istio',
        gatewayAuthzHost: 'lens',
        hfToken: 'hf',
        secretNamespace: 'ns',
        secretName: 'name',
        prewarmEnabled: false,
        storageKind: 'local-disk',
        storageCapacity: '1Gi',
        hostPath: '/data',
        permissionsSufficient: true,
        permissionsFresh: true,
    };
    for (const step of ['basics', 'proxy', 'gateway', 'accelerator', 'versions', 'modelCache', 'storage', 'review']) {
        assert.equal(wizardStepCanAdvance(step, base), true, step);
    }
    assert.equal(wizardStepCanAdvance('execute', base), false);
    assert.equal(wizardStepCanAdvance('basics', { ...base, file: null, clusterId: 'c1' }), true);
    assert.equal(wizardStepCanAdvance('basics', { ...base, file: null }), false);
    assert.equal(wizardStepCanAdvance('modelCache', { ...base, hfToken: '' }), false);
    assert.equal(wizardStepCanAdvance('storage', { ...base, storageCapacity: 'bad' }), false);
    assert.equal(wizardStepCanAdvance('review', { ...base, permissionsFresh: false }), false);
    assert.equal(wizardStepCanAdvance('review', { ...base, hfToken: '' }), false);
    assert.equal(wizardStepCanAdvance('review', { ...base, hfToken: '', hfTokenSaved: true }), true);
    assert.equal(wizardStepCanAdvance('review', { ...base, hfToken: '', hfTokenExternal: true }), true);
    assert.equal(wizardStepCanAdvance('review', { ...base, hfToken: '', executionCompleted: true }), true);
    assert.equal(
        wizardStepCanAdvance('review', {
            ...base,
            hfToken: '',
            hasExecutionToken: true,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        true,
    );
    assert.equal(
        wizardStepCanAdvance('review', {
            ...base,
            hfToken: '',
            hasExecutionToken: false,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        false,
    );
});

test('hfTokenSecretValid accepts typed, draft-saved, or external secrets', () => {
    const base = { secretNamespace: 'ns', secretName: 'hf-token-1' };
    assert.equal(hfTokenSecretValid(base), false);
    assert.equal(hfTokenSecretValid({ ...base, hfToken: '   ' }), false);
    assert.equal(hfTokenSecretValid({ ...base, hfToken: 'hf_abc' }), true);
    assert.equal(hfTokenSecretValid({ ...base, hfTokenSaved: true }), true);
    assert.equal(hfTokenSecretValid({ ...base, hfTokenExternal: true }), true);
    assert.equal(hfTokenSecretValid({ secretNamespace: '', secretName: 'hf-token-1', hfTokenSaved: true }), false);
    assert.equal(hfTokenSecretValid({ secretNamespace: 'ns', secretName: '', hfTokenSaved: true }), false);
});

test('hfTokenSatisfiedForRun honors typed, saved, external, completed, and active-run ledger state', () => {
    assert.equal(hfTokenSatisfiedForRun({}), false);
    assert.equal(hfTokenSatisfiedForRun({ hfToken: '   ' }), false);
    assert.equal(hfTokenSatisfiedForRun({ hfToken: 'hf_abc' }), true);
    assert.equal(hfTokenSatisfiedForRun({ hfTokenSaved: true }), true);
    assert.equal(hfTokenSatisfiedForRun({ hfTokenExternal: true }), true);
    assert.equal(hfTokenSatisfiedForRun({ executionCompleted: true }), true);
    assert.equal(
        hfTokenSatisfiedForRun({
            hasExecutionToken: true,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        true,
    );
    assert.equal(
        hfTokenSatisfiedForRun({
            hasExecutionToken: false,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        false,
    );
    assert.equal(
        hfTokenSatisfiedForRun({
            hasExecutionToken: true,
            operationLedger: { 'cache.hf-secret': 'failed' },
        }),
        false,
    );
});


test('operation execution requires a token after admin verification', () => {
    assert.equal(canExecuteOperationRun({ reportStatus: 'ready' }), true);
    assert.equal(canExecuteOperationRun({ reportStatus: 'blocked', adminVerified: true, hasToken: true }), false);
    assert.equal(canExecuteOperationRun({ reportStatus: 'admin_required', adminVerified: true, hasToken: false }), false);
    assert.equal(canExecuteOperationRun({ reportStatus: 'admin_required', adminVerified: true, hasToken: true }), true);
    assert.equal(canExecuteOperationRun({ reportStatus: 'admin_required', adminVerified: false, hasToken: true }), false);
    assert.equal(canExecuteOperationRun({ reportStatus: 'ready', busy: true }), false);
});

test('operation ledger is reused only for a live token and cleared on plan change', () => {
    const ledger = { 'gateway.manifests': 'user_done' };
    assert.deepEqual(operationLedgerForRun(ledger, { hasToken: true }), ledger);
    assert.deepEqual(operationLedgerForRun(ledger, { hasToken: false }), {});
    assert.equal(planInvalidatesRun('plan-a', 'plan-b'), true);
    assert.equal(planInvalidatesRun('plan-a', 'plan-a'), false);
    assert.equal(planInvalidatesRun(null, 'plan-a'), false);
});


test('verify refreshes the ledger for a new token and preserves a 403 re-split token', () => {
    assert.equal(verifyRefreshesOperationLedger(null, 'token-b'), true);
    assert.equal(verifyRefreshesOperationLedger('token-a', 'token-b'), true);
    assert.equal(verifyRefreshesOperationLedger('token-a', 'token-a'), false);
    assert.equal(verifyRefreshesOperationLedger('token-a', null), false);
});


test('fresh verify ledger drives operation progress instead of stale operations', () => {
    const report = {
        userOperations: [
            { id: 'gateway.manifests', title: 'Gateway' },
            { id: 'storage.pvc', title: 'Storage claim' },
        ],
    };
    const stale = { 'gateway.manifests': 'user_done', 'storage.pvc': 'user_done' };
    const fresh = { 'gateway.manifests': 'admin_done' };

    assert.deepEqual(operationProgressForLedger(report, stale).map((item) => item.state), ['done', 'done']);
    assert.deepEqual(operationProgressForLedger(report, fresh).map((item) => item.state), ['done', 'pending']);
});


test('resume is disabled while verify or resume is busy', () => {
    const ready = {
        hasFailedOperation: true,
        permissionsSufficient: true,
        hasSecretInput: true,
    };
    assert.equal(canResumeOperationRun(ready), true);
    assert.equal(canResumeOperationRun({ ...ready, busy: true }), false);
    assert.equal(canResumeOperationRun({ ...ready, executionBlocked: true }), false);
    assert.equal(canResumeOperationRun({ ...ready, hasSecretInput: false }), false);
});


test('verify hitting a live run waits and preserves the run', () => {
    assert.equal(verificationBlocksRun({ code: 'execution_in_progress' }), true);
    assert.equal(verificationBlocksRun({ code: 'admin_handoff_incomplete' }), false);
});


test('stale completion timestamp does not look like a completed current run', () => {
    assert.equal(executionCompletedForPlan({ planHash: 'plan-a', executionCompletedAt: '2026-01-01T00:00:00Z' }), false);
    assert.equal(
        executionCompletedForPlan({
            planHash: 'plan-a',
            executionCompletedAt: '2026-01-01T00:00:00Z',
            executionCompletedPlanHash: 'plan-b',
        }),
        false,
    );
    assert.equal(
        executionCompletedForPlan({
            planHash: 'plan-a',
            executionCompletedAt: '2026-01-01T00:00:00Z',
            executionCompletedPlanHash: 'plan-a',
        }),
        true,
    );
});


test('resume gate lets the StrictMode remount win and clear loading once', () => {
    const gate = createResumeGate();
    const first = gate.begin();
    const second = gate.begin();
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
});

test('a blocked report loads a handoff only when it has admin operations', () => {
    assert.equal(shouldLoadHandoff({ status: 'admin_required', adminOperations: [{ id: 'gateway' }] }), true);
    assert.equal(shouldLoadHandoff({ status: 'blocked', adminOperations: [{ id: 'gateway' }] }), true);
    assert.equal(shouldLoadHandoff({ status: 'blocked', adminOperations: [] }), false);
    assert.equal(shouldLoadHandoff({ status: 'ready', adminOperations: [{ id: 'gateway' }] }), false);
});

test('resumed plan keeps hash-relevant hidden fields on a later save', () => {
    const fields = planToWizardFields(STORED_PLAN);
    const plan = planFromWizardState({ ...FULL_STATE, ...fields });
    assert.equal(plan.gateway.serviceType, 'NodePort');
    assert.equal(plan.storage.volumeId, 'storage-abc12345');
    assert.equal(plan.modelCache.entryId, 'mc-abc123');
    assert.equal(plan.modelCache.storageVolumeRef, 'team-models');
    assert.equal(plan.stack.lwsVersion, 'lws-v1');
});


test('all nine wizard step icons use the light brand accent and keep dark sky', () => {
    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    const expected = 'className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400"';
    assert.equal(source.split(expected).length - 1, 9);
    assert.equal(source.split('className="h-5 w-5 text-sky-400"').length - 1, 0);
});


test('admin verification requires a complete marker and no remaining operations', () => {
    assert.equal(adminVerificationReady(null), false);
    assert.equal(adminVerificationReady({ status: 'partial', remainingOperations: [], marker: { verified: true } }), false);
    assert.equal(adminVerificationReady({ status: 'complete', remainingOperations: ['gateway'], marker: { verified: true } }), false);
    assert.equal(adminVerificationReady({ status: 'complete', remainingOperations: [], marker: { verified: true } }), true);
});

test('remaining admin work keeps Execute and Resume disabled even with a token', () => {
    const adminVerified = adminVerificationReady({
        status: 'partial',
        remainingOperations: ['gateway.manifests'],
        marker: { verified: true },
    });
    assert.equal(adminVerified, false);
    assert.equal(
        canExecuteOperationRun({ reportStatus: 'admin_required', adminVerified, hasToken: true }),
        false,
    );
    assert.equal(
        canResumeOperationRun({
            hasFailedOperation: true,
            permissionsSufficient: adminVerified,
            hasSecretInput: true,
        }),
        false,
    );
});


test('Preflight needs a saved plan, idle state and a secret input', () => {
    const ready = {
        hasCluster: true,
        planHash: 'plan-hash',
        hasSecretInput: true,
        permissionBusy: false,
        handoffBusy: false,
        resumeBusy: false,
        finishing: false,
        executionBlocked: false,
    };
    assert.equal(canRunPreflight(ready), true);
    assert.equal(canRunPreflight({ ...ready, hasCluster: false }), false);
    assert.equal(canRunPreflight({ ...ready, planHash: null }), false);
    assert.equal(canRunPreflight({ ...ready, hasSecretInput: false }), false);
    assert.equal(canRunPreflight({ ...ready, permissionBusy: true }), false);
    assert.equal(canRunPreflight({ ...ready, handoffBusy: true }), false);
    assert.equal(canRunPreflight({ ...ready, resumeBusy: true }), false);
    assert.equal(canRunPreflight({ ...ready, finishing: true }), false);
    assert.equal(canRunPreflight({ ...ready, executionBlocked: true }), false);
});

test('canNavigateBackFromExecute allows Back when idle and blocks while busy or finished', () => {
    assert.equal(canNavigateBackFromExecute(), true);
    assert.equal(canNavigateBackFromExecute({ finished: true }), false);
    assert.equal(canNavigateBackFromExecute({ finishing: true }), false);
    assert.equal(canNavigateBackFromExecute({ cancelling: true }), false);
    assert.equal(canNavigateBackFromExecute({ permissionBusy: true }), false);
    assert.equal(canNavigateBackFromExecute({ handoffBusy: true }), false);
    assert.equal(canNavigateBackFromExecute({ executionBlocked: true }), false);
});

test('nextExecutionCompleted is preserved for an unchanged plan and cleared by a plan change', () => {
    assert.equal(nextExecutionCompleted(true, 'old', 'new'), false);
    assert.equal(nextExecutionCompleted(true, 'same', 'same'), true);
    assert.equal(nextExecutionCompleted(false, 'old', 'new'), false);
});

test('only resuming to an unfinished Execute step auto-runs the permission check', () => {
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: true, finished: false, resumeStep: 'execute' }), true);
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: true, finished: true, resumeStep: 'execute' }), false);
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: false, finished: false, resumeStep: 'execute' }), false);
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: true, finished: false, resumeStep: 'review' }), false);
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: true, finished: false, resumeStep: 'storage' }), false);
    assert.equal(shouldAutoCheckResumedPlan({ hasPlan: true, finished: false, resumeStep: 'proxy' }), false);
});

test('Review step is a pure plan preview and Execute owns permission preflight UI', () => {
    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    assert.match(source, /\{\s*id:\s*'review',\s*label:\s*'Review',\s*icon:\s*ListChecks\s*\}/);
    assert.equal(source.includes('Review and permissions'), false);
    assert.equal(source.split('<PermissionHandoffPanel').length - 1, 1);

    const reviewStart = source.indexOf('{stepIndex === REVIEW_STEP_INDEX && (');
    const executeStart = source.indexOf('{stepIndex === EXECUTE_STEP_INDEX && (');
    assert.ok(reviewStart > 0 && executeStart > reviewStart);
    const reviewSection = source.slice(reviewStart, executeStart);
    assert.match(reviewSection, /Provisioning plan/);
    assert.equal(reviewSection.includes('Plan summary'), false);
    assert.equal(reviewSection.includes('PermissionHandoffPanel'), false);
    assert.equal(reviewSection.includes('permissionError'), false);
    assert.equal(reviewSection.includes('permissionBusy'), false);
    assert.equal(reviewSection.includes('permissionReady'), false);
    assert.equal(reviewSection.includes('llmDRepoPath'), false);

    const executeSection = source.slice(executeStart);
    assert.match(executeSection, /<PermissionHandoffPanel/);
    assert.match(executeSection, /onEditSecretNamespace=/);
    assert.match(executeSection, /onRecheck=/);
    assert.equal(executeSection.includes('onVerify='), false);
    assert.equal(source.includes('verifyHandoff'), false);
    assert.match(executeSection, /Checking permissions…/);
    assert.equal(source.split('permissionsSufficient: !permissionBlocked && (permissionReady || adminVerified)').length - 1, 2);
});

test('CreateClusterWizard persists draft HF token on save/inline and omits stale resume warning', () => {
    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    assert.equal(source.includes('It is not restored on resume.'), false);
    assert.match(source, /saveDraftHfToken\(/);
    assert.match(source, /Saved for this draft/);
    assert.match(source, /autoComplete="new-password"/);
    assert.match(source, /if \(operation\?\.secretCopy\) return undefined;/);
    assert.match(source, /action\.reason === 'secret_required'/);
    assert.match(
        source,
        /const wizardState = \{[\s\S]*operationLedger,[\s\S]*hasExecutionToken: Boolean\(executionToken\),[\s\S]*executionCompleted,/,
    );
});

test('kubeconfigNamespace defaults secretNamespace, existing mode, and handoff.namespace', () => {
    const plan = planFromWizardState({
        ...FULL_STATE,
        secretNamespace: '',
        kubeconfigNamespace: 'lens-edit',
    });
    assert.equal(plan.hfTokenSecret.secretNamespace, 'lens-edit');
    assert.equal(plan.hfTokenSecret.secretNamespaceMode, 'existing');
    assert.equal(plan.handoff.namespace, 'lens-edit');

    const customHandoff = planFromWizardState({
        ...FULL_STATE,
        secretNamespace: 'lens-edit',
        secretNamespaceMode: 'existing',
        kubeconfigNamespace: 'lens-edit',
        handoffNamespace: 'custom-handoff',
    });
    assert.equal(customHandoff.handoff.namespace, 'custom-handoff');

    const restored = planToWizardFields(customHandoff);
    assert.equal(restored.secretNamespaceMode, 'existing');
    assert.equal(restored.handoffNamespace, 'custom-handoff');
});

test('shouldAutoVerifyHandoff triggers once until token and admin_done ledger are present', () => {
    const complete = {
        status: 'complete',
        adminOperations: ['gateway.namespace', 'gateway.manifests'],
        remainingOperations: [],
        marker: { status: 'complete', verified: true },
    };
    assert.equal(shouldAutoVerifyHandoff(null), false);
    assert.equal(shouldAutoVerifyHandoff({ ...complete, status: 'partial' }), false);
    assert.equal(shouldAutoVerifyHandoff({ ...complete, remainingOperations: ['gateway.manifests'] }), false);
    assert.equal(shouldAutoVerifyHandoff(complete, { hasToken: false, ledger: {} }), true);
    assert.equal(
        shouldAutoVerifyHandoff(complete, {
            hasToken: true,
            ledger: { 'gateway.namespace': 'admin_done', 'gateway.manifests': 'failed_permission' },
        }),
        true,
    );
    assert.equal(
        shouldAutoVerifyHandoff(complete, {
            hasToken: true,
            ledger: { 'gateway.namespace': 'admin_done', 'gateway.manifests': 'admin_done' },
        }),
        false,
    );
    // force: true re-verifies a complete marker even when token + ledger are already present,
    // but never fires on non-complete or remaining-operation handoffs.
    assert.equal(
        shouldAutoVerifyHandoff(complete, {
            hasToken: true,
            ledger: { 'gateway.namespace': 'admin_done', 'gateway.manifests': 'admin_done' },
            force: true,
        }),
        true,
    );
    for (const status of ['missing', 'partial', 'stale']) {
        assert.equal(
            shouldAutoVerifyHandoff({ ...complete, status }, { hasToken: true, ledger: {}, force: true }),
            false,
        );
    }
    assert.equal(
        shouldAutoVerifyHandoff(
            { ...complete, remainingOperations: ['gateway.manifests'] },
            { hasToken: true, ledger: {}, force: true },
        ),
        false,
    );
});

test('handoffFallbackFromVerifyError maps verify error codes to non-ready handoff states', () => {
    const priorStatus = {
        status: 'complete',
        adminOperations: ['gateway.namespace', 'gateway.manifests'],
        remainingOperations: [],
        marker: { namespace: 'lens-edit', name: 'lens-admin-handoff-plan', status: 'complete', verified: true },
    };
    const cases = [
        ['admin_handoff_stale', 'stale'],
        ['admin_handoff_unconfirmed', 'unconfirmed'],
        ['admin_handoff_unknown', 'unknown'],
        ['admin_handoff_incomplete', 'partial'],
    ];
    for (const [code, expectedStatus] of cases) {
        const fallback = handoffFallbackFromVerifyError(
            { code },
            priorStatus,
            {
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.manifests'],
                marker: { namespace: 'lens-edit', name: 'lens-admin-handoff-plan', status: expectedStatus, verified: false },
            },
        );
        assert.equal(fallback.status, expectedStatus);
        assert.equal(adminVerificationReady(fallback), false);
        assert.deepEqual(fallback.adminOperations, ['gateway.namespace', 'gateway.manifests']);
        assert.deepEqual(fallback.remainingOperations, ['gateway.manifests']);
        assert.equal(fallback.marker.name, 'lens-admin-handoff-plan');
        assert.equal(fallback.marker.status, expectedStatus);
        assert.equal(fallback.marker.verified, false);
    }
});

test('operationProgressForLedger includes deduplicated admin and user operations', () => {
    const report = {
        adminOperations: [
            { id: 'gateway.namespace', title: 'Create the gateway namespace' },
            { id: 'gateway.manifests', title: 'Apply the shared inference Gateway' },
        ],
        userOperations: [
            { id: 'gateway.manifests', title: 'Apply the shared inference Gateway' },
            { id: 'cache.hf-secret', title: 'Write the HF token Secret' },
        ],
    };
    const beforeVerify = operationProgressForLedger(report, {});
    assert.deepEqual(beforeVerify.map((row) => [row.key, row.state]), [
        ['gateway.namespace', 'pending'],
        ['gateway.manifests', 'pending'],
        ['cache.hf-secret', 'pending'],
    ]);

    const afterVerify = operationProgressForLedger(report, {
        'gateway.namespace': 'admin_done',
        'gateway.manifests': 'admin_done',
    });
    assert.deepEqual(afterVerify.map((row) => [row.key, row.state]), [
        ['gateway.namespace', 'done'],
        ['gateway.manifests', 'done'],
        ['cache.hf-secret', 'pending'],
    ]);
});

test('planToWizardFields restores custom storageName across cache modes and edge cases', () => {
    assert.equal(
        planToWizardFields({
            storage: { kind: 'local-disk' },
            model_cache: { enabled: false, storage_volume_ref: '  custom-cache  ' },
        }).storageName,
        'custom-cache',
    );
    assert.equal(
        planToWizardFields({
            storage: { kind: 'dynamic-pvc' },
            modelCache: { enabled: false, storageVolumeRef: 'pvc-models' },
        }).storageName,
        'pvc-models',
    );
    assert.equal(
        planToWizardFields({
            storage: { kind: 'none' },
            modelCache: { enabled: true, storageVolumeRef: 'stale-models' },
        }).storageName,
        undefined,
    );
    assert.equal(
        planToWizardFields({
            storage: { kind: 'local-disk' },
            modelCache: { enabled: true },
        }).storageName,
        undefined,
    );
});

test('planToWizardFields leaves auto-named storageName blank and preserves cross-kind literals', () => {
    assert.equal(
        planToWizardFields({
            storage: { kind: 'local-disk' },
            modelCache: { storageVolumeRef: 'storage-local-disk' },
        }).storageName,
        '',
    );
    assert.equal(
        planToWizardFields({
            storage: { kind: 'nfs' },
            modelCache: { storageVolumeRef: 'storage-nfs' },
        }).storageName,
        '',
    );
    assert.equal(
        planToWizardFields({
            storage: { kind: 'local-disk' },
            modelCache: { storageVolumeRef: 'storage-nfs' },
        }).storageName,
        'storage-nfs',
    );
});

test('resumed storageName recomputes auto-name on kind switch or clearing custom name', () => {
    const autoFields = planToWizardFields({
        ...STORED_PLAN,
        storage: { ...STORED_PLAN.storage, kind: 'local-disk' },
        modelCache: { ...STORED_PLAN.modelCache, storageVolumeRef: 'storage-local-disk' },
    });
    assert.equal(autoFields.storageName, '');
    const switchedPlan = planFromWizardState({
        ...FULL_STATE,
        ...autoFields,
        storageKind: 'nfs',
        nfsServer: '10.0.0.2',
        nfsPath: '/exports/models',
    });
    assert.equal(switchedPlan.modelCache.storageVolumeRef, 'storage-nfs');

    const customFields = planToWizardFields(STORED_PLAN);
    assert.equal(customFields.storageName, 'team-models');
    assert.equal(
        planFromWizardState({ ...FULL_STATE, ...customFields, storageName: '' }).modelCache.storageVolumeRef,
        'storage-local-disk',
    );
    assert.equal(
        planFromWizardState({ ...FULL_STATE, ...customFields, storageName: '   ' }).modelCache.storageVolumeRef,
        'storage-local-disk',
    );
});

test('planSyncFromPermissionReport extracts aligned plan, hashes, and planChanged flag', () => {
    const alignedPlan = {
        ...STORED_PLAN,
        hfTokenSecret: {
            tokenSource: 'create-secret',
            secretName: 'hf-token-abc',
            secretNamespace: 'lens-edit',
            secretNamespaceMode: 'existing',
        },
        handoff: { namespace: 'lens-edit' },
    };
    const changed = planSyncFromPermissionReport(
        { plan: alignedPlan, planHash: 'hash-2', planVersion: 3 },
        { currentPlanHash: 'hash-1' },
    );
    assert.deepEqual(changed, {
        plan: alignedPlan,
        planHash: 'hash-2',
        planVersion: 3,
        secretNamespace: 'lens-edit',
        secretNamespaceMode: 'existing',
        storageNamespace: null,
        storageNamespaceMode: null,
        monitoringNamespace: null,
        handoffNamespace: 'lens-edit',
        planChanged: true,
    });

    const unchanged = planSyncFromPermissionReport(
        { plan: alignedPlan, planHash: 'hash-1', planVersion: 0 },
        { currentPlanHash: 'hash-1' },
    );
    assert.equal(unchanged.planVersion, 0);
    assert.equal(unchanged.planChanged, false);

    const initial = planSyncFromPermissionReport(
        { plan: alignedPlan, planHash: 'hash-1', planVersion: 1 },
        { currentPlanHash: null },
    );
    assert.equal(initial.planChanged, false);

    assert.deepEqual(planSyncFromPermissionReport(null, { currentPlanHash: 'hash-1' }), {
        plan: null,
        planHash: null,
        planVersion: null,
        secretNamespace: null,
        secretNamespaceMode: null,
        storageNamespace: null,
        storageNamespaceMode: null,
        monitoringNamespace: null,
        handoffNamespace: null,
        planChanged: false,
    });
});

test('CreateClusterWizard syncs auto-aligned plans across savePlan and all permissionCheck call sites', () => {
    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');

    // savePlan adopts secretNamespace and marks it touched alongside mode and handoff.
    const savePlanMatch = source.match(/const savePlan = async \(\) => \{[\s\S]*?\n    \};/);
    assert.ok(savePlanMatch);
    assert.match(savePlanMatch[0], /savedPlan\.hfTokenSecret\?\.secretNamespace\)\s*\{[\s\S]*?setSecretNamespace\(savedPlan\.hfTokenSecret\.secretNamespace\)[\s\S]*?setSecretNamespaceTouched\(true\)/);

    // adoptPermissionCheckPlan syncs fields and clears stale run state when planChanged is true.
    const adoptMatch = source.match(/const adoptPermissionCheckPlan = useCallback\(\(report, clusterId, currentPlanHash\) => \{[\s\S]*?\n    \}, \[\]\);/);
    assert.ok(adoptMatch);
    assert.match(adoptMatch[0], /planSyncFromPermissionReport\(report, \{ currentPlanHash \}\)/);
    assert.match(adoptMatch[0], /setSecretNamespace\(sync\.secretNamespace\)/);
    assert.match(adoptMatch[0], /setSecretNamespaceTouched\(true\)/);
    assert.match(adoptMatch[0], /setSecretNamespaceMode\(sync\.secretNamespaceMode\)/);
    assert.match(adoptMatch[0], /setHandoffNamespace\(sync\.handoffNamespace\)/);
    assert.match(adoptMatch[0], /setPlanHash\(sync\.planHash\)/);
    assert.match(adoptMatch[0], /setPlanVersion\(sync\.planVersion\)/);
    assert.match(adoptMatch[0], /if \(sync\.planChanged\)/);
    assert.match(adoptMatch[0], /setExecutionCompleted\(/);
    assert.match(adoptMatch[0], /setExecutionToken\(null\)/);
    assert.match(adoptMatch[0], /setOperationLedger\(\{\}\)/);
    assert.match(adoptMatch[0], /setExecutionFailedKey\(null\)/);
    assert.match(adoptMatch[0], /setRemediationScript\(''\)/);
    assert.match(adoptMatch[0], /setRemediationInfo\(null\)/);
    assert.match(adoptMatch[0], /setHandoffInfo\(null\)/);
    assert.match(adoptMatch[0], /clearExecutionToken\(clusterId\)/);

    // Every permissionCheck(...) invocation wires adoptPermissionCheckPlan and effective ledger/token.
    assert.equal(source.split('permissionCheck(').length - 1, 3);
    assert.equal(source.split('adoptPermissionCheckPlan(report,').length - 1, 3);
    assert.match(source, /adoptPermissionCheckPlan\(report, resumedCluster\.id, detail\?\.planHash \|\| null\)/);
    assert.match(source, /const effectiveLedger = sync\.planChanged \? \{\} : resumedLedger/);
    assert.match(source, /const effectiveToken = sync\.planChanged \? null : resumedToken/);
    assert.match(source, /shouldAutoVerifyHandoff\(status, \{ hasToken: Boolean\(effectiveToken\), ledger: effectiveLedger, force: true \}\)/);
    assert.equal(source.split('adoptPermissionCheckPlan(report, clusterId, planHash)').length - 1, 2);
});

test('clusterDetailSyncForReport extracts ledger, draftHfTokenSaved, and safely aligns plan/namespaces', () => {
    assert.deepEqual(clusterDetailSyncForReport(null), {
        hasDetail: false,
        ledger: {},
        draftHfTokenSaved: null,
        alignPlan: false,
        plan: null,
        planHash: null,
        planVersion: null,
        secretNamespace: null,
        secretNamespaceMode: null,
        storageNamespace: null,
        storageNamespaceMode: null,
        monitoringNamespace: null,
        handoffNamespace: null,
    });

    const alignedPlan = {
        ...STORED_PLAN,
        storage: {
            ...STORED_PLAN.storage,
            namespace: 'lens-edit',
            namespaceMode: 'existing',
        },
        hfTokenSecret: {
            tokenSource: 'create-secret',
            secretName: 'hf-token-abc',
            secretNamespace: 'lens-edit',
            secretNamespaceMode: 'existing',
        },
        handoff: { namespace: 'lens-edit' },
    };

    const matchingReport = clusterDetailSyncForReport(
        {
            executionOperations: { 'gateway.manifests': 'admin_done' },
            draftHfTokenSaved: true,
            plan: alignedPlan,
            planHash: 'hash-report',
            planVersion: 4,
        },
        { reportPlanHash: 'hash-report', currentPlanHash: 'hash-drifted' },
    );
    assert.deepEqual(matchingReport, {
        hasDetail: true,
        ledger: { 'gateway.manifests': 'admin_done' },
        draftHfTokenSaved: true,
        alignPlan: true,
        plan: alignedPlan,
        planHash: 'hash-report',
        planVersion: 4,
        secretNamespace: 'lens-edit',
        secretNamespaceMode: 'existing',
        storageNamespace: 'lens-edit',
        storageNamespaceMode: 'existing',
        monitoringNamespace: null,
        handoffNamespace: 'lens-edit',
    });

    const initialMissingCurrent = clusterDetailSyncForReport(
        {
            executionOperations: {},
            draftHfTokenSaved: false,
            plan: alignedPlan,
            planHash: 'hash-1',
            planVersion: 0,
        },
        { reportPlanHash: null, currentPlanHash: null },
    );
    assert.equal(initialMissingCurrent.alignPlan, true);
    assert.equal(initialMissingCurrent.planVersion, 0);
    assert.equal(initialMissingCurrent.draftHfTokenSaved, false);
    assert.equal(initialMissingCurrent.secretNamespace, 'lens-edit');

    const mismatchedReport = clusterDetailSyncForReport(
        {
            executionOperations: { 'gateway.manifests': 'admin_done' },
            plan: alignedPlan,
            planHash: 'hash-old',
            planVersion: 2,
        },
        { reportPlanHash: 'hash-new', currentPlanHash: 'hash-new' },
    );
    assert.equal(mismatchedReport.alignPlan, false);
    assert.equal(mismatchedReport.plan, null);
    assert.equal(mismatchedReport.planHash, null);
    assert.equal(mismatchedReport.planVersion, null);
    assert.equal(mismatchedReport.secretNamespace, null);
    assert.equal(mismatchedReport.secretNamespaceMode, null);
    assert.equal(mismatchedReport.handoffNamespace, null);

    const noReportWithCurrent = clusterDetailSyncForReport(
        {
            executionOperations: {},
            plan: alignedPlan,
            planHash: 'hash-old',
            planVersion: 2,
        },
        { reportPlanHash: null, currentPlanHash: 'hash-current' },
    );
    assert.equal(noReportWithCurrent.alignPlan, false);
    assert.equal(noReportWithCurrent.plan, null);
    assert.equal(noReportWithCurrent.secretNamespace, null);
});

test('executeDisabledReason covers every settled non-executable state without duplicating active callouts', () => {
    const base = {
        canExecute: false,
        finished: false,
        finishing: false,
        permissionBusy: false,
        handoffBusy: false,
        resumeBusy: false,
        executionBlocked: false,
        canResume: false,
        hasCluster: true,
        hasPlan: true,
        hasReport: true,
        reportStatus: 'ready',
        hasPermissionError: false,
        permissionsFresh: true,
        hasHfToken: true,
        adminVerified: true,
        hasToken: true,
        hasAdminOperations: true,
    };

    for (const key of [
        'canExecute',
        'finished',
        'finishing',
        'permissionBusy',
        'handoffBusy',
        'resumeBusy',
        'executionBlocked',
        'canResume',
        'hasPermissionError',
    ]) {
        assert.equal(executeDisabledReason({ ...base, [key]: true }), null, key);
    }

    assert.equal(executeDisabledReason({ ...base, hasCluster: false })?.code, 'missing_cluster');
    assert.equal(executeDisabledReason({ ...base, hasCluster: false })?.canRecheck, false);

    assert.equal(executeDisabledReason({ ...base, hasPlan: false })?.code, 'missing_plan');
    assert.equal(executeDisabledReason({ ...base, hasPlan: false })?.canRecheck, true);

    assert.equal(executeDisabledReason({ ...base, hasReport: false })?.code, 'missing_report');
    assert.equal(executeDisabledReason({ ...base, hasReport: false })?.canRecheck, true);

    // Stale plan takes priority over blocked/admin_required/missing HF callouts.
    assert.equal(
        executeDisabledReason({
            ...base,
            permissionsFresh: false,
            reportStatus: 'blocked',
            hasHfToken: false,
            adminVerified: false,
            hasToken: false,
        })?.code,
        'stale_plan',
    );

    assert.equal(executeDisabledReason({ ...base, reportStatus: 'blocked' }), null);
    assert.equal(executeDisabledReason({ ...base, reportStatus: 'admin_required', adminVerified: false }), null);
    assert.equal(executeDisabledReason({ ...base, reportStatus: 'admin_required', hasToken: false }), null);
    assert.equal(executeDisabledReason({ ...base, hasHfToken: false }), null);

    // Anomalous empty-admin admin_required falls through to catch-all recovery banner.
    assert.equal(
        executeDisabledReason({
            ...base,
            reportStatus: 'admin_required',
            hasAdminOperations: false,
            adminVerified: false,
            hasToken: false,
        })?.code,
        'unknown',
    );
    assert.equal(executeDisabledReason(base)?.code, 'unknown');
    assert.equal(executeDisabledReason(base)?.canRecheck, true);
});

test('shouldShowSetupProgress hides pre-execution admin handoff and shows active/failed/resumed/finished runs', () => {
    assert.equal(shouldShowSetupProgress({}), false);
    assert.equal(
        shouldShowSetupProgress({
            hasExecutionToken: true,
            operationLedger: { 'gateway.namespace': 'admin_done', 'gateway.manifests': 'admin_done' },
        }),
        false,
    );
    assert.equal(
        shouldShowSetupProgress({
            hasExecutionToken: false,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        false,
    );
    assert.equal(shouldShowSetupProgress({ finishing: true }), true);
    assert.equal(shouldShowSetupProgress({ finished: true }), true);
    assert.equal(shouldShowSetupProgress({ executionFailedKey: 'cache.hf-secret' }), true);
    assert.equal(
        shouldShowSetupProgress({
            hasExecutionToken: true,
            operationLedger: { 'cache.hf-secret': 'user_done' },
        }),
        true,
    );
    assert.equal(
        shouldShowSetupProgress({
            hasExecutionToken: true,
            operationLedger: { 'gateway.install': 'lens_done' },
        }),
        true,
    );
    assert.equal(
        shouldShowSetupProgress({
            hasExecutionToken: true,
            operationLedger: { 'storage.pvc': 'failed' },
        }),
        true,
    );
});

test('CreateClusterWizard wires self-healing refresh, forceVerify preflight, banner/Execute sync, and Setup progress gating', () => {
    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');

    assert.match(source, /const canExecute = Boolean\(cluster\?\.id && plan\)/);
    assert.match(source, /clusterDetailSyncForReport\(detail,\s*\{/);
    assert.match(source, /runPermissionCheck\(\{ forceVerify: true \}\)/);
    assert.match(source, /const recheckPermissions = \(\) => \{\s*setError\(''\);\s*setExecutionFailedKey\(null\);\s*return runPermissionCheck\(\{ forceVerify: true, manualRecheck: Boolean\(permissionReport\) \}\);\s*\};/);
    assert.equal(source.split('setExecutionToken(verified.token || null)').length - 1, 2);
    assert.match(source, /busy: permissionBusy \|\| handoffBusy \|\| resumeBusy/);
    assert.equal(source.split("setHandoffError('')").length - 1 >= 5, true);
    assert.match(source, /const cancelRun = async \(\) => \{[\s\S]*setExecutionBlocked\(false\);\s*setHandoffError\(''\);[\s\S]*execution_not_running[\s\S]*setExecutionBlocked\(false\);\s*setHandoffError\(''\);/);
    assert.match(source, /canExecute=\{canExecute && !canResume\}/);
    assert.match(source, /executeDisabledReason\(\{/);
    assert.match(source, /executeBlocker && \(/);
    assert.match(source, /shouldShowSetupProgress\(\{/);
    assert.match(source, /showSetupProgress && \(/);
    assert.match(source, /\(permissionBusy \|\| handoffBusy \|\| resumeBusy\)\s*\?\s*'Checking permissions…'/);
    assert.match(source, /completeFailureAction\(nextError\)/);
    assert.match(source, /permissionPanelVisible\(refreshedReport\)/);
    assert.match(source, /permissionPanelVisible\(permissionReport\)/);
    assert.match(source, /error\?\.code === 'operation_blocked'/);
});

test('completeFailureAction maps every completeExecution failure without dropping tokens on reclass or Lens waits', () => {
    assert.deepEqual(completeFailureAction({ status: 403 }), {
        markFailed: true,
        clearRun: false,
        reclass: true,
        refreshSplit: false,
        reason: 'reclass',
    });
    assert.deepEqual(completeFailureAction({ code: 'kubernetes_permission_denied' }), {
        markFailed: true,
        clearRun: false,
        reclass: true,
        refreshSplit: false,
        reason: 'reclass',
    });
    assert.deepEqual(completeFailureAction({ code: 'operation_blocked' }), {
        markFailed: true,
        clearRun: false,
        reclass: true,
        refreshSplit: false,
        reason: 'reclass',
    });
    assert.deepEqual(completeFailureAction({ code: 'execution_incomplete' }), {
        markFailed: true,
        clearRun: false,
        reclass: false,
        refreshSplit: false,
        reason: 'incomplete',
    });
    for (const err of [{ status: 504 }, { code: 'lens_operation_failed' }, { code: 'operation_wait_failed' }]) {
        assert.deepEqual(completeFailureAction(err), {
            markFailed: true,
            clearRun: false,
            reclass: false,
            refreshSplit: false,
            reason: 'lens_failed',
        });
    }
    for (const err of [{ status: 401 }, { code: 'kubeconfig_unauthorized' }]) {
        assert.deepEqual(completeFailureAction(err), {
            markFailed: true,
            clearRun: true,
            reclass: false,
            refreshSplit: false,
            reason: 'unauthorized',
        });
    }
    assert.deepEqual(completeFailureAction({ code: 'execution_token_invalid' }), {
        markFailed: false,
        clearRun: true,
        reclass: false,
        refreshSplit: false,
        reason: 'token',
    });
    assert.deepEqual(completeFailureAction({ code: 'permission_check_stale' }), {
        markFailed: true,
        clearRun: true,
        reclass: false,
        refreshSplit: true,
        reason: 'stale',
    });
    assert.deepEqual(completeFailureAction({ status: 500, message: 'boom' }), {
        markFailed: true,
        clearRun: false,
        reclass: false,
        refreshSplit: false,
        reason: 'failed',
    });
});

test('permissionPanelVisible matches PermissionHandoffPanel visibility rules', () => {
    assert.equal(permissionPanelVisible(null), false);
    assert.equal(permissionPanelVisible(undefined), false);
    assert.equal(
        permissionPanelVisible({ status: 'ready', adminOperations: [], blockedOperations: [] }),
        false,
    );
    assert.equal(
        permissionPanelVisible({ status: 'admin_required', adminOperations: [], blockedOperations: [] }),
        true,
    );
    assert.equal(
        permissionPanelVisible({ status: 'blocked', adminOperations: [], blockedOperations: [] }),
        true,
    );
    assert.equal(
        permissionPanelVisible({ status: 'ready', adminOperations: [{ id: 'gateway.namespace' }], blockedOperations: [] }),
        true,
    );
    assert.equal(
        permissionPanelVisible({ status: 'ready', adminOperations: [], blockedOperations: [{ id: 'gateway.exposure', executor: 'lens' }] }),
        true,
    );
});

test('monitoringValidationError and monitoringStepValid validate namespace, NodePorts, host, collisions, and URLs', () => {
    assert.equal(monitoringValidationError({}), '');
    assert.equal(monitoringStepValid({}), true);

    assert.match(monitoringValidationError({ monitoringNamespace: 'Bad_NS' }), /DNS-1123/);
    assert.match(monitoringValidationError({ monitoringNamespace: 'a'.repeat(64) }), /63/);
    assert.equal(monitoringValidationError({ monitoringNamespace: 'custom-monitoring-1' }), '');

    assert.equal(
        monitoringStepValid({
            monitoringMode: 'managed',
            monitoringNamespace: 'llm-d-monitoring',
            prometheusNodePort: '30900',
            grafanaNodePort: '30300',
            gatewayPort: '30080',
            monitoringHost: '10.0.0.10',
        }),
        true,
    );
    assert.match(monitoringValidationError({ prometheusNodePort: '29999' }), /30000 and 32767/);
    assert.match(monitoringValidationError({ grafanaNodePort: '32768' }), /30000 and 32767/);
    assert.match(monitoringValidationError({ prometheusNodePort: '30900.5' }), /integer/);
    assert.match(
        monitoringValidationError({ prometheusNodePort: '30900', grafanaNodePort: '30900' }),
        /must be different/,
    );
    assert.match(
        monitoringValidationError({ prometheusNodePort: '30080', gatewayPort: '30080' }),
        /Gateway NodePort/,
    );
    assert.match(
        monitoringValidationError({ grafanaNodePort: '30080', gatewayPort: '30080' }),
        /Gateway NodePort/,
    );
    assert.match(monitoringValidationError({ monitoringHost: '10.0.0.5 10.0.0.6' }), /whitespace/);
    assert.match(monitoringValidationError({ monitoringHost: 'http://10.0.0.5' }), /not a URL/);
    assert.match(monitoringValidationError({ monitoringHost: '10.0.0.5/path' }), /not a URL/);

    assert.match(monitoringValidationError({ monitoringMode: 'existing', prometheusUrl: '' }), /required/);
    assert.match(
        monitoringValidationError({ monitoringMode: 'existing', prometheusUrl: 'ftp://prom.example.com' }),
        /http:\/\/ or https:\/\//,
    );
    assert.match(
        monitoringValidationError({ monitoringMode: 'existing', prometheusUrl: 'https://user:pass@prom.example.com' }),
        /credentials/,
    );
    assert.match(
        monitoringValidationError({ monitoringMode: 'existing', prometheusUrl: 'https://prom.example.com?a=1' }),
        /query parameters/,
    );
    assert.match(
        monitoringValidationError({
            monitoringMode: 'existing',
            prometheusUrl: 'https://prom.example.com',
            grafanaUrl: 'http://bad\\host',
        }),
        /backslashes/,
    );
    assert.equal(
        monitoringStepValid({
            monitoringMode: 'existing',
            prometheusUrl: 'http://10.0.0.5:9090',
            grafanaUrl: 'https://grafana.example.com',
        }),
        true,
    );

    assert.equal(wizardStepCanAdvance('versions', { monitoringMode: 'existing', prometheusUrl: '' }), false);
    assert.equal(
        wizardStepCanAdvance('versions', { monitoringMode: 'existing', prometheusUrl: 'http://10.0.0.5:9090' }),
        true,
    );
});

test('planConfigFromWizardState clears mode-irrelevant monitoring fields and planToWizardFields skips autoDiscovered', () => {
    const managedPlan = planFromWizardState({
        ...FULL_STATE,
        monitoringMode: 'managed',
        monitoringNamespace: 'obs-managed',
        prometheusUrl: 'https://stale.example.com',
        grafanaUrl: 'https://stale-grafana.example.com',
        prometheusNodePort: '30900',
        grafanaNodePort: '30300',
        monitoringHost: '10.0.0.5',
        installAcceleratorExporters: false,
    });
    assert.deepEqual(managedPlan.monitoring, {
        enabled: true,
        mode: 'managed',
        namespace: 'obs-managed',
        prometheusUrl: null,
        grafanaUrl: null,
        prometheusNodePort: 30900,
        grafanaNodePort: 30300,
        host: '10.0.0.5',
        installAcceleratorExporters: false,
    });

    const existingPlan = planFromWizardState({
        ...FULL_STATE,
        monitoringMode: 'existing',
        monitoringNamespace: 'obs-existing',
        prometheusUrl: 'https://prom.example.com',
        grafanaUrl: 'https://grafana.example.com',
        prometheusNodePort: '30900',
        grafanaNodePort: '30300',
        monitoringHost: '10.0.0.5',
        installAcceleratorExporters: true,
    });
    assert.deepEqual(existingPlan.monitoring, {
        enabled: true,
        mode: 'existing',
        namespace: 'obs-existing',
        prometheusUrl: 'https://prom.example.com',
        grafanaUrl: 'https://grafana.example.com',
        prometheusNodePort: null,
        grafanaNodePort: null,
        host: null,
        installAcceleratorExporters: true,
    });

    const resumed = planToWizardFields({
        ...STORED_PLAN,
        monitoring: {
            enabled: true,
            mode: 'managed',
            namespace: 'llm-d-monitoring',
            prometheusUrl: 'http://10.0.0.9:31900',
            grafanaUrl: 'http://10.0.0.9:31300',
            prometheusNodePort: 31900,
            grafanaNodePort: 31300,
            host: '10.0.0.9',
            installAcceleratorExporters: false,
            autoDiscovered: ['prometheusUrl', 'grafanaUrl', 'prometheusNodePort', 'host'],
        },
    });
    assert.equal(resumed.monitoringMode, 'managed');
    assert.equal(resumed.monitoringNamespace, 'llm-d-monitoring');
    assert.equal(resumed.prometheusUrl, undefined);
    assert.equal(resumed.grafanaUrl, undefined);
    assert.equal(resumed.prometheusNodePort, undefined);
    assert.equal(resumed.monitoringHost, undefined);
    assert.equal(resumed.grafanaNodePort, '31300');
    assert.equal(resumed.installAcceleratorExporters, false);
});

test('completeFailureAction preserves token for monitoring_* codes and CreateClusterWizard wires monitoring fields', () => {
    for (const code of ['monitoring_prometheus_url_missing', 'monitoring_discovery_failed', 'monitoring_unhealthy']) {
        assert.deepEqual(completeFailureAction({ code, status: 502 }), {
            markFailed: true,
            clearRun: false,
            reclass: false,
            refreshSplit: false,
            reason: 'monitoring_failed',
        });
    }

    const source = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    const wizardStateBlock = source.match(/const wizardState = \{[\s\S]*?\n    \};/);
    assert.ok(wizardStateBlock);
    for (const field of [
        'gatewayPort',
        'gatewayPublicUrl',
        'monitoringMode',
        'monitoringNamespace',
        'prometheusUrl',
        'grafanaUrl',
        'prometheusNodePort',
        'grafanaNodePort',
        'monitoringHost',
        'installAcceleratorExporters',
    ]) {
        assert.match(wizardStateBlock[0], new RegExp(`\\b${field}\\b`));
    }
    assert.match(source, /Monitoring & Observability/);
    assert.match(source, /monitoringValidationError\(wizardState\)/);
    assert.match(source, /<ReviewRow label="Monitoring">/);
    assert.match(source, /action\.reason === 'monitoring_failed'/);
});

test('storageNamespace defaults to lens-storage-<clusterId> in create mode, preserves explicit overrides and hfTokenSecret/handoff, and syncs cleanly', () => {
    // 0. Constants and defaultStorageNamespace DNS-1123 formatting.
    assert.equal(STORAGE_NAMESPACE, 'llm-d-bench-storage');
    assert.equal(STORAGE_NAMESPACE_PREFIX, 'lens-storage');
    assert.equal(defaultStorageNamespace('cluster-1'), 'lens-storage-cluster-1');
    assert.equal(defaultStorageNamespace('283db094'), 'lens-storage-283db094');
    assert.equal(defaultStorageNamespace('  Team_Cluster--01!  '), 'lens-storage-team-cluster-01');
    assert.equal(defaultStorageNamespace(''), 'lens-storage');
    assert.equal(defaultStorageNamespace(null), 'lens-storage');
    assert.equal(defaultStorageNamespace(undefined), 'lens-storage');
    assert.equal(defaultStorageNamespace('---'), 'lens-storage');
    const truncated = defaultStorageNamespace(`${'a'.repeat(49)}-extra`);
    assert.equal(truncated.length <= 63, true);
    assert.equal(truncated.endsWith('-'), false);
    assert.equal(storageNamespaceValid(truncated), true);

    // 1. With kubeconfigNamespace set (Non-Admin), storageNamespace still defaults to lens-storage-<clusterId> + 'create',
    //    while hfTokenSecret and handoff.namespace keep their kubeconfigNamespace alignment.
    const nonAdminDefault = planFromWizardState({
        ...FULL_STATE,
        secretNamespace: '',
        storageNamespace: '',
        storageNamespaceMode: '',
        kubeconfigNamespace: 'team-edit',
    });
    assert.equal(nonAdminDefault.storage.namespace, 'lens-storage-cluster-1');
    assert.equal(nonAdminDefault.storage.namespaceMode, 'create');
    assert.equal(nonAdminDefault.hfTokenSecret.secretNamespace, 'team-edit');
    assert.equal(nonAdminDefault.hfTokenSecret.secretNamespaceMode, 'existing');
    assert.equal(nonAdminDefault.handoff.namespace, 'team-edit');

    // 2. Without kubeconfigNamespace (Admin), storageNamespace also defaults to lens-storage-<clusterId> + 'create',
    //    while hfTokenSecret keeps llm-d-bench-storage-<clusterId> and handoff defaults to 'default'.
    const adminDefault = planFromWizardState({
        ...FULL_STATE,
        secretNamespace: '',
        storageNamespace: '',
        storageNamespaceMode: '',
        kubeconfigNamespace: '',
    });
    assert.equal(adminDefault.storage.namespace, 'lens-storage-cluster-1');
    assert.equal(adminDefault.storage.namespaceMode, 'create');
    assert.equal(adminDefault.hfTokenSecret.secretNamespace, 'llm-d-bench-storage-cluster-1');
    assert.equal(adminDefault.hfTokenSecret.secretNamespaceMode, 'create');
    assert.equal(adminDefault.handoff.namespace, 'default');

    // 3. Missing clusterId falls back to bare 'lens-storage' + 'create'.
    const missingClusterDefault = planFromWizardState({
        ...FULL_STATE,
        clusterId: '',
        storageNamespace: '',
        storageNamespaceMode: '',
        kubeconfigNamespace: 'team-edit',
    });
    assert.equal(missingClusterDefault.storage.namespace, 'lens-storage');
    assert.equal(missingClusterDefault.storage.namespaceMode, 'create');

    // 4. Explicit custom namespace ('team-inference') derives 'create', while explicit kubeconfigNamespace derives 'existing'.
    const customWithHint = planFromWizardState({
        ...FULL_STATE,
        storageNamespace: 'team-inference',
        storageNamespaceMode: '',
        kubeconfigNamespace: 'team-edit',
    });
    assert.equal(customWithHint.storage.namespace, 'team-inference');
    assert.equal(customWithHint.storage.namespaceMode, 'create');

    const explicitKubeconfigNs = planFromWizardState({
        ...FULL_STATE,
        storageNamespace: 'team-edit',
        storageNamespaceMode: '',
        kubeconfigNamespace: 'team-edit',
    });
    assert.equal(explicitKubeconfigNs.storage.namespace, 'team-edit');
    assert.equal(explicitKubeconfigNs.storage.namespaceMode, 'existing');

    // 5. Early-step storage.kind === 'none' does NOT poison storageNamespace or storageNamespaceMode.
    const earlyNoneFields = planToWizardFields({
        storage: { kind: 'none', namespace: 'stale-ns', namespaceMode: 'existing' },
    });
    assert.equal(earlyNoneFields.storageKind, undefined);
    assert.equal(earlyNoneFields.storageNamespace, undefined);
    assert.equal(earlyNoneFields.storageNamespaceMode, undefined);

    // 6. Configured storage restores both storageNamespace and storageNamespaceMode.
    const configuredFields = planToWizardFields({
        storage: { kind: 'nfs', namespace: 'team-inference', namespaceMode: 'existing' },
    });
    assert.equal(configuredFields.storageKind, 'nfs');
    assert.equal(configuredFields.storageNamespace, 'team-inference');
    assert.equal(configuredFields.storageNamespaceMode, 'existing');

    // 7. planSyncFromPermissionReport and clusterDetailSyncForReport surface storageNamespace/Mode.
    const reportSync = planSyncFromPermissionReport({
        plan: { storage: { kind: 'local-disk', namespace: 'lens-storage-283db094', namespaceMode: 'create' } },
        planHash: 'h-storage',
        planVersion: 2,
    });
    assert.equal(reportSync.storageNamespace, 'lens-storage-283db094');
    assert.equal(reportSync.storageNamespaceMode, 'create');

    const earlySync = planSyncFromPermissionReport({
        plan: { storage: { kind: 'none', namespaceMode: 'existing' } },
        planHash: 'h-early',
        planVersion: 1,
    });
    assert.equal(earlySync.storageNamespace, null);
    assert.equal(earlySync.storageNamespaceMode, null);

    // 8. DNS-1123 validation in storageNamespaceValid & storageStepValid.
    assert.equal(storageNamespaceValid(''), true);
    assert.equal(storageNamespaceValid('lens-storage-283db094'), true);
    assert.equal(storageNamespaceValid('team-inference'), true);
    assert.equal(storageNamespaceValid('Bad_NS'), false);
    assert.equal(storageNamespaceValid('-leading'), false);
    assert.equal(storageNamespaceValid('a'.repeat(64)), false);
    assert.equal(
        storageStepValid({ storageKind: 'local-disk', hostPath: '/data', storageCapacity: '10Gi', storageNamespace: 'Bad_NS' }),
        false,
    );
    assert.equal(
        storageStepValid({ storageKind: 'local-disk', hostPath: '/data', storageCapacity: '10Gi', storageNamespace: 'lens-storage-283db094' }),
        true,
    );

    // 9. CreateClusterWizard wires defaultStorageNamespace(cluster.id) without kubeconfigNamespace prefill.
    const wizardSource = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    assert.match(wizardSource, /const \[storageNamespace, setStorageNamespace\] = useState\(''\);/);
    assert.match(
        wizardSource,
        /if \(storageNamespaceTouched \|\| !cluster\?\.id\) return;\s*setStorageNamespace\(defaultStorageNamespace\(cluster\.id\)\);\s*setStorageNamespaceMode\('create'\);\s*\}, \[cluster\?\.id, storageNamespaceTouched\]\);/,
    );
    assert.match(wizardSource, /setStorageNamespace\(''\);/);
    assert.match(wizardSource, /id="wizard-storage-namespace"/);
    assert.match(wizardSource, /const effective = next\.trim\(\) \|\| defaultStorageNamespace\(cluster\?\.id\);/);
    assert.match(wizardSource, /placeholder=\{defaultStorageNamespace\(cluster\?\.id\)\}/);
    assert.match(wizardSource, /kubeconfigNamespace && effective === kubeconfigNamespace/);
    assert.match(wizardSource, /savedPlan\.storage\?\.kind && savedPlan\.storage\.kind !== 'none'/);
    assert.match(
        wizardSource,
        /plan\?\.storage\?\.namespace \|\| storageNamespace\.trim\(\) \|\| defaultStorageNamespace\(cluster\?\.id\)/,
    );

    // 10. CreateStorageVolumeModal generates lens-storage-<8hex> once per mount via crypto.randomUUID and never prefills kubeconfigNamespace.
    const modalSource = readFileSync(
        new URL('../../storage/ui/StorageManagement/CreateStorageVolumeModal.jsx', import.meta.url),
        'utf8',
    );
    assert.match(modalSource, /const STORAGE_NAMESPACE_PREFIX = 'lens-storage';/);
    assert.match(modalSource, /crypto\?\.randomUUID\?\.\(\)\?\.slice\(0, 8\)/);
    assert.match(modalSource, /`\$\{STORAGE_NAMESPACE_PREFIX\}-\$\{shortId\}`/);
    assert.match(modalSource, /const defaultNamespaceRef = useRef\(null\);/);
    assert.match(modalSource, /const \[namespace, setNamespace\] = useState\(defaultNamespace\);/);
    assert.equal(modalSource.split('placeholder={defaultNamespace}').length - 1, 2);
    assert.equal(modalSource.split('namespace: trimmedNamespace || defaultNamespace').length - 1, 2);
    assert.equal(modalSource.includes('kubeconfigNamespace'), false);
    assert.equal(modalSource.includes('DEFAULT_STORAGE_NAMESPACE'), false);
    assert.equal(modalSource.includes('llm-d-bench-storage'), false);
    assert.equal(modalSource.includes('lens-edit'), false);
});

test('full-privilege ready report skips handoff/marker verification and runtime-403 mid-run reclassifies cleanly', () => {
    const readyReport = {
        status: 'ready',
        sufficient: true,
        planHash: 'plan-ready-hash',
        planVersion: 1,
        adminOperations: [],
        blockedOperations: [],
        userOperations: [
            { id: 'gateway.namespace', title: 'Create the gateway namespace', executor: 'user' },
            { id: 'lws.namespace', title: 'Create the LeaderWorkerSet namespace', executor: 'user' },
            { id: 'lws.crds', title: 'Install the LeaderWorkerSet CRDs', executor: 'user' },
            { id: 'accelerator.nfd', title: 'Install Node Feature Discovery', executor: 'user' },
            { id: 'accelerator.intel.plugin.0', title: 'Install Intel GPU plugin', executor: 'user' },
            { id: 'cache.hf-secret', title: 'Write the HF token Secret', executor: 'user' },
        ],
        lensOperations: [{ id: 'gateway.exposure', title: 'Expose the gateway', executor: 'lens' }],
        missing: [],
        marker: { namespace: 'default', name: 'lens-admin-handoff-plan', status: 'missing', verified: false, operations: [] },
    };

    // 1. Zero-handoff Ready state: hides PermissionHandoffPanel, skips handoff/marker verification, enables Execute.
    assert.equal(permissionPanelVisible(readyReport), false);
    assert.equal(shouldLoadHandoff(readyReport), false);
    assert.equal(shouldAutoVerifyHandoff(null, { hasToken: false, ledger: {}, force: true }), false);
    assert.equal(
        canExecuteOperationRun({ reportStatus: readyReport.status, adminVerified: false, hasToken: false, busy: false }),
        true,
    );
    assert.equal(
        executeDisabledReason({
            canExecute: true,
            hasCluster: true,
            hasPlan: true,
            hasReport: true,
            reportStatus: readyReport.status,
            hasHfToken: true,
            adminVerified: false,
            hasToken: false,
            hasAdminOperations: false,
        }),
        null,
    );

    // 2. Runtime-403 mid-execution from ready triggers reclass without clearing the active run token or user_done ledger.
    const runtime403Action = executionFailureAction({
        status: 403,
        code: 'kubernetes_permission_denied',
        executionToken: 'live-run-token',
    });
    assert.deepEqual(runtime403Action, {
        blocked: false,
        markFailed: true,
        clearRun: false,
        reclass: true,
        refreshSplit: false,
        reloadLedger: false,
        reason: 'reclass',
    });
    assert.deepEqual(completeFailureAction({ status: 403, code: 'kubernetes_permission_denied' }), {
        markFailed: true,
        clearRun: false,
        reclass: true,
        refreshSplit: false,
        reason: 'reclass',
    });

    // 3. Reclassified report mounts handoff panel, preserves completed user_done ops, and gates Execute until verified.
    const reclassifiedReport = {
        ...readyReport,
        status: 'admin_required',
        sufficient: false,
        adminOperations: [{ id: 'lws.crds', title: 'Install the LeaderWorkerSet CRDs', executor: 'admin' }],
        userOperations: readyReport.userOperations.filter((op) => op.id !== 'lws.crds'),
    };
    const midRunLedger = {
        'gateway.namespace': 'user_done',
        'lws.namespace': 'user_done',
        'lws.crds': 'failed_permission',
    };
    assert.equal(permissionPanelVisible(reclassifiedReport), true);
    assert.equal(shouldLoadHandoff(reclassifiedReport), true);
    assert.equal(
        canExecuteOperationRun({ reportStatus: reclassifiedReport.status, adminVerified: false, hasToken: true }),
        false,
    );
    const progress = operationProgressForLedger(reclassifiedReport, midRunLedger);
    assert.equal(progress.find((row) => row.key === 'lws.namespace')?.state, 'done');
    assert.equal(progress.find((row) => row.key === 'lws.crds')?.state, 'pending');
    assert.equal(verifyRefreshesOperationLedger('live-run-token', 'live-run-token'), false);
    assert.equal(
        canExecuteOperationRun({ reportStatus: reclassifiedReport.status, adminVerified: true, hasToken: true }),
        true,
    );
});

test('monitoringNamespace defaults to lens-monitoring-<clusterId>, preserves legacy/custom namespaces on resume, and keeps CreateClusterWizard free of hardcoded llm-d-monitoring', () => {
    // 0. Constants and defaultMonitoringNamespace DNS-1123 formatting.
    assert.equal(MONITORING_NAMESPACE, 'llm-d-monitoring');
    assert.equal(MONITORING_NAMESPACE_PREFIX, 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace('cluster-1'), 'lens-monitoring-cluster-1');
    assert.equal(defaultMonitoringNamespace('283db094'), 'lens-monitoring-283db094');
    assert.equal(defaultMonitoringNamespace('  Team_Cluster--01!  '), 'lens-monitoring-team-cluster-01');
    assert.equal(defaultMonitoringNamespace(''), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace(null), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace(undefined), 'lens-monitoring');
    assert.equal(defaultMonitoringNamespace('---'), 'lens-monitoring');
    const truncated = defaultMonitoringNamespace(`${'a'.repeat(46)}-extra-suffix`);
    assert.equal(truncated.length <= 63, true);
    assert.equal(truncated.endsWith('-'), false);
    assert.equal(monitoringValidationError({ monitoringNamespace: truncated }), '');

    // 1. planConfigFromWizardState / planFromWizardState defaults monitoring.namespace to lens-monitoring-<clusterId>
    //    regardless of kubeconfigNamespace or mode, and falls back to 'lens-monitoring' when clusterId is missing.
    assert.equal(
        planConfigFromWizardState({ ...FULL_STATE, monitoringNamespace: '' }).monitoring.namespace,
        'lens-monitoring-cluster-1',
    );
    assert.equal(
        planFromWizardState({
            ...FULL_STATE,
            monitoringNamespace: '   ',
            kubeconfigNamespace: 'team-edit',
        }).monitoring.namespace,
        'lens-monitoring-cluster-1',
    );
    assert.equal(
        planFromWizardState({
            ...FULL_STATE,
            clusterId: '',
            monitoringNamespace: '',
        }).monitoring.namespace,
        'lens-monitoring',
    );
    assert.equal(
        planFromWizardState({
            ...FULL_STATE,
            monitoringMode: 'existing',
            monitoringNamespace: '',
            prometheusUrl: 'https://prom.example.com',
        }).monitoring.namespace,
        'lens-monitoring-cluster-1',
    );

    // 2. Explicit legacy 'llm-d-monitoring' and custom namespaces survive planConfigFromWizardState / planFromWizardState.
    assert.equal(
        planFromWizardState({
            ...FULL_STATE,
            monitoringNamespace: 'llm-d-monitoring',
        }).monitoring.namespace,
        'llm-d-monitoring',
    );
    assert.equal(
        planFromWizardState({
            ...FULL_STATE,
            monitoringNamespace: 'custom-obs',
        }).monitoring.namespace,
        'custom-obs',
    );

    // 3. planToWizardFields preserves resumed 'llm-d-monitoring', 'lens-monitoring-<clusterId>', and custom namespaces.
    assert.equal(
        planToWizardFields({ monitoring: { mode: 'managed', namespace: 'llm-d-monitoring' } }).monitoringNamespace,
        'llm-d-monitoring',
    );
    assert.equal(
        planToWizardFields({ monitoring: { mode: 'managed', namespace: 'lens-monitoring-283db094' } }).monitoringNamespace,
        'lens-monitoring-283db094',
    );
    assert.equal(
        planToWizardFields({ monitoring: { mode: 'existing', namespace: 'custom-obs' } }).monitoringNamespace,
        'custom-obs',
    );
    assert.equal(planToWizardFields({ monitoring: { mode: 'managed', namespace: '   ' } }).monitoringNamespace, undefined);
    assert.equal(planToWizardFields({}).monitoringNamespace, undefined);

    // 4. planSyncFromPermissionReport and clusterDetailSyncForReport surface monitoringNamespace.
    const reportSync = planSyncFromPermissionReport({
        plan: { monitoring: { mode: 'managed', namespace: 'lens-monitoring-283db094' } },
        planHash: 'h-mon',
        planVersion: 5,
    });
    assert.equal(reportSync.monitoringNamespace, 'lens-monitoring-283db094');

    const legacyDetailSync = clusterDetailSyncForReport(
        {
            executionOperations: {},
            plan: { monitoring: { mode: 'managed', namespace: 'llm-d-monitoring' } },
            planHash: 'h-legacy-mon',
            planVersion: 5,
        },
        { reportPlanHash: 'h-legacy-mon', currentPlanHash: 'h-legacy-mon' },
    );
    assert.equal(legacyDetailSync.monitoringNamespace, 'llm-d-monitoring');

    // 5. CreateClusterWizard source invariants.
    const wizardSource = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    assert.equal(wizardSource.includes('llm-d-monitoring'), false);
    assert.match(wizardSource, /const \[monitoringNamespace, setMonitoringNamespace\] = useState\(''\);/);
    assert.match(wizardSource, /const \[monitoringNamespaceTouched, setMonitoringNamespaceTouched\] = useState\(false\);/);
    assert.match(
        wizardSource,
        /if \(monitoringNamespaceTouched \|\| !cluster\?\.id\) return;\s*setMonitoringNamespace\(defaultMonitoringNamespace\(cluster\.id\)\);\s*\}, \[cluster\?\.id, monitoringNamespaceTouched\]\);/,
    );
    assert.match(
        wizardSource,
        /if \(fields\.monitoringNamespace !== undefined\)\s*\{\s*setMonitoringNamespace\(fields\.monitoringNamespace\);\s*setMonitoringNamespaceTouched\(true\);\s*\}/,
    );
    assert.match(wizardSource, /setMonitoringNamespace\(''\);\s*setMonitoringNamespaceTouched\(false\);/);
    assert.equal(wizardSource.split('placeholder={defaultMonitoringNamespace(cluster?.id)}').length - 1, 2);
    assert.equal(
        wizardSource.split('setMonitoringNamespaceTouched(true);\n                                                    setMonitoringNamespace(event.target.value);').length - 1
        + wizardSource.split('setMonitoringNamespaceTouched(true);\n                                                setMonitoringNamespace(event.target.value);').length - 1,
        2,
    );
    assert.match(
        wizardSource,
        /const ns = mon\.namespace \|\| monitoringNamespace\.trim\(\) \|\| defaultMonitoringNamespace\(cluster\?\.id\);/,
    );
});

test('vllmImageValidationError gates versions step and round-trips through wizard plan helpers', () => {
    assert.equal(typeof validateContainerImageRef, 'function');
    assert.equal(vllmImageValidationError({}), '');
    assert.equal(vllmImageValidationError({ vllmImage: '' }), '');
    assert.equal(vllmImageValidationError({ vllmImage: 'registry.internal:5000/org/vllm:v0.8.5' }), '');
    assert.notEqual(vllmImageValidationError({ vllmImage: 'registry.internal:5000/org/vllm' }), '');
    assert.notEqual(vllmImageValidationError({ vllmImage: 'docker.io/vllm/vllm-openai:v1;rm -rf /' }), '');

    assert.equal(wizardStepCanAdvance('versions', { ...FULL_STATE, vllmImage: '' }), true);
    assert.equal(wizardStepCanAdvance('versions', { ...FULL_STATE, vllmImage: 'quay.io/org/vllm:v1' }), true);
    assert.equal(wizardStepCanAdvance('versions', { ...FULL_STATE, vllmImage: 'quay.io/org/vllm' }), false);

    assert.equal(planConfigFromWizardState({ ...FULL_STATE, vllmImage: '' }).stack.vllmImage, null);
    assert.equal(
        planFromWizardState({ ...FULL_STATE, vllmImage: '  localhost:5000/vllm:custom  ' }).stack.vllmImage,
        'localhost:5000/vllm:custom',
    );
    assert.equal(
        planToWizardFields({ stack: { vllmImage: 'quay.io/org/vllm:v2' } }).vllmImage,
        'quay.io/org/vllm:v2',
    );
    assert.equal(
        planToWizardFields({ stack: { vllm_image: 'quay.io/org/vllm:v3' } }).vllmImage,
        'quay.io/org/vllm:v3',
    );
    assert.equal(planToWizardFields({ stack: { vllmImage: null } }).vllmImage, undefined);

    const wizardSource = readFileSync(new URL('./CreateClusterWizard.jsx', import.meta.url), 'utf8');
    assert.equal(wizardSource.includes('modelServerImages.nvidia'), false);
    assert.equal(wizardSource.includes('modelServerImages.intel'), false);
    assert.match(wizardSource, /selectedAcceleratorIds\.map\(\(vendorId\)/);
    assert.match(wizardSource, /vllmImageValidationError\(wizardState\)/);
});
