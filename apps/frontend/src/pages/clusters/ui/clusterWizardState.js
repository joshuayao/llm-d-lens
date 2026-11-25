// Pure helpers for the configuration-first Create Cluster wizard.
//
// The wizard saves a provisioning plan on every configuration step, then runs a
// plan-scoped permission check before any target-cluster mutation. These
// helpers keep the plan <-> wizard field mapping, the resume key and the step
// order/enable conditions out of the component so they can be tested without a
// DOM. See docs/design/cluster-permission-preflight-design.md sections 4.4,
// 4.6 and 8.

import {
    MONITORING_NAMESPACE_PREFIX,
    buildPlan,
    defaultMonitoringNamespace,
    validateContainerImageRef,
} from './clusterPlan.js';

export { MONITORING_NAMESPACE_PREFIX, defaultMonitoringNamespace, validateContainerImageRef };

// Order of the wizard steps. `review` previews the saved plan and `execute`
// runs the permission preflight check and guarded plan steps; everything
// before them only writes Lens state.
export const WIZARD_STEP_IDS = [
    'basics',
    'proxy',
    'gateway',
    'accelerator',
    'versions',
    'modelCache',
    'storage',
    'review',
    'execute',
];

// The last configuration step; advancing from it saves the plan and opens
// the read-only Review preview.
export const LAST_CONFIGURATION_STEP = 'storage';

export const RESUME_STORAGE_KEY = 'lens.createCluster.draftId';
export const RESUME_STEP_KEY = 'lens.createCluster.step';
export const EXECUTION_TOKEN_KEY_PREFIX = 'lens.createCluster.executionToken.';

// The current UI has no inputs for the gateway namespace/name, while the plan
// model requires them. These match the backend gateway defaults used by
// `GatewayOpsService.install_inference_gateway` (the installer still scopes the
// namespace to the cluster id).
export const GATEWAY_DEFAULTS = {
    namespace: 'lens-gateway',
    name: 'lens-inference-gateway',
    namespaceMode: 'create',
};

// Legacy namespace defaults retained for backward compatibility and default HF_TOKEN secrets.
export const STORAGE_NAMESPACE = 'llm-d-bench-storage';
export const STORAGE_NAMESPACE_PREFIX = 'lens-storage';
export const MONITORING_NAMESPACE = 'llm-d-monitoring';

export const CAPACITY_PATTERN = /^\d+(Gi|Mi|Ti)$/;
export const REPO_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const DNS1123_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function defaultStorageNamespace(clusterId) {
    const raw = text(clusterId).toLowerCase();
    const maxSuffixLength = 63 - STORAGE_NAMESPACE_PREFIX.length - 1;
    const cleaned = raw
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxSuffixLength)
        .replace(/-+$/g, '');
    return cleaned ? `${STORAGE_NAMESPACE_PREFIX}-${cleaned}` : STORAGE_NAMESPACE_PREFIX;
}

export function storageNamespaceValid(namespace) {
    const value = text(namespace);
    if (!value) return true;
    return value.length <= 63 && DNS1123_LABEL_PATTERN.test(value);
}

function text(value) {
    return String(value ?? '').trim();
}

/**
 * Seed the wizard's proxy fields from the resumed cluster record. A resumed
 * draft must keep its saved proxy instead of falling back to the default
 * "auto" mode.
 */
export function proxyFieldsFromCluster(cluster) {
    const proxy = cluster?.proxy || {};
    return {
        proxyMode: proxy.mode === 'custom' ? 'custom' : 'auto',
        httpProxy: proxy.httpProxy || '',
        httpsProxy: proxy.httpsProxy || '',
        noProxy: proxy.noProxy || '',
    };
}

/**
 * Latest-request gate for the resume effect. StrictMode mounts the effect twice;
 * the second load must win and only it may clear the loading flag.
 */
export function createResumeGate() {
    let latest = 0;
    return {
        begin: () => {
            latest += 1;
            return latest;
        },
        isCurrent: (loadId) => loadId === latest,
    };
}

/** Return true when the permission handoff/blocker panel will mount for a report. */
export function permissionPanelVisible(report) {
    return Boolean(
        report
        && (
            report.status === 'admin_required'
            || report.status === 'blocked'
            || (report.adminOperations || []).length > 0
            || (report.blockedOperations || []).length > 0
        ),
    );
}

/** A blocked report still needs the handoff when it has administrator operations. */
export function shouldLoadHandoff(report) {
    const status = report?.status;
    if (status !== 'admin_required' && status !== 'blocked') return false;
    return (report?.adminOperations || []).length > 0;
}

/**
 * A failed resume only drops the stored draft id when the draft no longer
 * exists or is not readable. A network/timeout/500 failure keeps the key so a
 * later visit can retry the same draft.
 */
export function shouldClearResumeOnLoadError(error) {
    return error?.status === 404 || error?.status === 403;
}

/** A run can execute only when the split is ready or admin-verified with a token. */
export function canExecuteOperationRun({
    reportStatus,
    adminVerified = false,
    hasToken = false,
    busy = false,
} = {}) {
    if (busy) return false;
    if (reportStatus === 'blocked') return false;
    if (reportStatus === 'ready') return true;
    return reportStatus === 'admin_required' && Boolean(adminVerified) && Boolean(hasToken);
}

export function operationDone(ledger, operationId) {
    return ['user_done', 'admin_done', 'lens_done'].includes(ledger?.[operationId]);
}

/** Progress rows for the admin and user operations, using an explicitly supplied ledger. */
export function operationProgressForLedger(report, ledger = {}) {
    const seen = new Set();
    const combined = [];
    for (const entry of [...(report?.adminOperations || []), ...(report?.userOperations || [])]) {
        const operation = typeof entry === 'string' ? { id: entry } : entry;
        if (!operation?.id || seen.has(operation.id)) continue;
        seen.add(operation.id);
        combined.push(operation);
    }
    return combined.map((operation) => ({
        key: operation.id,
        label: operation.title || operation.id,
        state: ['user_done', 'admin_done', 'lens_done'].includes(ledger?.[operation.id]) ? 'done' : 'pending',
        detail: ledger?.[operation.id] === 'failed'
            ? 'The last attempt failed. Retry this operation.'
            : undefined,
    }));
}

/** Only an unfinished Execute step auto-runs the permission check on resume; Review and config steps do not. */
export function shouldAutoCheckResumedPlan({ hasPlan = false, finished = false, resumeStep = null } = {}) {
    return Boolean(hasPlan && !finished && resumeStep === 'execute');
}

/** Back from Execute to Review is enabled whenever no check, verification, cancel or run is active. */
export function canNavigateBackFromExecute({
    finished = false,
    finishing = false,
    cancelling = false,
    permissionBusy = false,
    handoffBusy = false,
    executionBlocked = false,
} = {}) {
    return Boolean(
        !finished
        && !finishing
        && !cancelling
        && !permissionBusy
        && !handoffBusy
        && !executionBlocked
    );
}

/** A changed plan invalidates an earlier completion. */
export function nextExecutionCompleted(completed, previousHash, nextHash) {
    return Boolean(completed) && !planInvalidatesRun(previousHash, nextHash);
}

/** Preflight is an explicit Review action and needs a saved plan, no active run and a token. */
export function canRunPreflight({
    hasCluster = false,
    planHash = null,
    permissionBusy = false,
    handoffBusy = false,
    resumeBusy = false,
    finishing = false,
    executionBlocked = false,
    hasSecretInput = false,
} = {}) {
    return Boolean(
        hasCluster
        && planHash
        && !permissionBusy
        && !handoffBusy
        && !resumeBusy
        && !finishing
        && !executionBlocked
        && hasSecretInput
    );
}

/** Administrator handoff is verified only with a complete marker and no remaining admin work. */
export function adminVerificationReady(handoff) {
    return handoff?.status === 'complete' && (handoff?.remainingOperations || []).length === 0;
}

/** Auto-verify on Re-check/Preflight/resume when the marker is complete and forced or missing token/admin_done ledger. */
export function shouldAutoVerifyHandoff(handoff, { hasToken = false, ledger = {}, force = false } = {}) {
    if (!adminVerificationReady(handoff)) return false;
    if (force || !hasToken) return true;
    const adminIds = (handoff?.adminOperations || [])
        .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
        .filter(Boolean);
    return adminIds.some((id) => ledger?.[id] !== 'admin_done');
}

const VERIFY_ERROR_STATUS = {
    admin_handoff_stale: 'stale',
    admin_handoff_unconfirmed: 'unconfirmed',
    admin_handoff_unknown: 'unknown',
    admin_handoff_incomplete: 'partial',
};

/** Map a verify-error problem payload to a non-complete handoff so stale Verified state clears immediately. */
export function handoffFallbackFromVerifyError(verifyError, status = null, details = {}) {
    const nextStatus = VERIFY_ERROR_STATUS[verifyError?.code] || 'unknown';
    const adminOperations = details?.adminOperations?.length
        ? details.adminOperations
        : (status?.adminOperations || []);
    const remainingOperations = details?.remainingOperations?.length
        ? details.remainingOperations
        : (status?.remainingOperations || []);
    const baseMarker = details?.marker || status?.marker || null;
    const marker = details?.marker && details.marker.status !== 'complete'
        ? details.marker
        : baseMarker
            ? { ...baseMarker, status: nextStatus, verified: false }
            : { status: nextStatus, verified: false };
    return {
        ...(status || {}),
        status: nextStatus,
        adminOperations,
        remainingOperations,
        marker,
    };
}

/** A completed run counts only when its completion hash matches the current plan. */
export function executionCompletedForPlan(detail) {
    const planHash = detail?.planHash;
    return Boolean(
        detail?.executionCompletedAt
        && planHash
        && detail?.executionCompletedPlanHash === planHash
    );
}

/** A new verify token starts a new run; the same token preserves a 403 re-split ledger. */
export function verifyRefreshesOperationLedger(previousToken, nextToken) {
    return Boolean(nextToken) && (!previousToken || previousToken !== nextToken);
}

/** Reuse the local operation ledger only for the same live run token. */
export function operationLedgerForRun(ledger, { hasToken = false } = {}) {
    return hasToken && ledger && typeof ledger === 'object' ? { ...ledger } : {};
}

/** A verify attempt that hits a live run waits instead of clearing state. */
export function verificationBlocksRun(error) {
    return error?.code === 'execution_in_progress';
}

export function verificationFailureAction(error) {
    if (verificationBlocksRun(error)) {
        return { blocked: true, retainRun: true, refreshHandoff: false };
    }
    const refreshHandoff = [
        'admin_handoff_incomplete',
        'admin_handoff_unknown',
        'admin_handoff_stale',
        'admin_handoff_unconfirmed',
    ].includes(error?.code);
    return { blocked: false, retainRun: true, refreshHandoff };
}

export function executionFailureAction(error) {
    if (verificationBlocksRun(error)) {
        return { blocked: true, markFailed: false, clearRun: false, reclass: false, refreshSplit: false, reloadLedger: false, reason: 'in_progress' };
    }
    if (error?.status === 403 || error?.code === 'kubernetes_permission_denied' || error?.code === 'operation_blocked') {
        return { blocked: false, markFailed: true, clearRun: false, reclass: true, refreshSplit: false, reloadLedger: false, reason: 'reclass' };
    }
    if (error?.code === 'user_secret_required') {
        return { blocked: false, markFailed: true, clearRun: false, reclass: false, refreshSplit: false, reloadLedger: false, reason: 'secret_required' };
    }
    if (error?.status === 401) {
        return { blocked: false, markFailed: true, clearRun: true, reclass: false, refreshSplit: false, reloadLedger: false, reason: 'unauthorized' };
    }
    if (error?.status === 504 || error?.code === 'operation_wait_failed') {
        return { blocked: false, markFailed: true, clearRun: true, reclass: false, refreshSplit: false, reloadLedger: false, reason: 'wait' };
    }
    if (error?.code === 'execution_token_invalid') {
        return { blocked: false, markFailed: true, clearRun: true, reclass: false, refreshSplit: false, reloadLedger: true, reason: 'token' };
    }
    if (error?.code === 'permission_check_stale') {
        return { blocked: false, markFailed: true, clearRun: true, reclass: false, refreshSplit: true, reloadLedger: false, reason: 'stale' };
    }
    return { blocked: false, markFailed: true, clearRun: true, reclass: false, refreshSplit: false, reloadLedger: false, reason: 'failed' };
}

export function completeFailureAction(error) {
    if (
        error?.status === 403
        || error?.code === 'kubernetes_permission_denied'
        || error?.code === 'operation_blocked'
    ) {
        return { markFailed: true, clearRun: false, reclass: true, refreshSplit: false, reason: 'reclass' };
    }
    if (error?.code === 'execution_incomplete') {
        return { markFailed: true, clearRun: false, reclass: false, refreshSplit: false, reason: 'incomplete' };
    }
    if (
        error?.status === 504
        || error?.code === 'lens_operation_failed'
        || error?.code === 'operation_wait_failed'
    ) {
        return { markFailed: true, clearRun: false, reclass: false, refreshSplit: false, reason: 'lens_failed' };
    }
    if (typeof error?.code === 'string' && error.code.startsWith('monitoring_')) {
        return { markFailed: true, clearRun: false, reclass: false, refreshSplit: false, reason: 'monitoring_failed' };
    }
    if (error?.status === 401 || error?.code === 'kubeconfig_unauthorized') {
        return { markFailed: true, clearRun: true, reclass: false, refreshSplit: false, reason: 'unauthorized' };
    }
    if (error?.code === 'execution_token_invalid') {
        return { markFailed: false, clearRun: true, reclass: false, refreshSplit: false, reason: 'token' };
    }
    if (error?.code === 'permission_check_stale') {
        return { markFailed: true, clearRun: true, reclass: false, refreshSplit: true, reason: 'stale' };
    }
    return { markFailed: true, clearRun: false, reclass: false, refreshSplit: false, reason: 'failed' };
}

/** Resume is available only for a fresh, non-busy, executable split. */
export function canResumeOperationRun({
    hasFailedOperation = false,
    executionBlocked = false,
    cancelling = false,
    permissionsSufficient = false,
    permissionsFresh = true,
    hasSecretInput = false,
    hasPermissionError = false,
    finishing = false,
    busy = false,
} = {}) {
    return Boolean(
        hasFailedOperation
        && !executionBlocked
        && !cancelling
        && permissionsSufficient
        && permissionsFresh
        && hasSecretInput
        && !hasPermissionError
        && !finishing
        && !busy
    );
}

/** A changed plan hash invalidates the old run; saving the same plan does not. */
export function planInvalidatesRun(previousHash, nextHash) {
    return Boolean(previousHash) && previousHash !== nextHash;
}

/**
 * A `forbidden` version read during configuration is a warning (the plan-scoped
 * permission check covers it); an invalid credential, a blocked target or an
 * unreachable API server blocks the step.
 */
export function versionCheckBlocks(check) {
    if (!check) return false;
    if (check.reason === 'forbidden') return false;
    return check.reachable === false || check.supported === false;
}

/** Actionable inline text for a failed connectivity/version check. */
export function versionCheckMessage(check) {
    if (check?.message) return check.message;
    if (check?.reason === 'unauthorized') return 'The kubeconfig credentials are invalid or expired.';
    if (check?.reason === 'timeout') return 'Timed out reaching the Kubernetes API.';
    if (check?.reason === 'egress_blocked') return 'The kubeconfig points at a blocked address.';
    if (check?.reachable === false) return 'Could not reach the Kubernetes API with the uploaded kubeconfig.';
    if (check?.supported === false) {
        return `Kubernetes ${check.version} is below the required minimum ${check.min_k8s_version}.`;
    }
    return 'The Kubernetes connectivity check failed.';
}

/**
 * The storage service auto-names an unnamed local-disk/NFS volume with this
 * convention. Using it in the plan makes the plan and the created volume agree
 * instead of inventing an unrelated "model-cache" reference.
 */
export function defaultStorageVolumeName(kind) {
    return kind === 'local-disk' || kind === 'nfs' ? `storage-${kind}` : null;
}

/** The actual volume name a plan-owned storage volume will be created with. */
export function plannedStorageVolumeName(state = {}) {
    return text(state.storageName) || text(state.storageVolumeRef) || defaultStorageVolumeName(state.storageKind);
}

function defaultResumeStorage() {
    try {
        return typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined;
    } catch {
        return undefined;
    }
}

/** Read the persisted draft id, tolerating disabled/unavailable storage. */
export function loadResumeDraftId(storage = defaultResumeStorage()) {
    try {
        const value = storage?.getItem?.(RESUME_STORAGE_KEY);
        return value && value.trim() ? value : null;
    } catch {
        return null;
    }
}

/** Persist the draft id so a refresh or a later visit resumes the same draft. */
export function saveResumeDraftId(draftId, storage = defaultResumeStorage()) {
    if (!draftId) return;
    try {
        storage?.setItem?.(RESUME_STORAGE_KEY, String(draftId));
    } catch {
        // Storage can be disabled (private mode); resume is then unavailable
        // but the wizard itself still works.
    }
}

/** Clear the resume key after finalize or an explicit discard. */
export function clearResumeDraftId(storage = defaultResumeStorage()) {
    try {
        storage?.removeItem?.(RESUME_STORAGE_KEY);
    } catch {
        // Nothing to clean up when storage is unavailable.
    }
}

/** Read the last configuration step the user was on. */
export function loadResumeStep(storage = defaultResumeStorage()) {
    try {
        const value = storage?.getItem?.(RESUME_STEP_KEY);
        return value && WIZARD_STEP_IDS.includes(value) ? value : null;
    } catch {
        return null;
    }
}

/** Persist the step the wizard should reopen on the next visit. */
export function saveResumeStep(stepId, storage = defaultResumeStorage()) {
    if (!stepId || !WIZARD_STEP_IDS.includes(stepId)) return;
    try {
        storage?.setItem?.(RESUME_STEP_KEY, String(stepId));
    } catch {
        // Resume is unavailable when storage is disabled.
    }
}

/** Clear the draft id and the remembered step (finalize/discard). */
export function clearResumeState(storage = defaultResumeStorage()) {
    clearResumeDraftId(storage);
    try {
        storage?.removeItem?.(RESUME_STEP_KEY);
    } catch {
        // Nothing to clean up when storage is unavailable.
    }
}

function defaultExecutionTokenStorage() {
    // sessionStorage survives a page refresh in the same tab, so a run that is
    // still live keeps its token; closing the tab drops it (the lock then
    // expires normally).
    try {
        return typeof globalThis !== 'undefined' ? globalThis.sessionStorage : undefined;
    } catch {
        return undefined;
    }
}

function executionTokenKey(clusterId) {
    return `${EXECUTION_TOKEN_KEY_PREFIX}${clusterId}`;
}

/** Remember the live execution token so a page refresh can resume the run. */
export function saveExecutionToken(clusterId, token, storage = defaultExecutionTokenStorage()) {
    if (!clusterId || !token) return;
    try {
        storage?.setItem?.(executionTokenKey(clusterId), String(token));
    } catch {
        // Resume is unavailable when storage is disabled; the run still works
        // in the current page.
    }
}

/** Read the execution token stored for a draft, if any. */
export function loadExecutionToken(clusterId, storage = defaultExecutionTokenStorage()) {
    if (!clusterId) return null;
    try {
        const value = storage?.getItem?.(executionTokenKey(clusterId));
        return value && value.trim() ? value : null;
    } catch {
        return null;
    }
}

/** Forget a finished/cancelled run's token. */
export function clearExecutionToken(clusterId, storage = defaultExecutionTokenStorage()) {
    if (!clusterId) return;
    try {
        storage?.removeItem?.(executionTokenKey(clusterId));
    } catch {
        // Nothing to clean up when storage is unavailable.
    }
}

/**
 * Map a stored provisioning plan back onto the wizard's flat field state.
 * Uses `undefined` for absent fields so the caller can keep its defaults.
 * The HF token is never part of the plan and is therefore not restored.
 */
export function planToWizardFields(plan = {}) {
    if (!plan || typeof plan !== 'object') return {};
    const gateway = plan.gateway || {};
    const runtime = plan.runtime || {};
    const storage = plan.storage || {};
    const cache = plan.modelCache || plan.model_cache || {};
    const secret = plan.hfTokenSecret || plan.hf_token_secret || {};
    const handoff = plan.handoff || {};
    const stack = plan.stack || {};
    const monitoring = plan.monitoring || {};
    const accelerators = Array.isArray(plan.accelerators) ? plan.accelerators : [];
    const autoDiscovered = new Set(
        Array.isArray(monitoring.autoDiscovered ?? monitoring.auto_discovered)
            ? (monitoring.autoDiscovered ?? monitoring.auto_discovered)
            : [],
    );
    const rawPromUrl = monitoring.prometheusUrl ?? monitoring.prometheus_url;
    const rawGrafanaUrl = monitoring.grafanaUrl ?? monitoring.grafana_url;
    const rawPromNodePort = monitoring.prometheusNodePort ?? monitoring.prometheus_node_port;
    const rawGrafanaNodePort = monitoring.grafanaNodePort ?? monitoring.grafana_node_port;
    const rawInstallExporters = monitoring.installAcceleratorExporters ?? monitoring.install_accelerator_exporters;

    const storageKind = storage.kind && storage.kind !== 'none' ? storage.kind : undefined;
    const storageVolumeRef = text(cache.storageVolumeRef ?? cache.storage_volume_ref);
    let storageName;
    if (!storageKind || !storageVolumeRef) {
        storageName = undefined;
    } else if (storageVolumeRef === defaultStorageVolumeName(storageKind)) {
        storageName = '';
    } else {
        storageName = storageVolumeRef;
    }

    const selectedAccelerators = {};
    for (const accelerator of accelerators) {
        const vendor = accelerator?.vendor;
        if (!vendor) continue;
        const mode = accelerator.mode || 'plugin';
        selectedAccelerators[vendor] = [...(selectedAccelerators[vendor] || []), mode];
    }

    return {
        gatewayProvider: gateway.provider || undefined,
        gatewayServiceType: gateway.serviceType ?? undefined,
        gatewayNamespace: gateway.namespace || undefined,
        gatewayName: gateway.name || undefined,
        gatewayPort: gateway.port === null || gateway.port === undefined ? undefined : String(gateway.port),
        gatewayPublicUrl: gateway.publicUrl ?? undefined,
        gatewayAuthzHost: gateway.authzHost ?? undefined,
        inotifyMaxUserInstances: runtime.inotifyLimit === null || runtime.inotifyLimit === undefined
            ? undefined
            : String(runtime.inotifyLimit),
        selectedAccelerators: accelerators.length ? selectedAccelerators : undefined,
        routerVersion: stack.routerVersion ?? undefined,
        gieVersion: stack.gieVersion ?? undefined,
        ippVersion: stack.ippVersion ?? undefined,
        lwsVersion: stack.lwsVersion ?? undefined,
        vllmImage: (stack.vllmImage ?? stack.vllm_image) ?? undefined,
        monitoringMode: monitoring.mode || undefined,
        monitoringNamespace: text(monitoring.namespace) || undefined,
        prometheusUrl: autoDiscovered.has('prometheusUrl') || autoDiscovered.has('prometheus_url')
            ? undefined
            : (rawPromUrl ?? undefined),
        grafanaUrl: autoDiscovered.has('grafanaUrl') || autoDiscovered.has('grafana_url')
            ? undefined
            : (rawGrafanaUrl ?? undefined),
        prometheusNodePort: autoDiscovered.has('prometheusNodePort') || autoDiscovered.has('prometheus_node_port')
            ? undefined
            : (rawPromNodePort === null || rawPromNodePort === undefined ? undefined : String(rawPromNodePort)),
        grafanaNodePort: autoDiscovered.has('grafanaNodePort') || autoDiscovered.has('grafana_node_port')
            ? undefined
            : (rawGrafanaNodePort === null || rawGrafanaNodePort === undefined ? undefined : String(rawGrafanaNodePort)),
        monitoringHost: autoDiscovered.has('host')
            ? undefined
            : (monitoring.host ?? undefined),
        installAcceleratorExporters: rawInstallExporters === undefined || rawInstallExporters === null
            ? undefined
            : Boolean(rawInstallExporters),
        storageKind,
        storageVolumeId: storage.volumeId ?? undefined,
        storageNamespace: storageKind ? (storage.namespace || undefined) : undefined,
        storageNamespaceMode: storageKind ? ((storage.namespaceMode ?? storage.namespace_mode) || undefined) : undefined,
        storageCapacity: storage.capacity ?? undefined,
        // Restore custom storage names; leave auto-named volumes blank so they
        // do not lock in a type-specific default (e.g. storage-local-disk).
        storageName,
        hostPath: storage.hostPath ?? undefined,
        nfsServer: storage.nfsServer ?? undefined,
        nfsPath: storage.nfsPath ?? undefined,
        secretNamespace: secret.secretNamespace || undefined,
        secretNamespaceMode: secret.secretNamespaceMode || undefined,
        secretName: secret.secretName || undefined,
        handoffNamespace: handoff.namespace || undefined,
        prewarmEnabled: cache.enabled === true,
        modelCacheEntryId: cache.entryId ?? undefined,
        repoId: cache.repoId ?? undefined,
        revision: cache.revision ?? undefined,
    };
}

/**
 * Where a resumed draft should reopen. A finished cluster shows the completed
 * Execute step; a plan whose Storage step was saved goes to Review. An early
 * partial plan (no storage yet) returns to the remembered configuration step,
 * never to Review, so the wizard cannot skip configuration. Committing a plan
 * on every step means "a plan exists" is not enough to infer "configured".
 */
export function resumeStepForPlan(plan, { hasCluster = false, finished = false, lastStep = null } = {}) {
    if (finished) return 'execute';
    const storageReady = Boolean(plan?.storage?.kind && plan.storage.kind !== 'none');
    if (plan && storageReady) return 'review';
    if (lastStep && ['proxy', 'gateway', 'accelerator', 'versions', 'modelCache', 'storage'].includes(lastStep)) {
        return lastStep;
    }
    if (hasCluster) return 'proxy';
    return 'basics';
}

export function storageSpecValid(state = {}) {
    if (!storageNamespaceValid(state.storageNamespace)) return false;
    if (state.storageKind === 'local-disk') return text(state.hostPath).startsWith('/');
    if (state.storageKind === 'nfs') {
        return Boolean(text(state.nfsServer) && text(state.nfsPath).startsWith('/'));
    }
    return false;
}

export function hfTokenSecretValid(state = {}) {
    return Boolean(
        text(state.secretNamespace)
        && text(state.secretName)
        && (text(state.hfToken) || state.hfTokenSaved || state.hfTokenExternal),
    );
}

/** Whether the HF token requirement is satisfied for Preflight, Review, Execute or Resume. */
export function hfTokenSatisfiedForRun(state = {}) {
    return Boolean(
        text(state.hfToken)
        || state.hfTokenSaved
        || state.hfTokenExternal
        || Boolean(state.executionCompleted)
        || operationDone(
            operationLedgerForRun(state.operationLedger, { hasToken: Boolean(state.hasExecutionToken) }),
            'cache.hf-secret',
        ),
    );
}

export function modelCacheStepValid(state = {}) {
    if (!hfTokenSecretValid(state)) return false;
    if (!state.prewarmEnabled) return true;
    return REPO_ID_PATTERN.test(text(state.repoId)) && Boolean(text(state.revision));
}

function hasControlChar(str) {
    for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i);
        if (code < 32 || code === 127) return true;
    }
    return false;
}

function parseMonitoringNodePort(raw, label) {
    const rawText = text(raw);
    if (!rawText) return { value: null, error: '' };
    if (!/^\d+$/.test(rawText)) {
        return { value: null, error: `${label} must be an integer between 30000 and 32767.` };
    }
    const port = Number(rawText);
    if (!Number.isInteger(port) || port < 30000 || port > 32767) {
        return { value: null, error: `${label} must be between 30000 and 32767.` };
    }
    return { value: port, error: '' };
}

function validateMonitoringUrl(raw, label, { required = false } = {}) {
    const str = String(raw ?? '');
    if (hasControlChar(str)) {
        return `${label} must not contain control characters.`;
    }
    const trimmed = str.trim();
    if (!trimmed) {
        return required ? `${label} is required when using existing monitoring.` : '';
    }
    if (/\s/.test(trimmed) || trimmed.includes('\\')) {
        return `${label} must not contain whitespace or backslashes.`;
    }
    if (trimmed.includes('?') || trimmed.includes('#')) {
        return `${label} must not include query parameters or fragments.`;
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return `${label} must be a valid http:// or https:// URL.`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `${label} must use http:// or https://.`;
    }
    if (parsed.username || parsed.password) {
        return `${label} must not include embedded credentials.`;
    }
    if (!parsed.hostname) {
        return `${label} must include a hostname.`;
    }
    if (parsed.hostname.includes('%')) {
        return `${label} must not include a zone ID.`;
    }
    if (parsed.port === '0') {
        return `${label} port must be between 1 and 65535.`;
    }
    return '';
}

/** Return an actionable error message for the wizard's monitoring section, or empty string when valid. */
export function monitoringValidationError(state = {}) {
    const namespace = text(state.monitoringNamespace);
    if (namespace && (namespace.length > 63 || !DNS1123_LABEL_PATTERN.test(namespace))) {
        return 'Monitoring namespace must be a valid DNS-1123 label (lowercase letters, numbers, and hyphens, max 63 characters).';
    }
    const mode = text(state.monitoringMode) || 'managed';
    if (mode !== 'managed' && mode !== 'existing') {
        return 'Monitoring mode must be managed or existing.';
    }
    if (mode === 'managed') {
        const promPort = parseMonitoringNodePort(state.prometheusNodePort, 'Prometheus NodePort');
        if (promPort.error) return promPort.error;
        const grafPort = parseMonitoringNodePort(state.grafanaNodePort, 'Grafana NodePort');
        if (grafPort.error) return grafPort.error;
        if (promPort.value !== null && grafPort.value !== null && promPort.value === grafPort.value) {
            return 'Prometheus and Grafana NodePorts must be different.';
        }
        const gatewayPortText = text(state.gatewayPort);
        if (gatewayPortText && /^\d+$/.test(gatewayPortText)) {
            const gatewayPort = Number(gatewayPortText);
            if (promPort.value !== null && promPort.value === gatewayPort) {
                return `Prometheus NodePort cannot match the Gateway NodePort (${gatewayPort}).`;
            }
            if (grafPort.value !== null && grafPort.value === gatewayPort) {
                return `Grafana NodePort cannot match the Gateway NodePort (${gatewayPort}).`;
            }
        }
        const host = text(state.monitoringHost);
        if (host) {
            if (/\s/.test(host) || hasControlChar(host)) {
                return 'Monitoring host must not contain whitespace or control characters.';
            }
            if (host.includes('://') || /[/@?#%]/.test(host)) {
                return 'Monitoring host must be a hostname or IP address, not a URL.';
            }
        }
        return '';
    }
    const promUrlError = validateMonitoringUrl(state.prometheusUrl, 'Prometheus URL', { required: true });
    if (promUrlError) return promUrlError;
    return validateMonitoringUrl(state.grafanaUrl, 'Grafana URL', { required: false });
}

/** Return an actionable error message for the optional cluster vLLM image, or empty string when valid. */
export function vllmImageValidationError(state = {}) {
    return validateContainerImageRef(state.vllmImage);
}

export function monitoringStepValid(state = {}) {
    return !monitoringValidationError(state);
}

export function storageStepValid(state = {}) {
    return storageSpecValid(state) && CAPACITY_PATTERN.test(text(state.storageCapacity));
}

/**
 * Whether the wizard may advance past `stepId`. `review` is deliberately gated
 * on a fresh sufficient report and an HF token satisfied for the run.
 */
export function wizardStepCanAdvance(stepId, state = {}) {
    switch (stepId) {
        case 'basics':
            return Boolean(text(state.name)) && (Boolean(state.file) || Boolean(state.clusterId));
        case 'proxy':
            return state.proxyMode === 'auto'
                || Boolean(text(state.httpProxy) || text(state.httpsProxy) || text(state.noProxy));
        case 'gateway':
            return state.gatewayProvider === 'gke' || Boolean(text(state.gatewayAuthzHost));
        case 'accelerator':
            return true;
        case 'versions':
            return monitoringStepValid(state) && !vllmImageValidationError(state);
        case 'modelCache':
            return modelCacheStepValid(state);
        case 'storage':
            return storageStepValid(state);
        case 'review':
            return Boolean(
                state.permissionsSufficient
                && state.permissionsFresh !== false
                && hfTokenSatisfiedForRun(state),
            );
        default:
            return false;
    }
}

function acceleratorProfileId(vendors, vendorId) {
    const vendor = (vendors || []).find((entry) => entry.id === vendorId);
    return vendor?.profileId || undefined;
}

function acceleratorsFromState(state) {
    const selected = state.selectedAccelerators || {};
    return Object.entries(selected).flatMap(([vendorId, modes]) =>
        (Array.isArray(modes) ? modes : []).map((mode) => ({
            vendor: vendorId,
            mode,
            profile: acceleratorProfileId(state.acceleratorVendors, vendorId),
        })),
    );
}

/**
 * Build the backend `ProvisioningPlan` input from wizard state. Steps before
 * Storage cannot produce a valid storage/model-cache pair, so they persist
 * `storage.kind = "none"` and a disabled cache; the Storage step then saves the
 * final plan. This is what lets every configuration step save a valid plan.
 */
export function planConfigFromWizardState(state = {}) {
    const storageReady = storageStepValid(state);
    const accelerators = acceleratorsFromState(state);
    const kubeconfigNs = text(state.kubeconfigNamespace);
    const secretNamespace = text(state.secretNamespace)
        || kubeconfigNs
        || (state.clusterId ? `${STORAGE_NAMESPACE}-${state.clusterId}` : '');
    const secretNamespaceMode = state.secretNamespaceMode || (kubeconfigNs ? 'existing' : 'create');
    const storageNamespace = text(state.storageNamespace) || defaultStorageNamespace(state.clusterId);
    const storageNamespaceMode = state.storageNamespaceMode
        || ((kubeconfigNs && storageNamespace === kubeconfigNs) ? 'existing' : 'create');
    const explicitHandoffNs = text(state.handoffNamespace);
    const handoffNamespace = (explicitHandoffNs && explicitHandoffNs !== 'default')
        ? explicitHandoffNs
        : ((secretNamespaceMode === 'existing' ? secretNamespace : '') || kubeconfigNs || 'default');
    const monitoringMode = text(state.monitoringMode) === 'existing' ? 'existing' : 'managed';
    const monitoringNamespace = text(state.monitoringNamespace) || defaultMonitoringNamespace(state.clusterId);
    const installAcceleratorExporters = state.installAcceleratorExporters === undefined
        ? true
        : Boolean(state.installAcceleratorExporters);

    return {
        gateway: {
            provider: state.gatewayProvider || 'istio',
            // Keep the backend-normalized effective namespace on subsequent
            // saves; only fall back to the default for a brand-new plan.
            namespace: state.gatewayNamespace || GATEWAY_DEFAULTS.namespace,
            namespaceMode: GATEWAY_DEFAULTS.namespaceMode,
            name: state.gatewayName || GATEWAY_DEFAULTS.name,
            publicUrl: state.gatewayPublicUrl,
            port: state.gatewayPort,
            authzHost: state.gatewayAuthzHost,
            serviceType: state.gatewayServiceType || undefined,
        },
        accelerators,
        storage: storageReady
            ? {
                kind: state.storageKind,
                volumeId: state.storageVolumeId || undefined,
                namespace: storageNamespace,
                namespaceMode: storageNamespaceMode,
                capacity: state.storageCapacity,
                readOnly: false,
                purposes: ['model-cache'],
                hostPath: state.storageKind === 'local-disk' ? state.hostPath : null,
                nfsServer: state.storageKind === 'nfs' ? state.nfsServer : null,
                nfsPath: state.storageKind === 'nfs' ? state.nfsPath : null,
            }
            : { kind: 'none' },
        hfTokenSecret: {
            tokenSource: 'create-secret',
            secretName: state.secretName,
            secretNamespace,
            secretNamespaceMode,
        },
        modelCache: {
            enabled: Boolean(state.prewarmEnabled && storageReady),
            entryId: state.modelCacheEntryId || undefined,
            repoId: state.repoId,
            revision: state.revision,
            // The plan references the volume this wizard will create. Use the
            // actual name (explicit or the storage service's auto-name), never
            // a synthetic value unrelated to the created volume.
            storageVolumeRef: storageReady ? plannedStorageVolumeName(state) : null,
        },
        stack: {
            routerVersion: state.routerVersion || null,
            gieVersion: state.gieVersion || null,
            ippVersion: state.ippVersion || null,
            lwsVersion: state.lwsVersion || null,
            lwsEnabled: true,
            crdsEnabled: true,
            imagePrepullEnabled: accelerators.length > 0,
            vllmImage: text(state.vllmImage) || null,
        },
        runtime: {
            inotifyEnabled: true,
            inotifyLimit: state.inotifyMaxUserInstances || 8192,
        },
        handoff: {
            namespace: handoffNamespace,
        },
        monitoring: {
            enabled: true,
            mode: monitoringMode,
            namespace: monitoringNamespace,
            prometheusUrl: monitoringMode === 'existing' ? (text(state.prometheusUrl) || null) : null,
            grafanaUrl: monitoringMode === 'existing' ? (text(state.grafanaUrl) || null) : null,
            prometheusNodePort: monitoringMode === 'managed' ? (text(state.prometheusNodePort) || null) : null,
            grafanaNodePort: monitoringMode === 'managed' ? (text(state.grafanaNodePort) || null) : null,
            host: monitoringMode === 'managed' ? (text(state.monitoringHost) || null) : null,
            installAcceleratorExporters,
        },
        spec: {},
    };
}

/** Convenience wrapper used by the wizard before `putPlan`. */
export function planFromWizardState(state = {}) {
    return buildPlan(planConfigFromWizardState(state));
}

/** Extract plan, hash, version, and secret/handoff namespace sync fields from an OperationReport. */
export function planSyncFromPermissionReport(report, { currentPlanHash } = {}) {
    const plan = report?.plan && typeof report.plan === 'object' ? report.plan : null;
    const fields = plan ? planToWizardFields(plan) : {};
    const planHash = report?.planHash || null;
    const planVersion = report?.planVersion ?? null;
    return {
        plan,
        planHash,
        planVersion,
        secretNamespace: fields.secretNamespace || null,
        secretNamespaceMode: fields.secretNamespaceMode || null,
        storageNamespace: fields.storageNamespace || null,
        storageNamespaceMode: fields.storageNamespaceMode || null,
        monitoringNamespace: fields.monitoringNamespace || null,
        handoffNamespace: fields.handoffNamespace || null,
        planChanged: Boolean(planHash && planInvalidatesRun(currentPlanHash, planHash)),
    };
}

/**
 * Extract ledger, draft HF token status, and safe plan alignment fields from a
 * `GET /clusters/{id}` detail payload without masking stale-plan detection.
 */
export function clusterDetailSyncForReport(detail, { reportPlanHash = null, currentPlanHash = null } = {}) {
    if (!detail || typeof detail !== 'object') {
        return {
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
        };
    }
    const ledger = detail.executionOperations && typeof detail.executionOperations === 'object'
        ? detail.executionOperations
        : {};
    const draftHfTokenSaved = typeof detail.draftHfTokenSaved === 'boolean'
        ? detail.draftHfTokenSaved
        : null;
    const detailPlanHash = detail.planHash || null;
    const alignPlan = Boolean(
        detailPlanHash && (reportPlanHash ? detailPlanHash === reportPlanHash : !currentPlanHash),
    );
    const plan = alignPlan && detail.plan && typeof detail.plan === 'object' ? detail.plan : null;
    const fields = plan ? planToWizardFields(plan) : {};
    return {
        hasDetail: true,
        ledger,
        draftHfTokenSaved,
        alignPlan,
        plan,
        planHash: alignPlan ? detailPlanHash : null,
        planVersion: alignPlan && detail.planVersion !== undefined && detail.planVersion !== null
            ? detail.planVersion
            : null,
        secretNamespace: fields.secretNamespace || null,
        secretNamespaceMode: fields.secretNamespaceMode || null,
        storageNamespace: fields.storageNamespace || null,
        storageNamespaceMode: fields.storageNamespaceMode || null,
        monitoringNamespace: fields.monitoringNamespace || null,
        handoffNamespace: fields.handoffNamespace || null,
    };
}

/**
 * Explain why Execute is disabled when the Execute step is settled and no other
 * dedicated blocker callout already explains the action needed.
 */
export function executeDisabledReason({
    canExecute = false,
    finished = false,
    finishing = false,
    permissionBusy = false,
    handoffBusy = false,
    resumeBusy = false,
    executionBlocked = false,
    canResume = false,
    hasCluster = true,
    hasPlan = true,
    hasReport = false,
    reportStatus = null,
    hasPermissionError = false,
    permissionsFresh = true,
    hasHfToken = false,
    adminVerified = false,
    hasToken = false,
    hasAdminOperations = true,
} = {}) {
    if (
        canExecute
        || finished
        || finishing
        || permissionBusy
        || handoffBusy
        || resumeBusy
        || executionBlocked
        || canResume
        || hasPermissionError
    ) {
        return null;
    }
    if (!hasCluster) {
        return {
            code: 'missing_cluster',
            message: 'Cluster draft is not loaded yet. Go back and save the cluster before executing.',
            canRecheck: false,
        };
    }
    if (!hasPlan) {
        return {
            code: 'missing_plan',
            message: 'Provisioning plan is not loaded yet. Click Re-check to reload the plan and permissions.',
            canRecheck: true,
        };
    }
    if (!hasReport) {
        return {
            code: 'missing_report',
            message: 'Permission check has not completed for this plan yet. Click Re-check to evaluate permissions before executing.',
            canRecheck: true,
        };
    }
    if (!permissionsFresh) {
        return {
            code: 'stale_plan',
            message: 'The permission check belongs to a different plan version. Click Re-check to evaluate the current plan before executing.',
            canRecheck: true,
        };
    }
    if (reportStatus === 'blocked') return null;
    if (reportStatus === 'admin_required' && hasAdminOperations && (!adminVerified || !hasToken)) {
        return null;
    }
    if (!hasHfToken) return null;
    return {
        code: 'unknown',
        message: 'Permissions need to be re-checked before executing. Click Re-check to refresh the current status.',
        canRecheck: true,
    };
}

/**
 * Hide the Execute step's Setup progress panel until execution is active,
 * finished, failed, or a live resumed run has recorded user/Lens/failed progress.
 */
export function shouldShowSetupProgress({
    finishing = false,
    finished = false,
    executionFailedKey = null,
    operationLedger = {},
    hasExecutionToken = false,
} = {}) {
    if (finishing || finished || Boolean(executionFailedKey)) return true;
    const activeLedger = operationLedgerForRun(operationLedger, { hasToken: Boolean(hasExecutionToken) });
    return Object.values(activeLedger).some(
        (state) => state === 'user_done' || state === 'lens_done' || state === 'failed',
    );
}
