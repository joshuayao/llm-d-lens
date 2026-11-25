import { downloadClusterSoftware, listLensHosts, loadClusterCrds, loadClusterKubernetesVersion, loadClusterLws, loadStackVersions } from '../../optimization';
import { requestJson } from '../../../shared/api/httpClient';
// Multi-step "Create Cluster" wizard.
//
// The wizard is configuration-first: every configuration step saves the
// backend provisioning plan and never mutates the target cluster. Review
// previews the saved plan, and Execute runs the plan-scoped permission check
// followed by the guarded plan steps.
// See docs/design/cluster-permission-preflight-design.md sections 4.4/4.5/4.6
// and 8.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    BookOpen,
    Check,
    CheckCircle2,
    Cpu,
    Database,
    Globe,
    HardDrive,
    KeyRound,
    ListChecks,
    Rocket,
    Server,
    Tag,
    Upload,
    Waypoints,
} from 'lucide-react';
import { Badge, Button, Checkbox, Input, Label, Modal, Panel, SectionLabel, Select, Spinner, Textarea, ToggleGroup } from '../../../shared/ui';
import { HelpTooltip } from '../../../shared/ui/FormControls';
import { FormError } from '../../../shared/ui/FormError';
import { cn } from '../../../shared/lib/cn';
import { listStorageNodes } from '../../storage';
import { errorMessage } from '../../storage';
import { getHardwareProfiles, acceleratorVendorsFromProfiles, accessModesForVendor } from './ClusterMonitoringStack/hardwareProfilesBackend';
import { BootstrapNodesPanel } from './ClusterBootstrap/BootstrapNodesPanel';
import {
    adminHandoffStatus,
    cancelExecution,
    completeExecution,
    executeOperation,
    getCluster,
    permissionCheck,
    permissionDetails,
    permissionRemediation,
    putPlan,
    saveDraftHfToken,
    verifyAdminHandoff,
} from './clusterPermissionBackend';
import {
    CAPACITY_PATTERN,
    REPO_ID_PATTERN,
    WIZARD_STEP_IDS,
    canExecuteOperationRun,
    canNavigateBackFromExecute,
    canResumeOperationRun,
    clearExecutionToken,
    clearResumeState,
    clusterDetailSyncForReport,
    defaultMonitoringNamespace,
    defaultStorageNamespace,
    executeDisabledReason,
    hfTokenSatisfiedForRun,
    loadExecutionToken,
    loadResumeDraftId,
    loadResumeStep,
    monitoringValidationError,
    operationDone,
    operationLedgerForRun,
    operationProgressForLedger,
    planFromWizardState,
    planSyncFromPermissionReport,
    planToWizardFields,
    plannedStorageVolumeName,
    nextExecutionCompleted,
    planInvalidatesRun,
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
    adminVerificationReady,
    canRunPreflight,
    completeFailureAction,
    createResumeGate,
    executionCompletedForPlan,
    executionFailureAction,
    handoffFallbackFromVerifyError,
    permissionPanelVisible,
    verificationFailureAction,
    verificationBlocksRun,
    verifyRefreshesOperationLedger,
    versionCheckBlocks,
    versionCheckMessage,
    vllmImageValidationError,
    wizardStepCanAdvance,
} from './clusterWizardState';
import { PermissionHandoffPanel } from './PermissionHandoffPanel';

const KUBECONFIG_GUIDE_URL = 'https://llm-d-incubation.github.io/llm-d-lens/user-guide/clusters#kubeconfig-permissions';

const STEPS = [
    { id: 'basics', label: 'Basic Info', icon: Server },
    { id: 'proxy', label: 'Network Proxy', icon: Globe },
    { id: 'gateway', label: 'Model gateway', icon: Waypoints },
    { id: 'accelerator', label: 'Accelerator', icon: Cpu },
    { id: 'versions', label: 'llm-d stack', icon: Tag },
    { id: 'modelCache', label: 'Model Cache', icon: Database },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'review', label: 'Review', icon: ListChecks },
    { id: 'execute', label: 'Execute', icon: Rocket },
];

const REVIEW_STEP_INDEX = 7;
const EXECUTE_STEP_INDEX = 8;

function isPermissionError(error) {
    return error?.status === 403
        || error?.code === 'kubernetes_permission_denied'
        || error?.code === 'operation_blocked';
}

const ACCESS_MODE_LABEL = { dra: 'DRA (Dynamic Resource Allocation)', plugin: 'Device plugin' };
const ACCESS_MODE_SHORT = { dra: 'DRA', plugin: 'Device plugin' };
const GATEWAY_PROVIDER_LABEL = {
    istio: 'Istio',
    gke: 'GKE Gateway',
    agentgateway: 'Agentgateway',
    'envoy-ai-gateway': 'Envoy AI Gateway',
};
const STORAGE_KIND_LABEL = { 'local-disk': 'hostPath', nfs: 'NFS' };

function ReviewRow({ label, children, mono = false }) {
    return (
        <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-baseline gap-3 py-2">
            <dt className="text-[11px] font-medium text-theme-muted">{label}</dt>
            <dd className={cn(
                'min-w-0 break-words text-xs text-theme-text',
                mono && 'break-all font-mono text-[11px] text-theme-muted',
            )}>
                {children}
            </dd>
        </div>
    );
}

function PanelHeading({ icon, children }) {
    return (
        <span className="flex items-center gap-2">
            <span className="text-sky-600 dark:text-sky-400">{icon}</span>
            {children}
        </span>
    );
}

const ACCELERATOR_VENDORS = [
    { id: 'intel', label: 'Intel GPU', disabled: false, accessModes: ['dra', 'plugin'] },
    { id: 'nvidia', label: 'Nvidia GPU', disabled: true, accessModes: ['dra', 'plugin'] },
];

function request(path, options = {}) {
    return requestJson(path, { headers: { 'Content-Type': 'application/json' }, ...options });
}

function InlineHfTokenBanner({
    message,
    token,
    onTokenChange,
    onSave,
    busy,
    disabled,
    error,
}) {
    return (
        <div
            role="status"
            className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-200"
        >
            <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle size={13} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{message}</span>
                <Input
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    onChange={(event) => onTokenChange(event.target.value)}
                    placeholder="hf_..."
                    aria-label="Hugging Face token"
                    disabled={busy || disabled}
                    className="h-8 w-48 py-1 text-xs sm:w-56"
                />
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onSave}
                    isLoading={busy}
                    disabled={disabled || busy || !token.trim()}
                >
                    Save token
                </Button>
            </div>
            {error && (
                <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-300">
                    {error}
                </p>
            )}
        </div>
    );
}

function secretValuesFor(operation, hfToken, { hfTokenSaved = false } = {}) {
    if (operation?.secretCopy) return undefined;
    const fields = Array.isArray(operation?.userSecretFields) ? operation.userSecretFields : [];
    if (!fields.length) return undefined;
    const trimmed = hfToken.trim();
    if (fields.includes('HF_TOKEN') && !trimmed && hfTokenSaved && fields.length === 1) {
        return undefined;
    }
    const values = {};
    for (const field of fields) {
        if (field === 'HF_TOKEN') values[field] = trimmed;
        else values[field] = '';
    }
    return values;
}

// Polls the llm-d versions step's real llm-d / llm-d-benchmark downloads
// (see llm_d_lens.cluster.repo_downloads on the backend) until both refs
// that were requested reach a terminal state (ready/failed), reporting
// intermediate progress via `onUpdate` so the UI can show live status.


export function CreateClusterWizard({ onClose, onCreated }) {
    // The application database is configured once at install time by the
    // online installer (see llm_d_lens/db/bootstrap_cli.py), not here -- this is
    // just a sanity check that surfaces a clear error if that step was ever skipped.
    const [dbStatus, setDbStatus] = useState(null); // null while loading, else DatabaseStatus
    const [dbStatusError, setDbStatusError] = useState('');
    useEffect(() => {
        let cancelled = false;
        request('/api/v1/system/database')
            .then((status) => {
                if (!cancelled) setDbStatus(status);
            })
            .catch((err) => {
                if (!cancelled) setDbStatusError(errorMessage(err));
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const [stepIndex, setStepIndex] = useState(0);
    const [cluster, setCluster] = useState(null); // created after Step 1
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    // Configuration-first plan state. Every configuration step saves the plan
    // through PUT /plan; Review evaluates its permission report and Execute
    // runs the guarded operations with the same plan hash.
    const [plan, setPlan] = useState(null);
    const [planHash, setPlanHash] = useState(null);
    const [planVersion, setPlanVersion] = useState(null);
    const [permissionReport, setPermissionReport] = useState(null);
    const [permissionBusy, setPermissionBusy] = useState(false);
    const [permissionError, setPermissionError] = useState('');
    const [executionToken, setExecutionToken] = useState(null);
    const [resumeBusy, setResumeBusy] = useState(false);
    const [resumeError, setResumeError] = useState('');
    const [resumeAttempt, setResumeAttempt] = useState(0);
    const [executionBlocked, setExecutionBlocked] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [notice, setNotice] = useState('');

    // Plan-scoped administrator handoff (also used after a 403 during Execute).
    const [remediationScript, setRemediationScript] = useState('');
    const [remediationInfo, setRemediationInfo] = useState(null);
    const [handoffInfo, setHandoffInfo] = useState(null);
    const [operationLedger, setOperationLedger] = useState({});
    const [handoffBusy, setHandoffBusy] = useState(false);
    const [handoffError, setHandoffError] = useState('');
    const [handoffWarning, setHandoffWarning] = useState('');

    // Step 1: basic info
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [file, setFile] = useState(null);
    // "I have kubeconfig" (upload) vs "Bootstrap via Kubespray" -- see
    // docs/design/cluster-design.md#kubernetes-bootstrap. Bootstrapping only ever produces a
    // kubeconfig string that gets wrapped into a synthetic File below, so
    // every other Step 1 field/validation/submit path stays untouched.
    const [kubeconfigSource, setKubeconfigSource] = useState('upload'); // 'upload' | 'bootstrap'
    // Remount the native file input when a failed draft is discarded so the
    // same file can be selected again (a value-less input keeps the old file).
    const [kubeconfigInputKey, setKubeconfigInputKey] = useState(0);

    // Step 2: proxy
    const [proxyMode, setProxyMode] = useState('auto');
    const [httpProxy, setHttpProxy] = useState('');
    const [httpsProxy, setHttpsProxy] = useState('');
    const [noProxy, setNoProxy] = useState('');

    // Step 4: the llm-d component versions are fixed by the Lens stack profile
    // (GET /api/v1/versions) and shown read-only; they are never user choices.
    const [stackVersions, setStackVersions] = useState(null);
    // Version values written into the plan. They default from the read stack
    // profile and are restored on resume so a saved plan never loses them.
    const [routerVersion, setRouterVersion] = useState('');
    const [gieVersion, setGieVersion] = useState('');
    const [ippVersion, setIppVersion] = useState('');
    const [lwsVersion, setLwsVersion] = useState('');
    // Optional cluster-wide vLLM runtime image override (empty = hardware profile default).
    const [vllmImage, setVllmImage] = useState('');
    // Shared llm-d Gateway provider installed once at cluster creation (the
    // model service then publishes HTTPRoute/IPP against it).
    const [gatewayProvider, setGatewayProvider] = useState('istio');
    // Backend-normalized effective Gateway coordinates from the stored plan.
    const [gatewayNamespace, setGatewayNamespace] = useState('');
    const [gatewayName, setGatewayName] = useState('');
    const [gatewayServiceType, setGatewayServiceType] = useState('');
    const [gatewayPort, setGatewayPort] = useState('');
    // Optional externally reachable Gateway host/IP (or full URL); empty lets
    // Lens derive one from the cluster.
    const [gatewayPublicUrl, setGatewayPublicUrl] = useState('');
    const [gatewayAuthzHost, setGatewayAuthzHost] = useState('');
    // Per-uid inotify instance limit Lens applies to every node; kind's 128
    // default is exhausted by a busy node ("too many open files").
    const [inotifyMaxUserInstances, setInotifyMaxUserInstances] = useState('8192');
    const [lensHosts, setLensHosts] = useState([]);
    // Real download progress for the refs above (see repo_downloads on the
    // backend) -- populated while goNext() from this step is in flight.
    const [versionsDownloading, setVersionsDownloading] = useState(false);
    const [versionsDownloadStatus, setVersionsDownloadStatus] = useState(null); // { llmD, llmDBenchmark }
    // Model-server/router image pre-pull onto every node for the selected accelerators.
    // Gateway API / Gateway API Inference Extension / llm-d Router CRD presence on the cluster.
    const [crdStatus, setCrdStatus] = useState(null); // { gateway_api, gateway_api_inference_extension, llm_d_router }
    // LeaderWorkerSet controller + DisaggregatedSet API used by the P/D Guide.
    const [lwsStatus, setLwsStatus] = useState(null); // { ready, crd, controller, version, message }
    // Reachability + Kubernetes-version check after the kubeconfig upload.
    const [k8sCheck, setK8sCheck] = useState(null); // { reachable, version, min_k8s_version, supported }
    // A `forbidden` version read during configuration is a warning, not a block.
    const [k8sWarning, setK8sWarning] = useState('');

    // Step 5 (index 4, llm-d stack): mandatory cluster monitoring configuration.
    const [monitoringMode, setMonitoringMode] = useState('managed');
    const [monitoringNamespace, setMonitoringNamespace] = useState('');
    const [monitoringNamespaceTouched, setMonitoringNamespaceTouched] = useState(false);
    const [prometheusUrl, setPrometheusUrl] = useState('');
    const [grafanaUrl, setGrafanaUrl] = useState('');
    const [prometheusNodePort, setPrometheusNodePort] = useState('');
    const [grafanaNodePort, setGrafanaNodePort] = useState('');
    const [monitoringHost, setMonitoringHost] = useState('');
    const [installAcceleratorExporters, setInstallAcceleratorExporters] = useState(true);

    // Step 4: accelerator (optional). Selection only writes the plan; the
    // driver/plugin install is deferred to Execute.
    const [acceleratorVendors, setAcceleratorVendors] = useState(ACCELERATOR_VENDORS);
    // vendor -> model-server image (repository and version). Owned by the
    // hardware profile, not the pinned stack, so it is read from capabilities.
    const [modelServerImages, setModelServerImages] = useState({});
    // Multi-select: vendor id -> selected driver access modes. Candidates are
    // the device-plugin-supported hardware profiles, not cluster discovery.
    const [selectedAccelerators, setSelectedAccelerators] = useState({});

    // Accelerator candidates come from the registered hardware profiles (the
    // device-plugin-supported set); the static list is the fallback. The same
    // profiles carry each vendor's model-server image.
    useEffect(() => {
        const controller = new AbortController();
        getHardwareProfiles({ signal: controller.signal })
            .then((payload) => {
                if (controller.signal.aborted) return;
                setAcceleratorVendors(acceleratorVendorsFromProfiles(payload?.profiles, ACCELERATOR_VENDORS));
                const images = {};
                for (const profile of payload?.profiles || []) {
                    const vendor = String(profile?.vendor || profile?.id || '').toLowerCase();
                    const image = profile?.deployment?.runtime_image;
                    if (vendor && image) images[vendor] = image;
                }
                setModelServerImages(images);
            })
            .catch(() => {});
        return () => controller.abort();
    }, []);

    // Read-only llm-d stack the wizard will install (versions come from the
    // backend's pinned profile, not from the user).
    useEffect(() => {
        const controller = new AbortController();
        loadStackVersions()
            .then((payload) => {
                if (controller.signal.aborted) return;
                setStackVersions(payload);
                setRouterVersion((current) => current || payload?.llm_d_router || '');
                setGieVersion((current) => current || payload?.k8s_gateway_api_inference_extension || '');
                setIppVersion((current) => current || payload?.llm_d_inference_payload_processor || '');
            })
            .catch(() => {});
        return () => controller.abort();
    }, []);

    // Refresh the pinned cluster prerequisites when the stack step opens.
    useEffect(() => {
        if (stepIndex !== 4 || !cluster) return undefined;
        const controller = new AbortController();
        loadClusterCrds(cluster.id)
            .then((payload) => {
                if (!controller.signal.aborted) setCrdStatus(payload);
            })
            .catch(() => {});
        loadClusterLws(cluster.id)
            .then((payload) => {
                if (!controller.signal.aborted) setLwsStatus(payload);
            })
            .catch(() => {});
        return () => controller.abort();
    }, [stepIndex, cluster]);

    // Selected (vendor, mode) pairs, flattened for the plan and the Review /
    // Execute views. A heterogeneous cluster selects several vendors.
    const acceleratorPairs = useMemo(
        () =>
            Object.entries(selectedAccelerators).flatMap(([vendorId, modes]) =>
                (Array.isArray(modes) ? modes : []).map((mode) => ({
                    vendorId,
                    mode,
                    key: `${vendorId}:${mode}`,
                    profileId: acceleratorVendors.find((vendor) => vendor.id === vendorId)?.profileId,
                    label: acceleratorVendors.find((vendor) => vendor.id === vendorId)?.label || vendorId,
                })),
            ),
        [selectedAccelerators, acceleratorVendors],
    );
    const selectedAcceleratorIds = useMemo(
        () => [...new Set(acceleratorPairs.map((pair) => pair.vendorId))],
        [acceleratorPairs],
    );

    // Step 6: model cache prewarm (optional) and the HF_TOKEN secret that is
    // created during Execute (never during configuration).
    const [prewarmEnabled, setPrewarmEnabled] = useState(false);
    const [secretNamespace, setSecretNamespace] = useState('llm-d-bench-storage');
    const [secretNamespaceMode, setSecretNamespaceMode] = useState('');
    const [secretNamespaceTouched, setSecretNamespaceTouched] = useState(false);
    const [handoffNamespace, setHandoffNamespace] = useState('');
    // Suffix the Secret name so two clusters sharing an API server never collide.
    const [secretName, setSecretName] = useState(() => `hf-token-${crypto.randomUUID().slice(0, 8)}`);
    const [hfToken, setHfToken] = useState('');
    const [hfTokenSaved, setHfTokenSaved] = useState(false);
    const [inlineToken, setInlineToken] = useState('');
    const [inlineTokenBusy, setInlineTokenBusy] = useState(false);
    const [inlineTokenError, setInlineTokenError] = useState('');
    // Set once the Execute HF_SECRET step has created the Secret; used by the
    // Model Cache step that follows it.
    const [repoId, setRepoId] = useState('');
    const [revision, setRevision] = useState('main');
    const [modelCacheEntryId, setModelCacheEntryId] = useState('');
    // Step 7: storage volume.
    const [storageKind, setStorageKind] = useState('local-disk');
    const [storageVolumeId, setStorageVolumeId] = useState('');
    const [storageName, setStorageName] = useState('');
    const [storageNamespace, setStorageNamespace] = useState('');
    const [storageNamespaceMode, setStorageNamespaceMode] = useState('');
    const [storageNamespaceTouched, setStorageNamespaceTouched] = useState(false);
    const [storageCapacity, setStorageCapacity] = useState('');
    const [hostPath, setHostPath] = useState('');
    const [nfsServer, setNfsServer] = useState('');
    const [nfsPath, setNfsPath] = useState('');
    const [storageNodes, setStorageNodes] = useState([]);

    // Step 9: execution progress
    const [finishing, setFinishing] = useState(false);
    const [finishStatus, setFinishStatus] = useState([]); // [{key, label, state: 'pending'|'running'|'done'|'failed', detail}]
    const [finished, setFinished] = useState(false);
    // The backend recorded a completion for this plan: every operation is
    // already done, so Review offers finalize instead of running anything again.
    const [executionCompleted, setExecutionCompleted] = useState(false);
    const [executionFailedKey, setExecutionFailedKey] = useState(null);

    const firstFieldRef = useRef(null);
    useEffect(() => {
        firstFieldRef.current?.focus();
    }, [stepIndex]);

    // Draft cleanup on hard navigation away (tab close/refresh/browser back).
    // A draft that has a saved plan or is in an administrator handoff must
    // survive the unload so the user can resume it; only an early draft without
    // a plan is deleted here. An explicit Discard is the only other delete.
    // `keepalive: true` lets the DELETE survive the page unloading.
    const draftCleanupRef = useRef({ cluster: null, finished: false, planHash: null, handoff: false });
    useEffect(() => {
        draftCleanupRef.current = {
            cluster,
            finished,
            planHash,
            handoff: Boolean(permissionReport && ['admin_required', 'blocked'].includes(permissionReport.status)),
        };
    }, [cluster, finished, planHash, permissionReport]);
    useEffect(() => {
        const cleanupDraft = () => {
            const current = draftCleanupRef.current;
            if (!current.cluster || current.finished) return;
            if (current.planHash || current.handoff) return; // resumable draft
            requestJson(`/api/cluster/clusters/${encodeURIComponent(current.cluster.id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
            clearResumeState();
        };
        window.addEventListener('pagehide', cleanupDraft);
        return () => window.removeEventListener('pagehide', cleanupDraft);
    }, []);
    useEffect(() => {
        let alive = true;
        listLensHosts().then((items) => {
            if (!alive) return;
            setLensHosts(items);
            setGatewayAuthzHost((current) => current || items[0] || '');
        }).catch(() => {});
        return () => { alive = false; };
    }, []);

    // Default HF_TOKEN secret namespace uses the kubeconfig's readable namespace
    // hint when available (so namespace-scoped edit ServiceAccounts use an
    // existing writable namespace), or falls back to a per-cluster namespace.
    const kubeconfigNamespace = cluster?.kubeconfigNamespace || k8sCheck?.kubeconfig_namespace || '';
    useEffect(() => {
        if (secretNamespaceTouched || !cluster?.id) return;
        setSecretNamespace(kubeconfigNamespace || `llm-d-bench-storage-${cluster.id}`);
        setSecretNamespaceMode(kubeconfigNamespace ? 'existing' : 'create');
    }, [cluster?.id, kubeconfigNamespace, secretNamespaceTouched]);

    useEffect(() => {
        if (storageNamespaceTouched || !cluster?.id) return;
        setStorageNamespace(defaultStorageNamespace(cluster.id));
        setStorageNamespaceMode('create');
    }, [cluster?.id, storageNamespaceTouched]);

    useEffect(() => {
        if (monitoringNamespaceTouched || !cluster?.id) return;
        setMonitoringNamespace(defaultMonitoringNamespace(cluster.id));
    }, [cluster?.id, monitoringNamespaceTouched]);

    useEffect(() => {
        if (stepIndex !== 6 || !cluster || storageKind !== 'local-disk') return undefined;
        const controller = new AbortController();
        (async () => {
            try {
                const items = await listStorageNodes({ clusterId: cluster.id, signal: controller.signal });
                setStorageNodes(items.filter((node) => node.schedulable !== false));
            } catch {
                // Non-fatal: fields fall back to free text entry.
            }
        })();
        return () => controller.abort();
    }, [stepIndex, storageKind, cluster]);

    const permissionReady = permissionReport?.status === 'ready';
    const permissionBlocked = permissionReport?.status === 'blocked';
    const adminRequired = permissionReport?.status === 'admin_required';
    const adminVerified = adminVerificationReady(handoffInfo);
    const hfTokenExternal = Boolean(plan?.hfTokenSecret?.tokenSource?.startsWith('existing-secret:'));
    const hasHfTokenForRun = hfTokenSatisfiedForRun({
        hfToken,
        hfTokenSaved,
        hfTokenExternal,
        operationLedger,
        hasExecutionToken: Boolean(executionToken),
        executionCompleted,
    });
    const hfSecretAlreadyCreated = Boolean(executionCompleted)
        || operationDone(
            operationLedgerForRun(operationLedger, { hasToken: Boolean(executionToken) }),
            'cache.hf-secret',
        );
    const hfTokenStatusLabel = hfToken.trim()
        ? 'token provided'
        : hfTokenSaved
            ? 'token saved for draft'
            : hfTokenExternal
                ? 'existing secret'
                : hfSecretAlreadyCreated
                    ? 'secret already created'
                    : 'token required';
    const wizardState = {
        clusterId: cluster?.id,
        kubeconfigNamespace,
        name,
        file,
        proxyMode,
        httpProxy,
        httpsProxy,
        noProxy,
        gatewayProvider,
        gatewayServiceType,
        gatewayNamespace,
        gatewayName,
        gatewayPort,
        gatewayPublicUrl,
        gatewayAuthzHost,
        inotifyMaxUserInstances,
        acceleratorVendors,
        selectedAccelerators,
        routerVersion: routerVersion || stackVersions?.llm_d_router || '',
        gieVersion: gieVersion || stackVersions?.k8s_gateway_api_inference_extension || '',
        ippVersion: ippVersion || stackVersions?.llm_d_inference_payload_processor || '',
        lwsVersion,
        vllmImage,
        monitoringMode,
        monitoringNamespace,
        prometheusUrl,
        grafanaUrl,
        prometheusNodePort,
        grafanaNodePort,
        monitoringHost,
        installAcceleratorExporters,
        storageKind,
        storageVolumeId,
        storageNamespace,
        storageNamespaceMode,
        storageCapacity,
        storageName,
        hostPath,
        nfsServer,
        nfsPath,
        prewarmEnabled,
        modelCacheEntryId,
        repoId,
        revision,
        secretNamespace,
        secretNamespaceMode,
        secretName,
        handoffNamespace,
        hfToken,
        hfTokenSaved,
        hfTokenExternal,
        operationLedger,
        hasExecutionToken: Boolean(executionToken),
        executionCompleted,
        permissionsSufficient: !permissionBlocked && (permissionReady || adminVerified),
        permissionsFresh: !permissionReport?.planHash || permissionReport.planHash === planHash,
    };
    const canGoNext = wizardStepCanAdvance(WIZARD_STEP_IDS[stepIndex], wizardState);
    const canExecute = Boolean(cluster?.id && plan)
        && wizardStepCanAdvance('review', wizardState)
        && !finishing
        && !permissionBusy
        && !executionBlocked
        && canExecuteOperationRun({
            reportStatus: permissionReport?.status,
            adminVerified,
            hasToken: Boolean(executionToken),
            busy: handoffBusy || resumeBusy,
        });
    const canPreflight = canRunPreflight({
        hasCluster: Boolean(cluster?.id),
        planHash,
        permissionBusy,
        handoffBusy,
        resumeBusy,
        finishing,
        executionBlocked,
        hasSecretInput: hasHfTokenForRun,
    });
    const canGoBackFromExecute = canNavigateBackFromExecute({
        finished,
        finishing,
        cancelling,
        permissionBusy,
        handoffBusy,
        executionBlocked,
    });

    // Apply a stored plan back onto the wizard fields (resume path only).
    const applyWizardFields = useCallback((fields) => {
        if (!fields) return;
        if (fields.gatewayProvider !== undefined) setGatewayProvider(fields.gatewayProvider);
        if (fields.gatewayServiceType !== undefined) setGatewayServiceType(fields.gatewayServiceType || '');
        if (fields.gatewayNamespace !== undefined) setGatewayNamespace(fields.gatewayNamespace);
        if (fields.gatewayName !== undefined) setGatewayName(fields.gatewayName);
        if (fields.gatewayPort !== undefined) setGatewayPort(fields.gatewayPort);
        if (fields.gatewayPublicUrl !== undefined) setGatewayPublicUrl(fields.gatewayPublicUrl || '');
        if (fields.gatewayAuthzHost !== undefined) setGatewayAuthzHost(fields.gatewayAuthzHost || '');
        if (fields.inotifyMaxUserInstances !== undefined) setInotifyMaxUserInstances(fields.inotifyMaxUserInstances);
        if (fields.selectedAccelerators !== undefined) setSelectedAccelerators(fields.selectedAccelerators);
        if (fields.routerVersion !== undefined) setRouterVersion(fields.routerVersion || '');
        if (fields.gieVersion !== undefined) setGieVersion(fields.gieVersion || '');
        if (fields.ippVersion !== undefined) setIppVersion(fields.ippVersion || '');
        if (fields.lwsVersion !== undefined) setLwsVersion(fields.lwsVersion || '');
        if (fields.vllmImage !== undefined) setVllmImage(fields.vllmImage || '');
        if (fields.monitoringMode !== undefined) setMonitoringMode(fields.monitoringMode);
        if (fields.monitoringNamespace !== undefined) {
            setMonitoringNamespace(fields.monitoringNamespace);
            setMonitoringNamespaceTouched(true);
        }
        if (fields.prometheusUrl !== undefined) setPrometheusUrl(fields.prometheusUrl || '');
        if (fields.grafanaUrl !== undefined) setGrafanaUrl(fields.grafanaUrl || '');
        if (fields.prometheusNodePort !== undefined) setPrometheusNodePort(fields.prometheusNodePort || '');
        if (fields.grafanaNodePort !== undefined) setGrafanaNodePort(fields.grafanaNodePort || '');
        if (fields.monitoringHost !== undefined) setMonitoringHost(fields.monitoringHost || '');
        if (fields.installAcceleratorExporters !== undefined) {
            setInstallAcceleratorExporters(Boolean(fields.installAcceleratorExporters));
        }
        if (fields.storageKind !== undefined) setStorageKind(fields.storageKind);
        if (fields.storageVolumeId !== undefined) setStorageVolumeId(fields.storageVolumeId || '');
        if (fields.storageNamespace !== undefined) {
            setStorageNamespace(fields.storageNamespace);
            setStorageNamespaceTouched(true);
        }
        if (fields.storageNamespaceMode !== undefined) {
            setStorageNamespaceMode(fields.storageNamespaceMode || '');
        }
        if (fields.storageCapacity !== undefined) setStorageCapacity(fields.storageCapacity || '');
        if (fields.storageName !== undefined) setStorageName(fields.storageName || '');
        if (fields.hostPath !== undefined) setHostPath(fields.hostPath || '');
        if (fields.nfsServer !== undefined) setNfsServer(fields.nfsServer || '');
        if (fields.nfsPath !== undefined) setNfsPath(fields.nfsPath || '');
        if (fields.secretNamespace !== undefined) {
            setSecretNamespace(fields.secretNamespace);
            setSecretNamespaceTouched(true);
        }
        if (fields.secretNamespaceMode !== undefined) setSecretNamespaceMode(fields.secretNamespaceMode || '');
        if (fields.secretName !== undefined) setSecretName(fields.secretName);
        if (fields.handoffNamespace !== undefined) setHandoffNamespace(fields.handoffNamespace || '');
        if (fields.prewarmEnabled !== undefined) setPrewarmEnabled(fields.prewarmEnabled);
        if (fields.modelCacheEntryId !== undefined) setModelCacheEntryId(fields.modelCacheEntryId || '');
        if (fields.repoId !== undefined) setRepoId(fields.repoId || '');
        if (fields.revision !== undefined) setRevision(fields.revision || 'main');
    }, []);

    // Adopt an updated plan/hash returned by POST /permission-check (e.g.
    // auto-aligned HF secret/handoff namespaces) and clear stale run state.
    const adoptPermissionCheckPlan = useCallback((report, clusterId, currentPlanHash) => {
        const sync = planSyncFromPermissionReport(report, { currentPlanHash });
        if (sync.plan) {
            setPlan(sync.plan);
            if (sync.secretNamespace) {
                setSecretNamespace(sync.secretNamespace);
                setSecretNamespaceTouched(true);
            }
            if (sync.secretNamespaceMode) setSecretNamespaceMode(sync.secretNamespaceMode);
            if (sync.storageNamespace) {
                setStorageNamespace(sync.storageNamespace);
                setStorageNamespaceTouched(true);
            }
            if (sync.storageNamespaceMode) setStorageNamespaceMode(sync.storageNamespaceMode);
            if (sync.monitoringNamespace) {
                setMonitoringNamespace(sync.monitoringNamespace);
                setMonitoringNamespaceTouched(true);
            }
            if (sync.handoffNamespace) setHandoffNamespace(sync.handoffNamespace);
        }
        if (sync.planHash) setPlanHash(sync.planHash);
        if (sync.planVersion !== null) setPlanVersion(sync.planVersion);
        if (sync.planChanged) {
            setExecutionCompleted((current) => nextExecutionCompleted(current, currentPlanHash, sync.planHash));
            setExecutionToken(null);
            setOperationLedger({});
            setExecutionFailedKey(null);
            setRemediationScript('');
            setRemediationInfo(null);
            setHandoffInfo(null);
            if (clusterId) clearExecutionToken(clusterId);
        }
        return sync;
    }, []);

    // Resume a draft stored by a previous visit (refresh, tab close, or a wait
    // for the administrator). The draft id lives in localStorage, so a hard
    // navigation can bring the plan and any handoff back. The HF token itself
    // is never returned by GET APIs; the server reports `draftHfTokenSaved` so
    // the wizard knows whether an encrypted draft token is already stored.
    const resumeGateRef = useRef(null);
    if (!resumeGateRef.current) resumeGateRef.current = createResumeGate();
    useEffect(() => {
        const draftId = loadResumeDraftId();
        if (!draftId) return undefined;
        const loadId = resumeGateRef.current.begin();
        const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted && resumeGateRef.current.isCurrent(loadId);
        setResumeBusy(true);
        setResumeError('');
        getCluster(draftId, { signal: controller.signal })
            .then((detail) => {
                if (!isCurrent()) return;
                const resumedCluster = detail?.cluster || null;
                if (!resumedCluster?.id) {
                    clearResumeState();
                    return;
                }
                setCluster(resumedCluster);
                setName(resumedCluster.name || '');
                setDescription(resumedCluster.description || '');
                const resumedFields = planToWizardFields(detail?.plan);
                applyWizardFields(resumedFields);
                if (resumedFields.vllmImage === undefined && resumedCluster.vllmImage) {
                    setVllmImage(resumedCluster.vllmImage);
                }
                setHfTokenSaved(Boolean(detail?.draftHfTokenSaved));
                setHfToken('');
                setInlineToken('');
                setInlineTokenError('');
                // Restore the saved proxy; the default "auto" must not overwrite it.
                const proxyFields = proxyFieldsFromCluster(resumedCluster);
                setProxyMode(proxyFields.proxyMode);
                setHttpProxy(proxyFields.httpProxy);
                setHttpsProxy(proxyFields.httpsProxy);
                setNoProxy(proxyFields.noProxy);
                setPlan(detail?.plan || null);
                setPlanHash(detail?.planHash || null);
                setPlanVersion(detail?.planVersion ?? null);
                const resumedFinished = resumedCluster.draft === false;
                setFinished(resumedFinished);
                // Resume the operation ledger so a refresh mid-run continues
                // at the first incomplete user operation instead of replaying
                // completed work.
                const resumedLedger = detail?.executionOperations || {};
                setOperationLedger(resumedLedger);
                const completedForPlan = executionCompletedForPlan(detail);
                setExecutionCompleted(completedForPlan || resumedFinished);
                setFinishStatus([]);
                const resumedToken = resumedFinished || completedForPlan
                    ? null
                    : loadExecutionToken(resumedCluster.id);
                setExecutionToken(resumedToken);
                const resumeStep = resumeStepForPlan(detail?.plan, {
                    hasCluster: true,
                    finished: resumedFinished,
                    lastStep: loadResumeStep(),
                });
                const resumeIndex = WIZARD_STEP_IDS.indexOf(resumeStep);
                setStepIndex(resumeIndex >= 0 ? resumeIndex : 0);
                saveResumeDraftId(resumedCluster.id);
                saveResumeStep(resumeStep);
                loadClusterKubernetesVersion(resumedCluster.id)
                    .then((check) => {
                        if (!isCurrent()) return;
                        setK8sCheck(check);
                        setK8sWarning(check?.reason === 'forbidden' ? versionCheckMessage(check) : '');
                    })
                    .catch(() => {});
                if (shouldAutoCheckResumedPlan({ hasPlan: Boolean(detail?.plan), finished: resumedFinished, resumeStep })) {
                    setPermissionBusy(true);
                    setPermissionError('');
                    permissionCheck(resumedCluster.id)
                        .then(async (report) => {
                            if (!isCurrent()) return;
                            const sync = adoptPermissionCheckPlan(report, resumedCluster.id, detail?.planHash || null);
                            const effectiveLedger = sync.planChanged ? {} : resumedLedger;
                            const effectiveToken = sync.planChanged ? null : resumedToken;
                            setPermissionReport(report);
                            setFinishStatus(operationProgressForLedger(report, effectiveLedger));
                            if (shouldLoadHandoff(report)) {
                                let status = null;
                                try {
                                    status = await adminHandoffStatus(resumedCluster.id);
                                    if (!isCurrent()) return;
                                    setHandoffInfo(status || null);
                                } catch (statusError) {
                                    if (!isCurrent()) return;
                                    setHandoffError(errorMessage(statusError, 'Could not load the Orchestration administrator handoff'));
                                }
                                if (!adminVerificationReady(status)) {
                                    if (status?.status !== 'ready' && (!status || (status.adminOperations || []).length > 0)) {
                                        try {
                                            const remediation = await permissionRemediation(resumedCluster.id);
                                            if (!isCurrent()) return;
                                            setRemediationScript(remediation?.script || '');
                                            setRemediationInfo(remediation || null);
                                        } catch (remediationError) {
                                            if (!isCurrent()) return;
                                            if (status) {
                                                setHandoffError(errorMessage(remediationError, 'Could not generate the Orchestration administrator script'));
                                            }
                                        }
                                    }
                                }
                                if (shouldAutoVerifyHandoff(status, { hasToken: Boolean(effectiveToken), ledger: effectiveLedger, force: true })) {
                                    try {
                                        const verified = await verifyAdminHandoff(resumedCluster.id);
                                        if (!isCurrent()) return;
                                        setHandoffInfo(verified.body || status);
                                        setHandoffError('');
                                        setExecutionBlocked(false);
                                        const freshLedger = await refreshOperationLedger(resumedCluster.id, {
                                            reportPlanHash: report?.planHash || null,
                                            currentPlanHash: sync.planHash || detail?.planHash || null,
                                            isCurrent,
                                        });
                                        if (!isCurrent()) return;
                                        setExecutionToken(verified.token || null);
                                        setFinishStatus(operationProgressForLedger(report, freshLedger));
                                    } catch (verifyError) {
                                        if (!isCurrent()) return;
                                        const action = verificationFailureAction(verifyError);
                                        if (action.blocked) {
                                            setExecutionBlocked(true);
                                            setHandoffError('Another execution run is active for this cluster. Wait for it to finish or cancel it.');
                                        } else {
                                            if (verifyError?.code === 'execution_token_invalid') {
                                                setExecutionToken(null);
                                                clearExecutionToken(resumedCluster.id);
                                            }
                                            if (action.refreshHandoff) {
                                                setHandoffInfo(handoffFallbackFromVerifyError(
                                                    verifyError,
                                                    status,
                                                    permissionDetails(verifyError),
                                                ));
                                                setHandoffError(errorMessage(verifyError, 'Could not verify the Orchestration administrator handoff'));
                                                const freshStatus = await adminHandoffStatus(resumedCluster.id).catch(() => null);
                                                if (!isCurrent()) return;
                                                if (freshStatus) setHandoffInfo(freshStatus);
                                            } else {
                                                setHandoffInfo(null);
                                                setHandoffError(errorMessage(verifyError, 'Could not verify the Orchestration administrator handoff'));
                                            }
                                        }
                                    }
                                }
                            }
                        })
                        .catch((nextError) => {
                            if (isCurrent()) setPermissionError(errorMessage(nextError, 'Permission check failed'));
                        })
                        .finally(() => {
                            if (resumeGateRef.current.isCurrent(loadId)) setPermissionBusy(false);
                        });
                }
            })
            .catch((nextError) => {
                if (!isCurrent()) return;
                // A missing/forbidden draft can be forgotten, but a transient
                // network/5xx error must keep the key so the user can retry.
                if (shouldClearResumeOnLoadError(nextError)) clearResumeState();
                else setResumeError(errorMessage(nextError, 'Could not resume the saved draft. Retry.'));
            })
            .finally(() => {
                if (resumeGateRef.current.isCurrent(loadId)) setResumeBusy(false);
            });
        return () => {
            controller.abort();
            if (resumeGateRef.current.isCurrent(loadId)) {
                setResumeBusy(false);
                setPermissionBusy(false);
            }
        };
        // Resume runs once per attempt. Auto-verify uses explicit cluster ids
        // and must not restart when those callbacks are recreated.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [applyWizardFields, resumeAttempt]);

    // Keep the live execution token across a page refresh in this tab so a
    // mid-run reload can resume instead of restarting from the first step.
    useEffect(() => {
        if (!cluster?.id) return;
        if (executionToken) saveExecutionToken(cluster.id, executionToken);
        else clearExecutionToken(cluster.id);
    }, [cluster?.id, executionToken]);

    const loadRemediation = async (inline = null) => {
        setHandoffError('');
        if (inline?.script) {
            setRemediationScript(inline.script);
            setRemediationInfo(inline);
            return;
        }
        if (!cluster?.id) return;
        setHandoffBusy(true);
        try {
            const response = await permissionRemediation(cluster.id);
            setRemediationScript(response?.script || '');
            setRemediationInfo(response || null);
        } catch (nextError) {
            setHandoffError(errorMessage(nextError, 'Could not generate the Orchestration administrator script'));
        } finally {
            setHandoffBusy(false);
        }
    };

    const refreshOperationLedger = useCallback(async (
        clusterId = cluster?.id,
        { reportPlanHash = null, currentPlanHash, isCurrent } = {},
    ) => {
        if (!clusterId) return {};
        const detail = await getCluster(clusterId).catch(() => null);
        if (isCurrent && !isCurrent()) return {};
        const sync = clusterDetailSyncForReport(detail, {
            reportPlanHash,
            currentPlanHash: currentPlanHash !== undefined ? currentPlanHash : planHash,
        });
        setOperationLedger(sync.ledger);
        if (sync.draftHfTokenSaved !== null) {
            setHfTokenSaved(sync.draftHfTokenSaved);
        }
        if (sync.alignPlan) {
            if (sync.plan) {
                setPlan(sync.plan);
                if (sync.secretNamespace) {
                    setSecretNamespace(sync.secretNamespace);
                    setSecretNamespaceTouched(true);
                }
                if (sync.secretNamespaceMode) setSecretNamespaceMode(sync.secretNamespaceMode);
                if (sync.storageNamespace) {
                    setStorageNamespace(sync.storageNamespace);
                    setStorageNamespaceTouched(true);
                }
                if (sync.storageNamespaceMode) setStorageNamespaceMode(sync.storageNamespaceMode);
                if (sync.monitoringNamespace) {
                    setMonitoringNamespace(sync.monitoringNamespace);
                    setMonitoringNamespaceTouched(true);
                }
                if (sync.handoffNamespace) setHandoffNamespace(sync.handoffNamespace);
            }
            setPlanHash(sync.planHash);
            if (sync.planVersion !== null) setPlanVersion(sync.planVersion);
        }
        return sync.ledger;
    }, [cluster?.id, planHash]);

    const loadHandoff = useCallback(async (
        report,
        clusterId = cluster?.id,
        {
            autoVerify = true,
            forceVerify = false,
            manualRecheck = false,
            preserveError = false,
            ledger,
            tokenOverride,
        } = {},
    ) => {
        if (!clusterId || !shouldLoadHandoff(report)) return;
        setHandoffBusy(true);
        if (!preserveError) setHandoffError('');
        setHandoffWarning('');
        try {
            let status = null;
            try {
                status = await adminHandoffStatus(clusterId);
                setHandoffInfo(status || null);
            } catch (statusError) {
                setHandoffInfo(null);
                setHandoffError(errorMessage(statusError, 'Could not load the Orchestration administrator handoff'));
            }
            if (!adminVerificationReady(status)) {
                let remediationFailed = false;
                if (status?.status !== 'ready' && (!status || (status.adminOperations || []).length > 0)) {
                    try {
                        const remediation = await permissionRemediation(clusterId);
                        setRemediationScript(remediation?.script || '');
                        setRemediationInfo(remediation || null);
                    } catch (remediationError) {
                        remediationFailed = true;
                        if (status) {
                            setHandoffError(errorMessage(remediationError, 'Could not generate the Orchestration administrator script'));
                        }
                    }
                }
                if (manualRecheck && !remediationFailed && status && (status.status === 'missing' || status.status === 'unknown')) {
                    setHandoffWarning('Orchestration administrator completion marker not found yet. Once your Orchestration administrator finishes running the script, click Re-check again.');
                }
                return;
            }
            const currentToken = tokenOverride !== undefined ? tokenOverride : executionToken;
            const currentLedger = ledger ?? operationLedger;
            const shouldVerify = (autoVerify || forceVerify)
                && shouldAutoVerifyHandoff(status, {
                    hasToken: Boolean(currentToken),
                    ledger: currentLedger,
                    force: forceVerify,
                });
            if (shouldVerify) {
                try {
                    const verified = await verifyAdminHandoff(clusterId);
                    const verifiedBody = verified.body || status;
                    setHandoffInfo(verifiedBody);
                    if (!preserveError) setHandoffError('');
                    setHandoffWarning('');
                    setExecutionBlocked(false);
                    const verifiedAdminIds = (verifiedBody?.adminOperations || [])
                        .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
                        .filter(Boolean);
                    const needsLedgerRefresh = verifyRefreshesOperationLedger(currentToken, verified.token)
                        || verifiedAdminIds.some((id) => currentLedger?.[id] !== 'admin_done')
                        || !hasHfTokenForRun
                        || Boolean(report?.planHash && report.planHash !== planHash);
                    const freshLedger = needsLedgerRefresh
                        ? await refreshOperationLedger(clusterId, { reportPlanHash: report?.planHash || null })
                        : currentLedger;
                    setExecutionToken(verified.token || null);
                    if (report) setFinishStatus(operationProgressForLedger(report, freshLedger));
                } catch (verifyError) {
                    const action = verificationFailureAction(verifyError);
                    if (action.blocked) {
                        setExecutionBlocked(true);
                        setHandoffError('Another execution run is active for this cluster. Wait for it to finish or cancel it.');
                        return;
                    }
                    if (verifyError?.code === 'execution_token_invalid') {
                        setExecutionToken(null);
                        clearExecutionToken(clusterId);
                    }
                    if (action.refreshHandoff) {
                        setHandoffInfo(handoffFallbackFromVerifyError(
                            verifyError,
                            status,
                            permissionDetails(verifyError),
                        ));
                        setHandoffError(errorMessage(verifyError, 'Could not verify the Orchestration administrator handoff'));
                        const freshStatus = await adminHandoffStatus(clusterId).catch(() => null);
                        if (freshStatus) setHandoffInfo(freshStatus);
                    } else {
                        setHandoffInfo(null);
                        setHandoffError(errorMessage(verifyError, 'Could not verify the Orchestration administrator handoff'));
                    }
                }
            } else if (!hasHfTokenForRun || Boolean(report?.planHash && report.planHash !== planHash)) {
                const freshLedger = await refreshOperationLedger(clusterId, { reportPlanHash: report?.planHash || null });
                if (report) setFinishStatus(operationProgressForLedger(report, freshLedger));
            }
        } finally {
            setHandoffBusy(false);
        }
    }, [cluster?.id, executionToken, hasHfTokenForRun, operationLedger, planHash, refreshOperationLedger]);

    const applyPermissionError = async (nextError, clusterId = cluster?.id) => {
        const details = permissionDetails(nextError);
        const tokenFromError = nextError?.executionToken;
        if (tokenFromError) setExecutionToken(tokenFromError);
        const effectiveToken = tokenFromError ?? executionToken;
        setPermissionError('');
        setHandoffWarning('');
        if (nextError?.code === 'operation_blocked') {
            const blockedReport = {
                ...(permissionReport || {}),
                status: 'blocked',
                sufficient: false,
                planHash: details.planHash || permissionReport?.planHash || null,
                adminOperations: details.adminOperations.length
                    ? details.adminOperations
                    : permissionReport?.adminOperations || [],
                blockedOperations: details.blockedOperations.length
                    ? details.blockedOperations
                    : [{ id: details.operationId, executor: 'user' }],
                missing: details.missing,
            };
            setPermissionReport(blockedReport);
            setHandoffError(errorMessage(nextError, 'Fix the user-owned access before retrying'));
            if (shouldLoadHandoff(blockedReport)) {
                await loadHandoff(blockedReport, clusterId, { tokenOverride: effectiveToken, preserveError: true });
            } else {
                setHandoffInfo(null);
                setRemediationScript('');
                setRemediationInfo(null);
            }
            return blockedReport;
        }
        setHandoffError(errorMessage(nextError, 'The plan check changed'));
        if (!clusterId) return null;
        try {
            const report = await permissionCheck(clusterId);
            const sync = adoptPermissionCheckPlan(report, clusterId, planHash);
            const effectiveTokenAfterSync = sync.planChanged ? null : effectiveToken;
            setPermissionReport(report);
            const freshLedger = sync.planChanged
                ? {}
                : await refreshOperationLedger(clusterId, {
                    reportPlanHash: report?.planHash || null,
                    currentPlanHash: sync.planHash || planHash,
                });
            setFinishStatus(operationProgressForLedger(report, freshLedger));
            if (shouldLoadHandoff(report)) {
                await loadHandoff(report, clusterId, {
                    tokenOverride: effectiveTokenAfterSync,
                    ledger: freshLedger,
                    preserveError: true,
                });
            } else {
                setHandoffInfo(null);
                setRemediationScript('');
                setRemediationInfo(null);
            }
            return report;
        } catch {
            setPermissionReport(null);
            setRemediationScript('');
            setRemediationInfo(null);
            setHandoffInfo(null);
            setHandoffError('');
            setHandoffWarning('');
            setPermissionError(errorMessage(nextError, 'Permission check failed. No current report is available; retry the check.'));
            return null;
        }
    };

    const runPermissionCheck = async ({
        clusterId = cluster?.id,
        ledgerOverride,
        tokenOverride,
        autoVerify = true,
        forceVerify = false,
        manualRecheck = false,
    } = {}) => {
        if (!clusterId) return null;
        setPermissionBusy(true);
        setPermissionError('');
        setHandoffWarning('');
        try {
            const report = await permissionCheck(clusterId);
            const sync = adoptPermissionCheckPlan(report, clusterId, planHash);
            const effectiveLedger = sync.planChanged ? {} : (ledgerOverride ?? operationLedger);
            const effectiveToken = sync.planChanged ? null : tokenOverride;
            setPermissionReport(report);
            setFinishStatus(operationProgressForLedger(report, effectiveLedger));
            if (shouldLoadHandoff(report)) {
                await loadHandoff(report, clusterId, {
                    autoVerify,
                    forceVerify,
                    manualRecheck,
                    ledger: effectiveLedger,
                    tokenOverride: effectiveToken,
                });
            } else {
                setRemediationScript('');
                setRemediationInfo(null);
                setHandoffInfo(null);
                setHandoffError('');
                setHandoffWarning('');
                if (!hasHfTokenForRun) {
                    const freshLedger = await refreshOperationLedger(clusterId, {
                        reportPlanHash: report?.planHash || null,
                        currentPlanHash: sync.planHash || planHash,
                    });
                    setFinishStatus(operationProgressForLedger(report, freshLedger));
                }
            }
            return report;
        } catch (nextError) {
            if (isPermissionError(nextError)) return applyPermissionError(nextError, clusterId);
            setPermissionReport(null);
            setRemediationScript('');
            setRemediationInfo(null);
            setHandoffInfo(null);
            setHandoffError('');
            setHandoffWarning('');
            setPermissionError(errorMessage(nextError, 'Permission check failed. No current report is available; retry the check.'));
            return null;
        } finally {
            setPermissionBusy(false);
        }
    };

    const recheckPermissions = () => {
        setError('');
        setExecutionFailedKey(null);
        return runPermissionCheck({ forceVerify: true, manualRecheck: Boolean(permissionReport) });
    };

    const enterExecuteStep = () => {
        setStepIndex(EXECUTE_STEP_INDEX);
        saveResumeStep(WIZARD_STEP_IDS[EXECUTE_STEP_INDEX]);
    };

    const runPreflight = async () => {
        if (!canPreflight) return null;
        setError('');
        setNotice('');
        enterExecuteStep();
        return runPermissionCheck({ forceVerify: true });
    };

    // Save the current plan. A failed save keeps the wizard on the current
    // step; a successful save stores the new hashes and invalidates the report.
    const savePlan = async () => {
        const nextPlan = planFromWizardState(wizardState);
        const response = await putPlan(cluster.id, nextPlan, { ifMatch: planHash || undefined });
        const savedPlan = response.plan || nextPlan;
        setPlan(savedPlan);
        // Adopt the backend-normalized effective gateway coordinates so later
        // saves and the Review view never fall back to the raw default.
        if (savedPlan.gateway?.namespace) setGatewayNamespace(savedPlan.gateway.namespace);
        if (savedPlan.gateway?.name) setGatewayName(savedPlan.gateway.name);
        if (savedPlan.hfTokenSecret?.secretNamespace) {
            setSecretNamespace(savedPlan.hfTokenSecret.secretNamespace);
            setSecretNamespaceTouched(true);
        }
        if (savedPlan.hfTokenSecret?.secretNamespaceMode) setSecretNamespaceMode(savedPlan.hfTokenSecret.secretNamespaceMode);
        if (savedPlan.storage?.kind && savedPlan.storage.kind !== 'none') {
            if (savedPlan.storage.namespace) {
                setStorageNamespace(savedPlan.storage.namespace);
                setStorageNamespaceTouched(true);
            }
            if (savedPlan.storage.namespaceMode) setStorageNamespaceMode(savedPlan.storage.namespaceMode);
        }
        if (savedPlan.handoff?.namespace) setHandoffNamespace(savedPlan.handoff.namespace);
        if (savedPlan.stack?.routerVersion) setRouterVersion(savedPlan.stack.routerVersion);
        if (savedPlan.stack?.gieVersion) setGieVersion(savedPlan.stack.gieVersion);
        if (savedPlan.stack?.ippVersion) setIppVersion(savedPlan.stack.ippVersion);
        if (savedPlan.monitoring?.namespace) {
            setMonitoringNamespace(savedPlan.monitoring.namespace);
            setMonitoringNamespaceTouched(true);
        }
        const nextPlanHash = response.planHash || null;
        const planChanged = planInvalidatesRun(planHash, nextPlanHash);
        setPlanHash(nextPlanHash);
        setPlanVersion(response.planVersion ?? null);
        setPermissionReport(null);
        setPermissionError('');
        setRemediationScript('');
        setRemediationInfo(null);
        setHandoffInfo(null);
        setHandoffError('');
        setHandoffWarning('');
        setExecutionBlocked(false);
        if (planChanged) {
            // Only a changed plan invalidates the live token/ledger. Saving
            // unchanged configuration must not lose a verified handoff token.
            setExecutionCompleted((current) => nextExecutionCompleted(current, planHash, nextPlanHash));
            setExecutionToken(null);
            setOperationLedger({});
            setExecutionFailedKey(null);
            setFinishStatus([]);
            clearExecutionToken(cluster.id);
        }
        return response;
    };

    const handleSaveInlineToken = async () => {
        const trimmed = inlineToken.trim();
        if (!cluster?.id || !trimmed || inlineTokenBusy) return;
        setInlineTokenBusy(true);
        setInlineTokenError('');
        try {
            await saveDraftHfToken(cluster.id, trimmed, { executionToken });
            setHfTokenSaved(true);
            setInlineToken('');
            setError('');
        } catch (nextError) {
            if (nextError?.code === 'execution_in_progress') {
                setExecutionBlocked(true);
            }
            setInlineTokenError(errorMessage(nextError, 'Could not save the Hugging Face token'));
        } finally {
            setInlineTokenBusy(false);
        }
    };

    // A draft whose uploaded kubeconfig cannot be used is deleted (best
    // effort) and its resume key is cleared, so a later Next re-uploads and
    // re-checks instead of silently reusing the unusable draft.
    const discardUnusableDraft = async (draftId) => {
        if (draftId) {
            try {
                await requestJson(`/api/cluster/clusters/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
            } catch {
                // The resume key still prevents reuse when the delete fails.
            }
        }
        clearResumeState();
        setCluster(null);
        setK8sCheck(null);
        setFile(null);
        setSecretNamespace('llm-d-bench-storage');
        setSecretNamespaceMode('');
        setSecretNamespaceTouched(false);
        setStorageNamespace('');
        setStorageNamespaceMode('');
        setStorageNamespaceTouched(false);
        setMonitoringNamespace('');
        setMonitoringNamespaceTouched(false);
        setVllmImage('');
        setHandoffNamespace('');
        setHfToken('');
        setHfTokenSaved(false);
        setInlineToken('');
        setInlineTokenError('');
        setKubeconfigInputKey((current) => current + 1);
    };

    const goNext = async () => {
        setError('');
        if (busy) return;
        if (stepIndex === 0) {
            if (!canGoNext) return;
            // A resumed draft already exists; do not create a second one.
            if (cluster) {
                setStepIndex(1);
                saveResumeStep(WIZARD_STEP_IDS[1]);
                return;
            }
            setBusy(true);
            let created = null;
            try {
                const body = new FormData();
                body.append('name', name.trim());
                body.append('description', description.trim());
                body.append('file', file);
                // Created as a draft: hidden from the main cluster list and
                // excluded from the "has deployments/storage" delete guards
                // until Execute finalizes it.
                body.append('draft', 'true');
                const payload = await requestJson('/api/cluster/clusters', { method: 'POST', body });
                created = payload.cluster;
                setCluster(created);
                saveResumeDraftId(created.id);
                // Verify the uploaded kubeconfig reaches the cluster and its
                // Kubernetes version meets the stack minimum before continuing.
                // A `forbidden` version read is a warning: the plan-scoped
                // permission check covers the missing access later.
                const check = await loadClusterKubernetesVersion(created.id);
                setK8sCheck(check);
                if (versionCheckBlocks(check)) {
                    await discardUnusableDraft(created.id);
                    setK8sWarning('');
                    setError(versionCheckMessage(check));
                    return;
                }
                setK8sWarning(check?.reason === 'forbidden' ? versionCheckMessage(check) : '');
                setStepIndex(1);
                saveResumeStep(WIZARD_STEP_IDS[1]);
            } catch (nextError) {
                if (created?.id) await discardUnusableDraft(created.id);
                setK8sWarning('');
                setError(errorMessage(nextError, 'Could not create the cluster draft'));
            } finally {
                setBusy(false);
            }
            return;
        }
        if (stepIndex >= 1 && stepIndex <= 6) {
            if (!canGoNext) return;
            setBusy(true);
            try {
                if (stepIndex === 1) {
                    // Proxy is not part of the plan; save it through PATCH.
                    const payload = await request(`/api/cluster/clusters/${encodeURIComponent(cluster.id)}`, {
                        method: 'PATCH',
                        body: JSON.stringify({
                            proxy:
                                proxyMode === 'custom'
                                    ? { mode: 'custom', httpProxy: httpProxy.trim() || null, httpsProxy: httpsProxy.trim() || null, noProxy: noProxy.trim() || null }
                                    : { mode: 'auto' },
                        }),
                    });
                    setCluster(payload.cluster);
                }
                if (stepIndex === 4) {
                    // Lens-local source download; the CRD/prepull/LWS cluster
                    // operations moved to Execute.
                    setVersionsDownloading(true);
                    setVersionsDownloadStatus(null);
                    const nextCluster = await downloadClusterSoftware(cluster, { onUpdate: setVersionsDownloadStatus });
                    setCluster(nextCluster);
                }
                if (stepIndex === 5) {
                    const trimmedToken = hfToken.trim();
                    if (trimmedToken) {
                        await saveDraftHfToken(cluster.id, trimmedToken, { executionToken });
                        setHfTokenSaved(true);
                        setHfToken('');
                        setInlineToken('');
                        setInlineTokenError('');
                    }
                }
                await savePlan();
                if (stepIndex === 6) {
                    setStepIndex(REVIEW_STEP_INDEX);
                    saveResumeStep(WIZARD_STEP_IDS[REVIEW_STEP_INDEX]);
                } else {
                    setStepIndex(stepIndex + 1);
                    saveResumeStep(WIZARD_STEP_IDS[stepIndex + 1]);
                }
            } catch (nextError) {
                if (nextError?.code === 'execution_in_progress') {
                    setExecutionBlocked(true);
                    setError('Another execution run is active for this cluster, so the plan cannot be changed. Wait for it to finish or cancel it.');
                } else {
                    setError(errorMessage(nextError, 'Could not save the plan'));
                }
            } finally {
                setVersionsDownloading(false);
                setBusy(false);
            }
        }
    };

    const goBack = () => {
        setError('');
        if (stepIndex > 0) {
            setStepIndex(stepIndex - 1);
            saveResumeStep(WIZARD_STEP_IDS[stepIndex - 1]);
        }
    };

    const cancelRequestedRef = useRef(false);

    // Execute the user operations in dependency order, then let
    // execution/complete run the Lens operations and finalize the draft.
    const runExecution = async ({ resume = false } = {}) => {
        if (finishing || finished || !cluster?.id || !plan || !permissionReport) return;
        if (permissionBlocked) {
            setError('Fix the user-owned access listed in the handoff before executing.');
            return;
        }
        if (adminRequired && !adminVerified) {
            setError('Click Re-check to verify the Orchestration administrator completion marker before running user operations.');
            return;
        }
        if (handoffBusy || resumeBusy) return;
        if (!resume && !canExecute) return;

        setFinishing(true);
        setError('');
        setPermissionError('');
        setNotice('');
        setExecutionFailedKey(null);
        cancelRequestedRef.current = false;

        let token = executionToken;
        let refreshedLedger = null;
        if (adminRequired && adminVerified && !token) {
            try {
                const verified = await verifyAdminHandoff(cluster.id);
                token = verified.token || verified.body?.token || null;
                setHandoffInfo(verified.body || handoffInfo);
                if (token) {
                    refreshedLedger = await refreshOperationLedger(cluster.id, { reportPlanHash: permissionReport?.planHash || null });
                    setExecutionToken(token);
                } else {
                    setError('Orchestration administrator verification did not return an execution token. Click Re-check and try again.');
                    setFinishing(false);
                    return;
                }
            } catch (nextError) {
                if (verificationBlocksRun(nextError)) {
                    setExecutionBlocked(true);
                    setError('Another execution run is active for this cluster. Wait for it to finish or cancel it.');
                } else {
                    setError(errorMessage(nextError, 'Click Re-check to verify the Orchestration administrator handoff and acquire an execution token'));
                }
                setFinishing(false);
                return;
            }
        }
        if (!token) {
            // A new run starts from a clean ledger; the backend acquire will
            // clear its ledger as well.
            setOperationLedger({});
        }
        const report = permissionReport;
        const operations = report.userOperations || [];
        let ledger = refreshedLedger ?? operationLedgerForRun(operationLedger, { hasToken: Boolean(token) });
        let statuses = operationProgressForLedger(report, ledger);
        setFinishStatus(statuses);
        const setStepState = (key, state, detail) =>
            setFinishStatus((current) => current.map((item) => (item.key === key ? { ...item, state, detail } : item)));

        try {
            for (const operation of operations) {
                if (operationDone(ledger, operation.id)) continue;
                if (cancelRequestedRef.current) {
                    setNotice('Execution run cancelled.');
                    setFinishStatus([]);
                    return;
                }
                setStepState(operation.id, 'running');
                const secretValues = secretValuesFor(operation, hfToken, { hfTokenSaved });
                if (secretValues) {
                    const missing = Object.entries(secretValues).filter(([, value]) => !value).map(([field]) => field);
                    if (missing.length) {
                        throw new Error(`Enter ${missing.join(', ')} before executing ${operation.title || operation.id}.`);
                    }
                }
                let result;
                try {
                    result = await executeOperation(cluster.id, operation.id, {
                        planHash,
                        token,
                        secretValues,
                    });
                } catch (stepError) {
                    token = stepError?.executionToken || token;
                    if (token) setExecutionToken(token);
                    const action = executionFailureAction(stepError);
                    if (action.blocked) {
                        setExecutionBlocked(true);
                        setError('Another execution run is active for this cluster. Wait for it to finish or cancel it.');
                        return;
                    }
                    if (action.markFailed) {
                        ledger = { ...ledger, [operation.id]: 'failed' };
                        setOperationLedger(ledger);
                        setExecutionFailedKey(operation.id);
                        setStepState(operation.id, 'failed', errorMessage(stepError));
                    }
                    if (action.clearRun) {
                        setExecutionToken(null);
                        setOperationLedger({});
                        clearExecutionToken(cluster.id);
                    }
                    if (action.reason === 'secret_required') {
                        setHfTokenSaved(false);
                    }
                    if (action.reclass) {
                        await applyPermissionError(stepError);
                    } else if (action.reloadLedger) {
                        await refreshOperationLedger(cluster.id, { reportPlanHash: permissionReport?.planHash || null });
                    } else if (action.refreshSplit) {
                        await runPermissionCheck({ ledgerOverride: {}, tokenOverride: null });
                    }
                    if (action.reason === 'unauthorized') {
                        setError('The kubeconfig credentials are invalid or expired. Update the cluster credential and run the check again.');
                    } else if (action.reason === 'secret_required') {
                        setError('The Hugging Face token is missing or could not be read for this draft. Save a token below, then click Resume.');
                    } else if (action.reason === 'wait') {
                        setError(
                            adminRequired
                                ? 'The operation was applied but did not become ready. Click Re-check and retry after the cluster resources settle.'
                                : 'The operation was applied but did not become ready. Retry after the cluster resources settle.',
                        );
                    } else if (action.reason === 'token') {
                        setError(
                            adminRequired
                                ? 'The execution run expired or was replaced. Click Re-check, then execute.'
                                : 'The execution run expired or was replaced. Restart execution.',
                        );
                    } else if (action.reason === 'stale') {
                        setError('The plan changed. Review the new operations before executing.');
                    } else if (action.reason === 'failed') {
                        setError(errorMessage(stepError, 'The user operation failed'));
                    }
                    return;
                }
                token = result?.token || token;
                if (token) setExecutionToken(token);
                ledger = { ...ledger, [operation.id]: 'user_done' };
                setOperationLedger(ledger);
                statuses = statuses.map((item) => (item.key === operation.id ? { ...item, state: 'done' } : item));
                setFinishStatus(statuses);
            }

            await completeExecution(cluster.id, { planHash, token });
            setExecutionToken(null);
            clearExecutionToken(cluster.id);
            const detail = await getCluster(cluster.id);
            setCluster(detail?.cluster || cluster);
            setOperationLedger(detail?.executionOperations || ledger);
            setHfToken('');
            setHfTokenSaved(false);
            setInlineToken('');
            setInlineTokenError('');
            setExecutionCompleted(true);
            setFinished(true);
            clearResumeState();
            onCreated?.(detail?.cluster || cluster);
        } catch (nextError) {
            const action = completeFailureAction(nextError);
            if (action.markFailed) {
                setExecutionFailedKey('complete');
            }
            if (action.clearRun) {
                setExecutionToken(null);
                setOperationLedger({});
                clearExecutionToken(cluster.id);
            } else if (nextError?.executionToken) {
                setExecutionToken(nextError.executionToken);
            }
            if (action.reclass) {
                const refreshedReport = await applyPermissionError(nextError);
                if (!permissionPanelVisible(refreshedReport)) {
                    setError(errorMessage(nextError, 'Kubernetes denied permission while completing cluster setup.'));
                }
            } else if (action.refreshSplit) {
                await runPermissionCheck({ ledgerOverride: {}, tokenOverride: null });
                setError('The plan changed. Review the new operations before executing.');
            } else if (action.reason === 'unauthorized') {
                setError('The kubeconfig credentials are invalid or expired. Update the cluster credential and run the check again.');
            } else if (action.reason === 'incomplete') {
                setError('The backend has not recorded every operation. Retry the incomplete operations, then complete again.');
            } else if (action.reason === 'lens_failed') {
                setError('A Lens operation did not finish. The execution token is still valid; retry Complete.');
            } else if (action.reason === 'monitoring_failed') {
                setError(errorMessage(nextError, 'Prometheus monitoring verification failed. Check connectivity and retry Complete.'));
            } else if (action.reason === 'token') {
                setError(
                    adminRequired
                        ? 'The execution run expired or was replaced. Click Re-check and restart execution.'
                        : 'The execution run expired or was replaced. Restart execution.',
                );
            } else {
                setError(errorMessage(nextError, 'Could not complete cluster setup'));
            }
        } finally {
            setFinishing(false);
        }
    };

    // Ask the backend to stop the active run, then drop the local token and
    // progress so the user can start over.
    const cancelRun = async () => {
        if (!cluster?.id || cancelling) return;
        setCancelling(true);
        setError('');
        try {
            await cancelExecution(cluster.id, { token: executionToken });
            cancelRequestedRef.current = true;
            clearExecutionToken(cluster.id);
            setExecutionToken(null);
            setOperationLedger({});
            setFinishStatus([]);
            setExecutionFailedKey(null);
            setExecutionBlocked(false);
            setHandoffError('');
            setNotice('Execution run cancelled. You can execute again now.');
        } catch (nextError) {
            if (nextError?.code === 'execution_not_running') {
                cancelRequestedRef.current = true;
                setExecutionToken(null);
                setOperationLedger({});
                setFinishStatus([]);
                setExecutionFailedKey(null);
                setExecutionBlocked(false);
                setHandoffError('');
                setNotice('No execution run is active. You can start Execute again.');
            } else {
                setError(errorMessage(nextError, 'Could not cancel the execution run'));
            }
        } finally {
            setCancelling(false);
        }
    };

    // "Close" keeps the draft so it can be resumed; only an explicit discard
    // deletes it.
    const handleClose = () => {
        onClose?.();
    };

    const handleDiscard = async () => {
        if (cluster && !finished) {
            try {
                await requestJson(`/api/cluster/clusters/${encodeURIComponent(cluster.id)}`, { method: 'DELETE' });
            } catch {
                // Best-effort: the user is closing anyway.
            }
        }
        setHfToken('');
        setHfTokenSaved(false);
        setInlineToken('');
        setInlineTokenError('');
        clearResumeState();
        onClose?.();
    };

    const canResume = executionFailedKey !== 'finalize_incomplete'
        && canResumeOperationRun({
            hasFailedOperation: Boolean(executionFailedKey),
            executionBlocked,
            cancelling,
            permissionsSufficient: !permissionBlocked && (permissionReady || adminVerified),
            permissionsFresh: !permissionReport?.planHash || permissionReport.planHash === planHash,
            hasSecretInput: hasHfTokenForRun,
            hasPermissionError: Boolean(permissionError),
            finishing,
            busy: permissionBusy || handoffBusy || resumeBusy,
        });
    const executeBlocker = executeDisabledReason({
        canExecute,
        finished,
        finishing,
        permissionBusy,
        handoffBusy,
        resumeBusy,
        executionBlocked,
        canResume,
        hasCluster: Boolean(cluster?.id),
        hasPlan: Boolean(plan),
        hasReport: Boolean(permissionReport),
        reportStatus: permissionReport?.status,
        hasPermissionError: Boolean(permissionError),
        permissionsFresh: !permissionReport?.planHash || permissionReport.planHash === planHash,
        hasHfToken: hasHfTokenForRun,
        adminVerified,
        hasToken: Boolean(executionToken),
        hasAdminOperations: Boolean((permissionReport?.adminOperations || []).length || (handoffInfo?.adminOperations || []).length),
    });
    const showSetupProgress = shouldShowSetupProgress({
        finishing,
        finished,
        executionFailedKey,
        operationLedger,
        hasExecutionToken: Boolean(executionToken),
    });

    if (dbStatus === null) {
        return (
            <Modal isOpen onClose={onClose} title="Add a Kubernetes cluster" size="lg">
                <div className="flex flex-col items-center gap-3 py-10 text-sm text-theme-muted">
                    {dbStatusError ? (
                        <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {dbStatusError}
                        </div>
                    ) : (
                        <>
                            <Spinner size="md" className="text-sky-600 dark:text-sky-400" />
                            Checking database configuration…
                        </>
                    )}
                </div>
            </Modal>
        );
    }

    if (!dbStatus.configured) {
        // The database is now configured once at install time by the online
        // installer (see llm_d_lens/db/bootstrap_cli.py) rather than lazily from
        // this wizard, so reaching this should only ever happen if the installer
        // was skipped or the bootstrap file was manually removed.
        return (
            <Modal isOpen onClose={onClose} title="Add a Kubernetes cluster" size="lg">
                <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    Prism's database is not configured yet. Re-run the Lens installer to set it up, then reopen this wizard.
                </div>
            </Modal>
        );
    }

    return (
        <Modal
            isOpen
            onClose={finishing ? undefined : handleClose}
            title="Add a Kubernetes cluster"
            subtitle={`Step ${stepIndex + 1} of ${STEPS.length} · ${STEPS[stepIndex].label}`}
            size="xl"
            variant="drawer"
            closeOnEscape={!finishing}
            footer={
                <>
                    <Button
                        variant="outline"
                        onClick={handleClose}
                        disabled={finishing}
                        title={cluster && !finished ? 'The draft and its saved plan are kept so you can resume later.' : undefined}
                    >
                        {cluster && !finished ? 'Close' : 'Cancel'}
                    </Button>
                    {cluster && !finished && (
                        <Button variant="dangerOutline" onClick={handleDiscard} disabled={finishing}>Discard</Button>
                    )}
                    {stepIndex > 0 && stepIndex < REVIEW_STEP_INDEX && (
                        <Button variant="outline" onClick={goBack} disabled={busy || finishing || executionBlocked}>Back</Button>
                    )}
                    {stepIndex === REVIEW_STEP_INDEX && !finishing && (
                        <Button variant="outline" onClick={() => { setError(''); setStepIndex(6); saveResumeStep(WIZARD_STEP_IDS[6]); }} disabled={busy || executionBlocked}>Back</Button>
                    )}
                    {stepIndex === EXECUTE_STEP_INDEX && !finished && (
                        <Button
                            variant="outline"
                            onClick={() => { setError(''); setStepIndex(REVIEW_STEP_INDEX); saveResumeStep(WIZARD_STEP_IDS[REVIEW_STEP_INDEX]); }}
                            disabled={!canGoBackFromExecute}
                        >
                            Back
                        </Button>
                    )}
                    {stepIndex < REVIEW_STEP_INDEX && (
                        <Button variant="sky" onClick={goNext} isLoading={busy} disabled={!canGoNext || executionBlocked}>
                            {stepIndex === 6 ? 'Review' : 'Next'} <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                    )}
                    {stepIndex === REVIEW_STEP_INDEX && !finished && (
                        <Button
                            variant="sky"
                            onClick={runPreflight}
                            disabled={!canPreflight}
                        >
                            <ListChecks className="h-3.5 w-3.5" /> Preflight
                        </Button>
                    )}
                    {stepIndex === EXECUTE_STEP_INDEX && finished && (
                        <Button variant="sky" onClick={handleClose}>
                            <Check className="h-3.5 w-3.5" /> Done
                        </Button>
                    )}
                    {!finished && (finishing || executionBlocked) && (
                        <Button variant="dangerOutline" onClick={cancelRun} isLoading={cancelling} disabled={cancelling}>
                            <AlertTriangle className="h-3.5 w-3.5" /> Cancel run
                        </Button>
                    )}
                    {stepIndex === EXECUTE_STEP_INDEX && !finished && canResume && (
                        <Button variant="sky" onClick={() => runExecution({ resume: true })} isLoading={finishing} disabled={!canResume}>
                            <Rocket className="h-3.5 w-3.5" /> Resume
                        </Button>
                    )}
                    {stepIndex === EXECUTE_STEP_INDEX && !finished && !finishing && !canResume && !executionBlocked && (
                        <Button variant="sky" onClick={() => runExecution()} disabled={!canExecute}>
                            <Rocket className="h-3.5 w-3.5" /> Execute
                        </Button>
                    )}
                </>
            }
        >
            <div className="mx-auto max-w-4xl space-y-6">
                {resumeBusy && (
                    <p className="flex items-center gap-2 text-xs text-theme-muted">
                        <Spinner size="xs" /> Resuming saved draft…
                    </p>
                )}
                {resumeError && (
                    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1">{resumeError}</span>
                        <Button variant="outline" size="sm" onClick={() => setResumeAttempt((current) => current + 1)} disabled={resumeBusy}>
                            Retry
                        </Button>
                    </div>
                )}
                <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${STEPS.length}, minmax(0, 1fr))` }} aria-label="Cluster creation progress">
                    {STEPS.map((step, index) => (
                        <li key={step.id} className="min-w-0">
                            <div className={`h-1.5 rounded-full transition-colors ${index <= stepIndex ? 'bg-sky-400' : 'bg-slate-800'}`} />
                            <div className={`mt-2 truncate text-[10px] font-bold uppercase tracking-wider ${index === stepIndex ? 'text-sky-300' : 'text-slate-500'}`}>
                                {index + 1}. {step.label}
                            </div>
                        </li>
                    ))}
                </ol>

                {error && (
                    <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
                    </div>
                )}

                {notice && (
                    <p className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-700 dark:text-sky-200">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {notice}
                    </p>
                )}

                {executionBlocked && (
                    <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            Another execution run is active for this cluster. Plan changes are disabled until it
                            finishes; wait, or cancel the run and start again.
                        </span>
                        <Button variant="outline" size="sm" onClick={cancelRun} isLoading={cancelling} disabled={cancelling}>
                            Cancel run
                        </Button>
                    </div>
                )}

            {stepIndex === 0 && (
                <section aria-labelledby="wizard-basics-heading">
                    <h2 id="wizard-basics-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Server className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Basic Info
                    </h2>
                <div className="space-y-4">
                    {k8sWarning && (
                        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-200">
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <span>{k8sWarning} The plan-scoped permission check will cover the required access.</span>
                        </p>
                    )}
                    {k8sCheck && versionCheckBlocks(k8sCheck) && (
                        <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                            {versionCheckMessage(k8sCheck)}
                        </p>
                    )}
                    <div>
                        <Label htmlFor="wizard-cluster-name">Cluster name</Label>
                        <Input id="wizard-cluster-name" ref={firstFieldRef} value={name} onChange={(event) => setName(event.target.value)} autoFocus placeholder="my-cluster" />
                    </div>
                    <div>
                        <Label htmlFor="wizard-cluster-description">Description</Label>
                        <Textarea id="wizard-cluster-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Optional description" />
                    </div>
                    <div>
                        <Label>Kubeconfig file</Label>
                        <div className="mb-2 flex gap-2 text-xs">
                            <label className="flex items-center gap-1.5">
                                <input type="radio" name="kubeconfig-source" checked={kubeconfigSource === 'upload'} onChange={() => setKubeconfigSource('upload')} />
                                I already have a kubeconfig
                            </label>
                            <label className="flex items-center gap-1.5">
                                <input type="radio" name="kubeconfig-source" checked={kubeconfigSource === 'bootstrap'} onChange={() => setKubeconfigSource('bootstrap')} />
                                Bootstrap a new cluster via Kubespray
                                <Badge tone="warning" size="xs">Experimental</Badge>
                            </label>
                        </div>
                        {kubeconfigSource === 'bootstrap' && !file && (
                            <BootstrapNodesPanel
                                onKubeconfigReady={(kubeconfigText) => {
                                    setFile(new File([kubeconfigText], 'bootstrapped-kubeconfig.yaml', { type: 'text/plain' }));
                                    setKubeconfigSource('upload');
                                }}
                                onCancel={() => setKubeconfigSource('upload')}
                            />
                        )}
                        {(kubeconfigSource === 'upload' || file) && (
                            <>
                                <div className="flex items-center gap-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
                                    <Upload size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
                                    <span className="flex-1 truncate text-sm text-theme-muted">{file ? file.name : 'Choose a kubeconfig file'}</span>
                                    <input key={kubeconfigInputKey} type="file" onChange={(event) => { setFile(event.target.files?.[0] || null); setK8sCheck(null); setK8sWarning(''); }} className="hidden" id="wizard-kubeconfig-file" />
                                    <label htmlFor="wizard-kubeconfig-file" className="cursor-pointer rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10">Browse</label>
                                </div>
                                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-theme-muted">
                                    <BookOpen size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                                    <span>
                                        <a
                                            href={KUBECONFIG_GUIDE_URL}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="font-medium text-[var(--brand-accent)] underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)] dark:text-cyan-300"
                                        >
                                            How to create a kubeconfig for Lens?
                                        </a>{' '}
                                        Use an Orchestration administrator identity for the simplest setup, or the least-privilege option in the guide.
                                    </span>
                                </p>
                            </>
                        )}
                    </div>
                </div>
                </section>
            )}

            {stepIndex === 1 && (
                <section aria-labelledby="wizard-proxy-heading">
                    <h2 id="wizard-proxy-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Globe className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Network Proxy
                    </h2>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <label className="flex items-start gap-2 rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2.5">
                            <input type="radio" className="mt-1" name="proxy-mode" checked={proxyMode === 'auto'} onChange={() => setProxyMode('auto')} />
                            <span>
                                <span className="block text-sm font-medium text-theme-text">Auto-detect this cluster's proxy (recommended)</span>
                                <span className="block text-xs text-theme-muted mt-0.5">
                                    Automatic detection from the target cluster is not implemented yet; until then this
                                    falls back to the Prism backend's own proxy environment variables (pre-wizard
                                    behavior). Use "Custom" below if this cluster needs a different proxy.
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2 rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2.5">
                            <input type="radio" className="mt-1" name="proxy-mode" checked={proxyMode === 'custom'} onChange={() => setProxyMode('custom')} />
                            <span className="block text-sm font-medium text-theme-text">Custom proxy for this cluster</span>
                        </label>
                    </div>
                    {proxyMode === 'custom' && (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <div>
                                <Label htmlFor="wizard-http-proxy">HTTP_PROXY</Label>
                                <Input id="wizard-http-proxy" value={httpProxy} onChange={(event) => setHttpProxy(event.target.value)} placeholder="http://proxy:3128" />
                            </div>
                            <div>
                                <Label htmlFor="wizard-https-proxy">HTTPS_PROXY</Label>
                                <Input id="wizard-https-proxy" value={httpsProxy} onChange={(event) => setHttpsProxy(event.target.value)} placeholder="http://proxy:3128" />
                            </div>
                            <div>
                                <Label htmlFor="wizard-no-proxy">NO_PROXY</Label>
                                <Input id="wizard-no-proxy" value={noProxy} onChange={(event) => setNoProxy(event.target.value)} placeholder="localhost,.svc" />
                            </div>
                        </div>
                    )}
                </div>
                </section>
            )}

            {stepIndex === 2 && (
                <section aria-labelledby="wizard-gateway-heading">
                    <h2 id="wizard-gateway-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Waypoints className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Model gateway
                    </h2>
                    <div className="space-y-4">
                        <div>
                            <Label htmlFor="wizard-gateway-provider">Provider</Label>
                            <Select id="wizard-gateway-provider" value={gatewayProvider}
                                onChange={(event) => setGatewayProvider(event.target.value)}>
                                <option value="istio">Istio</option>
                                <option value="envoy-ai-gateway" disabled>Envoy AI Gateway (not supported yet)</option>
                                <option value="agentgateway" disabled>agentgateway (not supported yet)</option>
                                <option value="gke" disabled>GKE Gateway (not supported yet)</option>
                            </Select>
                            <p className="mt-1 text-[11px] text-theme-muted">
                                Installed once for the whole cluster during Execute, after the permission check. Deployments keep their own
                                InferencePool + EPP (no per-deployment gateway); each model service publishes an
                                HTTPRoute/IPP against this shared Gateway.
                            </p>
                        </div>
                        <div>
                            <Label htmlFor="wizard-gateway-port">Gateway exposed port (NodePort, optional)</Label>
                            <Input id="wizard-gateway-port" type="number" min="30000" max="32767" value={gatewayPort}
                                onChange={(event) => setGatewayPort(event.target.value)} placeholder="Optional, e.g. 30080" />
                            <p className="mt-1 text-[11px] text-theme-muted">
                                NodePort the shared Gateway is exposed on. Leave empty and the cluster assigns a
                                random one — the actual port is shown in the Gateway status. Clients reach it at
                                http://&lt;node-ip&gt;:&lt;port&gt;/v1; bind your domain to that IP:PORT outside Lens.
                            </p>
                        </div>
                        <div>
                            <Label htmlFor="wizard-gateway-public-url">Gateway host/IP (optional)</Label>
                            <Input id="wizard-gateway-public-url" value={gatewayPublicUrl}
                                onChange={(event) => setGatewayPublicUrl(event.target.value)}
                                placeholder="e.g. 10.112.229.74" />
                            <p className="mt-1 text-[11px] text-theme-muted">
                                Externally reachable host/IP clients call to reach the Gateway (Lens combines it with the
                                exposed port). Leave empty and Lens derives one from the exposed port and the cluster node.
                            </p>
                        </div>
                        <div>
                            <Label htmlFor="wizard-gateway-authz-host">Lens address</Label>
                            <Input id="wizard-gateway-authz-host" list="wizard-lens-hosts" value={gatewayAuthzHost}
                                onChange={(event) => setGatewayAuthzHost(event.target.value)}
                                placeholder="Pick one or type a host/IP" disabled={gatewayProvider === 'gke'} />
                            <datalist id="wizard-lens-hosts">
                                {lensHosts.map((host) => <option key={host} value={host} />)}
                            </datalist>
                            <p className="mt-1 text-[11px] text-theme-muted">
                                {gatewayProvider === 'gke'
                                    ? 'GKE Gateway has no Lens address hook, so callers are not checked.'
                                    : 'The host or IP this cluster uses to reach Lens (Lens adds its own port). Auto-filled; leave empty and Lens fills it in.'}
                            </p>
                        </div>
                        <div>
                            <Label htmlFor="wizard-inotify-limit">Node inotify limit (fs.inotify.max_user_instances)</Label>
                            <Input id="wizard-inotify-limit" type="number" min="1" value={inotifyMaxUserInstances}
                                onChange={(event) => setInotifyMaxUserInstances(event.target.value)} placeholder="8192" />
                            <p className="mt-1 text-[11px] text-theme-muted">
                                Applied to every node so a busy node does not exhaust inotify (kind defaults to 128,
                                which causes "too many open files"). 8192 is recommended.
                            </p>
                        </div>
                    </div>
                </section>
            )}

            {stepIndex === 4 && (
                <section aria-labelledby="wizard-versions-heading">
                    <h2 id="wizard-versions-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Tag className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> llm-d stack
                    </h2>
                <div className="space-y-4">
                    <p className="text-xs text-theme-muted">
                        These versions are fixed by this Lens release. Clicking Next downloads the llm-d and
                        llm-d-benchmark sources on the Lens host so they are ready for later steps. The image
                        pre-pull, Gateway CRDs and LeaderWorkerSet (LWS) controller are installed during Execute,
                        after the permission check.
                    </p>
                    <div className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-4 py-3">
                    {(() => {
                        const providerKeys = { istio: 'istio', 'envoy-ai-gateway': 'envoy_ai_gateway', agentgateway: 'agentgateway' };
                        const providerLabels = { istio: 'Istio', 'envoy-ai-gateway': 'Envoy AI Gateway', agentgateway: 'agentgateway', gke: 'GKE Gateway' };
                        const providerLabel = providerLabels[gatewayProvider] || gatewayProvider;
                        const providerVersion = providerKeys[gatewayProvider] ? stackVersions?.gateway_providers?.[providerKeys[gatewayProvider]] : null;
                        // Only show the model-server image for the accelerators the user
                        // selected in the previous step (derived from hardware profiles).
                        const selectedModelServerRows = selectedAcceleratorIds.map((vendorId) => {
                            const vendor = acceleratorVendors.find((entry) => entry.id === vendorId);
                            const key = String(vendorId).toLowerCase();
                            return {
                                label: vendor?.label || vendorId,
                                value: modelServerImages[key] || modelServerImages[vendorId],
                            };
                        });
                        const groups = [
                            {
                                title: 'llm-d ecosystem',
                                rows: [
                                    { label: 'llm-d', value: stackVersions?.llm_d, download: 'llmD' },
                                    { label: 'llm-d-router (chart / EPP / P/D sidecar)', value: stackVersions?.llm_d_router },
                                    { label: 'llm-d-benchmark', value: stackVersions?.llm_d_lensmark, download: 'llmDBenchmark' },
                                    { label: 'Inference Payload Processor', value: stackVersions?.llm_d_inference_payload_processor },
                                ],
                            },
                            {
                                title: 'Cluster prerequisites',
                                rows: [
                                    { label: 'Kubernetes Gateway API', value: stackVersions?.k8s_gateway_api, crd: 'gateway_api' },
                                    { label: 'Gateway API Inference Extension', value: stackVersions?.k8s_gateway_api_inference_extension, crd: 'gateway_api_inference_extension' },
                                    { label: 'llm-d Router CRDs', value: stackVersions?.llm_d_router, crd: 'llm_d_router' },
                                    {
                                        label: 'LeaderWorkerSet (LWS) controller',
                                        value: stackVersions?.k8s_lws,
                                        lws: true,
                                        help: 'Lens installs the Kubernetes SIGs LeaderWorkerSet controller during Execute. It provides the DisaggregatedSet API used by llm-d P/D deployments and runs in the lws-system namespace.',
                                    },
                                ],
                            },
                            {
                                title: 'Gateway',
                                rows: [
                                    { label: `Provider — ${providerLabel}`, value: providerVersion },
                                ],
                            },
                            {
                                title: 'Model server images (hardware profile defaults)',
                                rows: selectedModelServerRows.length
                                    ? selectedModelServerRows
                                    : [{ label: 'Selected accelerators', value: 'None selected' }],
                            },
                        ];
                        return (
                            <div className="divide-y divide-theme-border">
                                {groups.map((group) => (
                                    <section key={group.title} className="py-3 first:pt-0 last:pb-0">
                                        <SectionLabel tone="blue" uppercase={false} className="text-[11px] font-semibold">{group.title}</SectionLabel>
                                        <dl className="space-y-2 text-xs">
                                            {group.rows.map((row) => {
                                                let state = null;
                                                let message = null;
                                                if (row.download) {
                                                    if (versionsDownloading || versionsDownloadStatus?.[row.download]) {
                                                        state = versionsDownloadStatus?.[row.download]?.state || 'starting';
                                                    }
                                                } else if (row.crd) {
                                                    const value = crdStatus?.[row.crd];
                                                    if (value) state = value === 'ready' ? 'ready' : 'missing';
                                                } else if (row.lws) {
                                                    if (lwsStatus) {
                                                        state = lwsStatus.installing ? 'installing' : lwsStatus.ready ? 'ready' : 'missing';
                                                        message = lwsStatus.installing ? null : lwsStatus.message || null;
                                                    }
                                                }
                                                return (
                                                    <div key={row.label} className="flex gap-3">
                                                        <dt className="flex w-72 shrink-0 items-center gap-1.5 text-theme-muted">
                                                            <span>{row.label}</span>
                                                            {row.help && (
                                                                <HelpTooltip
                                                                    label={`${row.label} help`}
                                                                    className="relative shrink-0"
                                                                    iconSize={12}
                                                                    tooltipClassName="left-0 top-full w-72 pt-1"
                                                                >
                                                                    {row.help}
                                                                </HelpTooltip>
                                                            )}
                                                        </dt>
                                                        <dd className="flex min-w-0 flex-1 items-center gap-2 text-theme-text">
                                                            <span className="min-w-0 flex-1 break-words">{row.value || '—'}</span>
                                                            {message && (
                                                                <span className="max-w-[40ch] truncate text-[10px] text-rose-300" title={message}>{message}</span>
                                                            )}
                                                            {state && (
                                                                <span className="flex shrink-0 items-center gap-1 text-theme-muted" title={message || undefined}>
                                                                    {state === 'ready' ? (
                                                                        <Check size={13} className="text-emerald-400" />
                                                                    ) : state === 'failed' || state === 'missing' ? (
                                                                        <AlertTriangle size={13} className="text-rose-400" />
                                                                    ) : (
                                                                        <Spinner size="xs" />
                                                                    )}
                                                                    <span>{state}</span>
                                                                </span>
                                                            )}
                                                        </dd>
                                                    </div>
                                                );
                                            })}
                                        </dl>
                                    </section>
                                ))}
                            </div>
                        );
                    })()}
                    </div>

                    {(() => {
                        const selectedDefaultImages = selectedAcceleratorIds
                            .map((vendorId) => modelServerImages[String(vendorId).toLowerCase()] || modelServerImages[vendorId])
                            .filter(Boolean);
                        const allDefaultImages = Object.values(modelServerImages).filter(Boolean);
                        const vllmPlaceholder = selectedDefaultImages[0]
                            || allDefaultImages[0]
                            || 'Hardware profile default (e.g. registry.example.com/vllm:tag)';
                        const vllmImageError = vllmImageValidationError(wizardState);
                        const isCustomVllmImage = Boolean(vllmImage.trim());
                        return (
                            <Panel padding="sm" tone="soft" className="shadow-none" title="vLLM runtime image">
                                <div className="space-y-2">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Label htmlFor="wizard-vllm-image" className="mb-0">
                                                vLLM image (optional)
                                            </Label>
                                            <Badge tone={isCustomVllmImage ? 'info' : 'neutral'} size="xs">
                                                {isCustomVllmImage ? 'Custom' : 'Default (hardware profile)'}
                                            </Badge>
                                        </div>
                                        {Boolean(vllmImage) && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="xs"
                                                onClick={() => setVllmImage('')}
                                                disabled={busy}
                                            >
                                                Reset to default
                                            </Button>
                                        )}
                                    </div>
                                    <Input
                                        id="wizard-vllm-image"
                                        value={vllmImage}
                                        onChange={(event) => setVllmImage(event.target.value)}
                                        placeholder={vllmPlaceholder}
                                        error={Boolean(vllmImageError)}
                                        disabled={busy}
                                    />
                                    <FormError message={vllmImageError} />
                                    <p className="text-xs text-theme-muted">
                                        Leave empty to use the hardware profile default. When set, this image is
                                        pre-pulled onto worker nodes during Execute and used as the default vLLM
                                        image for deployments and evaluations on this cluster unless overridden per
                                        deployment.
                                    </p>
                                </div>
                            </Panel>
                        );
                    })()}

                    <Panel padding="sm" tone="soft" className="shadow-none" title="Monitoring & Observability">
                        <div className="space-y-4">
                            <p className="text-xs text-theme-muted">
                                Cluster monitoring is required for every cluster. Choose whether Lens installs the
                                managed Prometheus/Grafana stack during Execute or connects to an existing Prometheus.
                            </p>
                            <div>
                                <Label>Monitoring mode</Label>
                                <ToggleGroup
                                    value={monitoringMode}
                                    onChange={(nextMode) => setMonitoringMode(nextMode)}
                                    options={[
                                        { value: 'managed', label: 'Managed monitoring stack' },
                                        { value: 'existing', label: 'Use existing monitoring' },
                                    ]}
                                />
                            </div>

                            {monitoringMode === 'managed' ? (
                                <div className="space-y-3">
                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                        <div>
                                            <Label htmlFor="wizard-monitoring-namespace">Monitoring namespace</Label>
                                            <Input
                                                id="wizard-monitoring-namespace"
                                                value={monitoringNamespace}
                                                onChange={(event) => {
                                                    setMonitoringNamespaceTouched(true);
                                                    setMonitoringNamespace(event.target.value);
                                                }}
                                                placeholder={defaultMonitoringNamespace(cluster?.id)}
                                            />
                                        </div>
                                        <div>
                                            <Label htmlFor="wizard-monitoring-host">Monitoring host / IP (optional)</Label>
                                            <Input
                                                id="wizard-monitoring-host"
                                                value={monitoringHost}
                                                onChange={(event) => setMonitoringHost(event.target.value)}
                                                placeholder="Optional, e.g. 10.112.229.74"
                                            />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                        <div>
                                            <Label htmlFor="wizard-prometheus-node-port">Prometheus NodePort (optional)</Label>
                                            <Input
                                                id="wizard-prometheus-node-port"
                                                type="number"
                                                min="30000"
                                                max="32767"
                                                value={prometheusNodePort}
                                                onChange={(event) => setPrometheusNodePort(event.target.value)}
                                                placeholder="Optional, 30000–32767"
                                            />
                                        </div>
                                        <div>
                                            <Label htmlFor="wizard-grafana-node-port">Grafana NodePort (optional)</Label>
                                            <Input
                                                id="wizard-grafana-node-port"
                                                type="number"
                                                min="30000"
                                                max="32767"
                                                value={grafanaNodePort}
                                                onChange={(event) => setGrafanaNodePort(event.target.value)}
                                                placeholder="Optional, 30000–32767"
                                            />
                                        </div>
                                    </div>
                                    <Checkbox
                                        id="wizard-install-accelerator-exporters"
                                        checked={installAcceleratorExporters}
                                        onChange={(event) => setInstallAcceleratorExporters(event.target.checked)}
                                        label="Co-install accelerator exporters for selected GPUs"
                                    />
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                        <div>
                                            <Label htmlFor="wizard-prometheus-url">Prometheus URL</Label>
                                            <Input
                                                id="wizard-prometheus-url"
                                                value={prometheusUrl}
                                                onChange={(event) => setPrometheusUrl(event.target.value)}
                                                placeholder="https://prometheus.example.com"
                                            />
                                        </div>
                                        <div>
                                            <Label htmlFor="wizard-grafana-url">Grafana URL (optional)</Label>
                                            <Input
                                                id="wizard-grafana-url"
                                                value={grafanaUrl}
                                                onChange={(event) => setGrafanaUrl(event.target.value)}
                                                placeholder="Optional, e.g. https://grafana.example.com"
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <Label htmlFor="wizard-monitoring-namespace">Monitoring namespace</Label>
                                        <Input
                                            id="wizard-monitoring-namespace"
                                            value={monitoringNamespace}
                                            onChange={(event) => {
                                                setMonitoringNamespaceTouched(true);
                                                setMonitoringNamespace(event.target.value);
                                            }}
                                            placeholder={defaultMonitoringNamespace(cluster?.id)}
                                        />
                                    </div>
                                    <Checkbox
                                        id="wizard-install-accelerator-exporters"
                                        checked={installAcceleratorExporters}
                                        onChange={(event) => setInstallAcceleratorExporters(event.target.checked)}
                                        label="Install missing accelerator exporters and metrics-reader RBAC"
                                    />
                                </div>
                            )}

                            <FormError message={monitoringValidationError(wizardState)} />
                        </div>
                    </Panel>

                    {error && (
                        <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                            {error}
                        </p>
                    )}
                </div>
                </section>
            )}

            {stepIndex === 3 && (
                <section aria-labelledby="wizard-accelerator-heading">
                    <h2 id="wizard-accelerator-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Cpu className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Accelerator
                    </h2>
                <div className="space-y-4">
                    <p className="text-xs text-theme-muted">
                        Select every accelerator this cluster hosts (a heterogeneous cluster selects several). Candidates
                        are the accelerators Lens supports through a device plugin/driver. Selection only writes the
                        provisioning plan; Lens installs the selected drivers and device plugins during Execute.
                    </p>
                    <div className="space-y-3">
                        {acceleratorVendors.map((vendor) => {
                            const selectedModes = selectedAccelerators[vendor.id] || [];
                            const included = selectedModes.length > 0;
                            const modes = accessModesForVendor(acceleratorVendors, vendor.id);
                            return (
                                <div key={vendor.id} className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-4 py-3">
                                    <label className="flex items-center gap-2 text-sm font-medium">
                                        <input
                                            type="checkbox"
                                            disabled={vendor.disabled}
                                            checked={included}
                                            onChange={(event) => setSelectedAccelerators((current) => {
                                                const next = { ...current };
                                                if (event.target.checked) next[vendor.id] = modes.length ? [modes[0]] : [];
                                                else delete next[vendor.id];
                                                return next;
                                            })}
                                        />
                                        {vendor.label}
                                        {vendor.disabled && (
                                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500">
                                                Coming soon
                                            </span>
                                        )}
                                    </label>
                                    {included && (
                                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
                                            {modes.map((mode) => (
                                                <label key={mode} className="flex items-center gap-1.5 text-xs">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedModes.includes(mode)}
                                                        onChange={(event) => setSelectedAccelerators((current) => {
                                                            const currentModes = current[vendor.id] || [];
                                                            const nextModes = event.target.checked
                                                                ? [...currentModes, mode]
                                                                : currentModes.filter((item) => item !== mode);
                                                            const next = { ...current, [vendor.id]: nextModes };
                                                            if (!nextModes.length) delete next[vendor.id];
                                                            return next;
                                                        })}
                                                    />
                                                    {ACCESS_MODE_LABEL[mode]}
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
                </section>
            )}


            {stepIndex === 5 && (
                <section aria-labelledby="wizard-modelcache-heading">
                    <h2 id="wizard-modelcache-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <Database className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Model Cache
                    </h2>
                <div className="space-y-4">
                    <p className="text-xs text-theme-muted">
                        The HF_TOKEN Secret is required for every cluster. Lens creates it during Execute, and
                        Deploy/Evaluate reuse it so gated models can be pulled without asking for a token again.
                    </p>
                    <div className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-4 py-4">
                        <div className="space-y-4">
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <div>
                                    <Label htmlFor="wizard-secret-namespace">HF_TOKEN secret namespace</Label>
                                    <Input
                                        id="wizard-secret-namespace"
                                        value={secretNamespace}
                                        onChange={(event) => {
                                            setSecretNamespaceTouched(true);
                                            setSecretNamespace(event.target.value);
                                            setSecretNamespaceMode(kubeconfigNamespace ? 'existing' : 'create');
                                        }}
                                        placeholder={kubeconfigNamespace || 'llm-d-bench-storage-<cluster id>'}
                                    />
                                </div>
                                <div>
                                    <Label htmlFor="wizard-secret-name">Secret name</Label>
                                    <Input id="wizard-secret-name" value={secretName} onChange={(event) => setSecretName(event.target.value)} />
                                </div>
                            </div>
                            <div>
                                <div className="mb-1.5 flex items-center gap-2">
                                    <Label htmlFor="wizard-hf-token" className="mb-0">HuggingFace token</Label>
                                    {hfTokenSaved && (
                                        <Badge tone="success" size="xs">Saved for this draft</Badge>
                                    )}
                                </div>
                                <Input
                                    id="wizard-hf-token"
                                    type="password"
                                    autoComplete="new-password"
                                    value={hfToken}
                                    onChange={(event) => setHfToken(event.target.value)}
                                    placeholder={
                                        hfTokenSaved
                                            ? 'Leave empty to keep the saved token, or enter a new one to replace'
                                            : 'hf_...'
                                    }
                                />
                                <p className="mt-1 text-[11px] text-theme-muted">
                                    Stored encrypted for this draft until Execute creates the Kubernetes Secret,
                                    deleted when finalized or discarded, and never stored in the plan.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-3 rounded-lg border border-slate-700/70 bg-slate-800/40 px-4 py-4">
                        <div>
                            <Label>Pre-download a model (optional)</Label>
                            <p className="text-[11px] leading-relaxed text-slate-400">
                                Starts a Model Cache download into the Storage volume configured on the next step
                                during Execute. Storage is required when prewarm is enabled.
                            </p>
                        </div>
                        <Checkbox
                            id="wizard-prewarm-enabled"
                            checked={prewarmEnabled}
                            onChange={(event) => setPrewarmEnabled(event.target.checked)}
                            label="Also pre-download (prewarm) a model into this cache now"
                        />
                        {prewarmEnabled && (
                            <div className="grid grid-cols-1 gap-3 pt-2 md:grid-cols-2">
                                <div>
                                    <Label htmlFor="wizard-repo-id">Model repo id</Label>
                                    <Input id="wizard-repo-id" value={repoId} onChange={(event) => setRepoId(event.target.value)} placeholder="meta-llama/Llama-3.1-8B-Instruct" error={Boolean(repoId) && !REPO_ID_PATTERN.test(repoId.trim())} />
                                </div>
                                <div>
                                    <Label htmlFor="wizard-revision">Revision</Label>
                                    <Input id="wizard-revision" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder="main" />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                </section>
            )}

            {stepIndex === 6 && (
                <section aria-labelledby="wizard-storage-heading">
                    <h2 id="wizard-storage-heading" className="mb-4 flex items-center gap-2 text-lg font-semibold text-slate-100">
                        <HardDrive className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Storage
                    </h2>
                    <div className="space-y-4">
                        <p className="text-xs text-theme-muted">
                            A storage volume is created for every cluster during Execute, using the same fields as
                            the Storage page's manual "New storage volume" form. Nothing is created now; fill in the
                            values below.
                        </p>
                        <div className="space-y-4 rounded-lg border border-slate-700/70 bg-slate-800/40 px-4 py-4">
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <div>
                                    <Label htmlFor="wizard-storage-kind">Type</Label>
                                    <Select id="wizard-storage-kind" value={storageKind} onChange={(event) => setStorageKind(event.target.value)}>
                                        <option value="local-disk">hostPath</option>
                                        <option value="nfs">NFS</option>
                                    </Select>
                                </div>
                                <div>
                                    <Label htmlFor="wizard-storage-capacity">Capacity</Label>
                                    <Input id="wizard-storage-capacity" value={storageCapacity} onChange={(event) => setStorageCapacity(event.target.value.trim())} placeholder="100Gi" error={Boolean(storageCapacity) && !CAPACITY_PATTERN.test(storageCapacity.trim())} />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <div>
                                    <Label htmlFor="wizard-storage-name">Name (optional)</Label>
                                    <Input id="wizard-storage-name" value={storageName} onChange={(event) => setStorageName(event.target.value)} placeholder="model-cache" />
                                </div>
                                <div>
                                    <Label htmlFor="wizard-storage-namespace">PVC namespace</Label>
                                    <Input
                                        id="wizard-storage-namespace"
                                        value={storageNamespace}
                                        error={!storageNamespaceValid(storageNamespace)}
                                        onChange={(event) => {
                                            const next = event.target.value;
                                            const effective = next.trim() || defaultStorageNamespace(cluster?.id);
                                            setStorageNamespaceTouched(true);
                                            setStorageNamespace(next);
                                            setStorageNamespaceMode(
                                                kubeconfigNamespace && effective === kubeconfigNamespace
                                                    ? 'existing'
                                                    : 'create',
                                            );
                                        }}
                                        placeholder={defaultStorageNamespace(cluster?.id)}
                                    />
                                    {!storageNamespaceValid(storageNamespace) ? (
                                        <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">
                                            Namespace must be a valid DNS-1123 label (lowercase letters, numbers, and hyphens, max 63 characters).
                                        </p>
                                    ) : (
                                        <p className="mt-1 text-[11px] text-theme-muted">
                                            Namespace where the PVC and Model Cache Jobs run.
                                        </p>
                                    )}
                                </div>
                            </div>
                            {storageKind === 'local-disk' && (
                                <div>
                                    <Label htmlFor="wizard-host-path">Host path</Label>
                                    <Input id="wizard-host-path" value={hostPath} onChange={(event) => setHostPath(event.target.value.trim())} placeholder="/data/model-cache" />
                                    {storageNodes.length > 0 && (
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                            {storageNodes.map((node) => (
                                                <span key={node.name} className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">{node.name}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                            {storageKind === 'nfs' && (
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                    <div>
                                        <Label htmlFor="wizard-nfs-server">Server</Label>
                                        <Input id="wizard-nfs-server" value={nfsServer} onChange={(event) => setNfsServer(event.target.value.trim())} placeholder="nfs.example.com" />
                                    </div>
                                    <div>
                                        <Label htmlFor="wizard-nfs-path">Export path</Label>
                                        <Input id="wizard-nfs-path" value={nfsPath} onChange={(event) => setNfsPath(event.target.value.trim())} placeholder="/export/models" />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            )}

            {stepIndex === REVIEW_STEP_INDEX && (
                <section aria-labelledby="wizard-review-heading" className="space-y-4">
                    <div>
                        <h2 id="wizard-review-heading" className="flex items-center gap-2 text-lg font-semibold text-slate-100">
                            <ListChecks className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Review
                        </h2>
                        <p className="mt-1 text-sm text-theme-muted">
                            Review the saved provisioning plan, then choose Preflight to check cluster permissions on the Execute step.
                        </p>
                    </div>

                    {!hasHfTokenForRun && (
                        <InlineHfTokenBanner
                            message="Enter the Hugging Face token before running Preflight."
                            token={inlineToken}
                            onTokenChange={(value) => {
                                setInlineToken(value);
                                if (inlineTokenError) setInlineTokenError('');
                            }}
                            onSave={handleSaveInlineToken}
                            busy={inlineTokenBusy}
                            disabled={!cluster?.id || executionBlocked}
                            error={inlineTokenError}
                        />
                    )}

                    <Panel padding="sm" tone="soft" className="shadow-none">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex min-w-0 items-start gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400">
                                    <Server size={17} aria-hidden="true" />
                                </span>
                                <div className="min-w-0">
                                    <p className="truncate text-base font-semibold text-theme-text">
                                        {cluster?.name || name || 'New cluster'}
                                    </p>
                                    <p className="mt-0.5 text-xs text-theme-muted">
                                        {description.trim() || cluster?.description || 'No description'}
                                    </p>
                                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-theme-muted">
                                        <span className="inline-flex items-center gap-1.5">
                                            <Upload size={12} aria-hidden="true" />
                                            {file?.name || 'Kubeconfig uploaded'}
                                        </span>
                                        {k8sCheck?.version && (
                                            <span className="inline-flex items-center gap-1.5">
                                                <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                                Kubernetes {k8sCheck.version}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {planVersion != null && (
                                <Badge tone="neutral" size="xs">Plan v{planVersion}</Badge>
                            )}
                        </div>
                    </Panel>

                    <Panel
                        padding="sm"
                        className="shadow-none"
                        title={<PanelHeading icon={<ListChecks size={14} />}>Provisioning plan</PanelHeading>}
                    >
                        <dl className="divide-y divide-theme-border">
                            <ReviewRow label="Network proxy" mono={proxyMode === 'custom'}>
                                {proxyMode === 'custom'
                                    ? `HTTP=${httpProxy.trim() || '—'} · HTTPS=${httpsProxy.trim() || '—'} · NO_PROXY=${noProxy.trim() || '—'}`
                                    : 'Auto-detect (Lens backend environment)'}
                            </ReviewRow>
                            <ReviewRow label="Model gateway">
                                <span className="block">
                                    {GATEWAY_PROVIDER_LABEL[gatewayProvider] || gatewayProvider}
                                    {' · '}
                                    <span className="font-mono text-[11px]">
                                        {plan?.gateway?.namespace || gatewayNamespace || 'lens-gateway'}/{plan?.gateway?.name || gatewayName || 'lens-inference-gateway'}
                                    </span>
                                </span>
                                <span className="mt-0.5 block text-[11px] text-theme-muted">
                                    {`NodePort: ${gatewayPort.trim() || 'auto'} · Host/IP: ${gatewayPublicUrl.trim() || 'auto'}${gatewayProvider === 'gke' ? '' : ` · Lens: ${gatewayAuthzHost.trim() || 'auto'}`} · inotify: ${inotifyMaxUserInstances.trim() || '8192'}`}
                                </span>
                            </ReviewRow>
                            <ReviewRow label="Accelerators">
                                {(() => {
                                    const customVllmImage = vllmImage.trim() || plan?.stack?.vllmImage || '';
                                    const runtimeImages = [...new Set(
                                        selectedAcceleratorIds
                                            .map((vendorId) => modelServerImages[String(vendorId).toLowerCase()] || modelServerImages[vendorId])
                                            .filter(Boolean),
                                    )];
                                    return (
                                        <>
                                            {acceleratorPairs.length > 0 ? (
                                                <span className="block">
                                                    {acceleratorPairs.map((pair) => `${pair.label} (${ACCESS_MODE_SHORT[pair.mode] || pair.mode})`).join(', ')}
                                                </span>
                                            ) : (
                                                <span className="text-theme-muted">None selected (drivers and device plugins skipped)</span>
                                            )}
                                            {customVllmImage ? (
                                                <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-theme-text">
                                                    <span className="break-all">{customVllmImage}</span>
                                                    <Badge tone="info" size="xs">Custom</Badge>
                                                </span>
                                            ) : (
                                                acceleratorPairs.length > 0 && runtimeImages.length > 0 && (
                                                    <span className="mt-0.5 block break-all font-mono text-[11px] text-theme-muted">
                                                        {runtimeImages.join(' · ')}
                                                    </span>
                                                )
                                            )}
                                        </>
                                    );
                                })()}
                            </ReviewRow>
                            <ReviewRow label="llm-d stack" mono>
                                {(() => {
                                    const llmDRef = stackVersions?.llm_d || cluster?.llmDRef;
                                    const routerRef = plan?.stack?.routerVersion || stackVersions?.llm_d_router;
                                    const gieRef = plan?.stack?.gieVersion || stackVersions?.k8s_gateway_api_inference_extension;
                                    const ippRef = plan?.stack?.ippVersion || stackVersions?.llm_d_inference_payload_processor;
                                    const lwsRef = plan?.stack?.lwsVersion || stackVersions?.k8s_lws;
                                    const parts = [
                                        llmDRef ? `llm-d ${llmDRef}` : null,
                                        routerRef ? `router ${routerRef}` : null,
                                        gieRef ? `GIE ${gieRef}` : null,
                                        ippRef ? `IPP ${ippRef}` : null,
                                        plan?.stack?.lwsEnabled !== false ? (lwsRef ? `LWS ${lwsRef}` : 'LWS') : null,
                                        plan?.stack?.crdsEnabled !== false
                                            ? (stackVersions?.k8s_gateway_api ? `Gateway CRDs (${stackVersions.k8s_gateway_api})` : 'Gateway CRDs')
                                            : null,
                                    ].filter(Boolean);
                                    return parts.length ? parts.join(' · ') : 'Pinned stack';
                                })()}
                            </ReviewRow>
                            <ReviewRow label="Monitoring">
                                {(() => {
                                    const mon = plan?.monitoring || {};
                                    const mode = mon.mode || monitoringMode || 'managed';
                                    const ns = mon.namespace || monitoringNamespace.trim() || defaultMonitoringNamespace(cluster?.id);
                                    const exporters = mon.installAcceleratorExporters ?? installAcceleratorExporters;
                                    const promUrl = mon.prometheusUrl || (mode === 'existing' ? prometheusUrl.trim() : '');
                                    const grafUrl = mon.grafanaUrl || (mode === 'existing' ? grafanaUrl.trim() : '');
                                    const promPort = mon.prometheusNodePort ?? (mode === 'managed' && prometheusNodePort.trim() ? prometheusNodePort.trim() : null);
                                    const grafPort = mon.grafanaNodePort ?? (mode === 'managed' && grafanaNodePort.trim() ? grafanaNodePort.trim() : null);
                                    const monHost = mon.host || (mode === 'managed' ? monitoringHost.trim() : '');
                                    const details = mode === 'existing'
                                        ? [
                                            promUrl ? `Prometheus: ${promUrl}` : 'Prometheus URL missing',
                                            grafUrl ? `Grafana: ${grafUrl}` : null,
                                            `Exporters & RBAC: ${exporters ? 'on' : 'off'}`,
                                        ]
                                        : [
                                            `Prometheus NodePort: ${promPort || 'auto'}`,
                                            `Grafana NodePort: ${grafPort || 'auto'}`,
                                            `Host/IP: ${monHost || 'auto'}`,
                                            `Accelerator exporters: ${exporters ? 'on' : 'off'}`,
                                        ];
                                    return (
                                        <>
                                            <span className="block">
                                                {mode === 'existing' ? 'Existing monitoring' : 'Managed monitoring stack'}
                                                {' · '}
                                                <span className="font-mono text-[11px]">{ns}</span>
                                            </span>
                                            <span className="mt-0.5 block text-[11px] text-theme-muted">
                                                {details.filter(Boolean).join(' · ')}
                                            </span>
                                        </>
                                    );
                                })()}
                            </ReviewRow>
                            <ReviewRow label="HF_TOKEN secret">
                                <span className="break-all font-mono text-[11px]">{`${secretNamespace.trim() || '—'}/${secretName.trim() || '—'}`}</span>
                                <span className="ml-1.5 text-[11px] text-theme-muted">
                                    ({hfTokenStatusLabel})
                                </span>
                            </ReviewRow>
                            <ReviewRow label="Storage">
                                <span>{`${STORAGE_KIND_LABEL[storageKind] || storageKind} · ${storageCapacity.trim() || '—'} · `}</span>
                                <span className="break-all font-mono text-[11px]">
                                    {`${plan?.storage?.namespace || storageNamespace.trim() || defaultStorageNamespace(cluster?.id)}/${plannedStorageVolumeName(wizardState) || 'auto-named'}`}
                                </span>
                                <span className="ml-1 break-all font-mono text-[11px] text-theme-muted">
                                    ({storageKind === 'local-disk' ? (hostPath.trim() || '—') : `${nfsServer.trim() || '—'}:${nfsPath.trim() || '—'}`})
                                </span>
                            </ReviewRow>
                            <ReviewRow label="Model cache">
                                {prewarmEnabled ? (
                                    <>
                                        Prewarm{' '}
                                        <span className="break-all font-mono text-[11px]">
                                            {`${repoId.trim() || '—'}@${revision.trim() || 'main'}`}
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-theme-muted">No prewarm</span>
                                )}
                            </ReviewRow>
                        </dl>
                    </Panel>
                </section>
            )}

            {stepIndex === EXECUTE_STEP_INDEX && (
                <section aria-labelledby="wizard-execute-heading" className="space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h2 id="wizard-execute-heading" className="flex items-center gap-2 text-lg font-semibold text-slate-100">
                                <Rocket className="h-5 w-5 text-[var(--brand-accent)] dark:text-sky-400" /> Execute
                            </h2>
                            <p className="mt-1 text-sm text-theme-muted">
                                Checks cluster permissions for the saved plan first, then runs the user operations in
                                dependency order and finalizes the cluster. A 403 refreshes the Orchestration administrator handoff
                                and keeps completed user operations.
                            </p>
                        </div>
                        {(() => {
                            const executeBadge = finished
                                ? { tone: 'success', label: 'Complete' }
                                : finishing
                                    ? { tone: 'info', label: 'Running' }
                                    : executionFailedKey
                                        ? { tone: 'warning', label: 'Paused' }
                                        : permissionBusy || handoffBusy || resumeBusy
                                            ? { tone: 'info', label: 'Checking permissions' }
                                            : permissionError || permissionBlocked
                                                ? { tone: 'danger', label: permissionBlocked ? 'Blocked' : 'Check failed' }
                                                : adminRequired && !(adminVerified && executionToken)
                                                    ? { tone: 'warning', label: 'Permissions needed' }
                                                    : canExecute
                                                        ? { tone: 'success', label: 'Ready' }
                                                        : { tone: 'neutral', label: 'Not ready' };
                            return <Badge tone={executeBadge.tone} size="sm">{executeBadge.label}</Badge>;
                        })()}
                    </div>

                    {!finished && !hasHfTokenForRun && (
                        <InlineHfTokenBanner
                            message="Enter the Hugging Face token before executing."
                            token={inlineToken}
                            onTokenChange={(value) => {
                                setInlineToken(value);
                                if (inlineTokenError) setInlineTokenError('');
                            }}
                            onSave={handleSaveInlineToken}
                            busy={inlineTokenBusy}
                            disabled={!cluster?.id || finishing || executionBlocked}
                            error={inlineTokenError}
                        />
                    )}

                    {executionCompleted && !finished && (
                        <p role="status" className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-200">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                User operations for this plan already completed. Once permissions are verified, click Execute to finalize the cluster without re-running completed steps.
                            </span>
                        </p>
                    )}

                    {!finished && permissionBusy && !(permissionReport && (adminRequired || permissionBlocked)) && (
                        <Panel
                            padding="sm"
                            tone="soft"
                            className="shadow-none"
                            title={(
                                <span className="flex items-center gap-2">
                                    <KeyRound size={15} className="text-sky-600 dark:text-sky-400" aria-hidden="true" />
                                    Permissions
                                </span>
                            )}
                            actions={<Badge tone="info" size="xs">Checking</Badge>}
                        >
                            <p className="flex items-center gap-2 text-xs text-theme-muted">
                                <Spinner size="xs" className="text-sky-600 dark:text-sky-400" />
                                <span>Checking permissions…</span>
                            </p>
                        </Panel>
                    )}

                    {!finished && !permissionBusy && permissionError && !(permissionReport && (adminRequired || permissionBlocked)) && (
                        <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1">{permissionError}</span>
                            <Button variant="outline" size="sm" onClick={recheckPermissions} disabled={permissionBusy || finishing}>
                                Re-check
                            </Button>
                        </div>
                    )}

                    {!finished && !permissionBusy && permissionReady && (
                        <Panel
                            padding="sm"
                            tone="soft"
                            className="shadow-none"
                            title={(
                                <span className="flex items-center gap-2">
                                    <KeyRound size={15} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    Permissions
                                </span>
                            )}
                            actions={<Badge tone="success" size="xs">Ready</Badge>}
                        >
                            <p className="text-xs leading-relaxed text-theme-muted">
                                {canExecute && !canResume
                                    ? 'This identity has every permission the plan needs. Click Execute to run the setup operations.'
                                    : 'This identity has every permission the plan needs.'}
                            </p>
                            {handoffWarning && (
                                <p role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
                                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                    <span className="min-w-0 flex-1">{handoffWarning}</span>
                                </p>
                            )}
                        </Panel>
                    )}

                    {!finished
                        && permissionPanelVisible(permissionReport)
                        && (
                            <PermissionHandoffPanel
                                report={permissionReport}
                                script={remediationScript}
                                filename={remediationInfo?.filename}
                                instructions={remediationInfo?.instructions}
                                onLoadScript={loadRemediation}
                                handoff={handoffInfo}
                                hasToken={Boolean(executionToken)}
                                canExecute={canExecute && !canResume}
                                onRecheck={!finishing ? recheckPermissions : undefined}
                                onEditSecretNamespace={!finishing ? () => { setError(''); setStepIndex(5); saveResumeStep(WIZARD_STEP_IDS[5]); } : undefined}
                                busy={permissionBusy || handoffBusy || resumeBusy}
                                error={handoffError || permissionError}
                                warning={handoffWarning}
                            />
                        )}

                    {executeBlocker && (
                        <div role="status" className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1">{executeBlocker.message}</span>
                            {executeBlocker.canRecheck && (
                                <Button variant="outline" size="sm" onClick={recheckPermissions} disabled={permissionBusy || handoffBusy || resumeBusy || finishing}>
                                    Re-check
                                </Button>
                            )}
                        </div>
                    )}

                    {showSetupProgress && (
                        <Panel
                            padding="sm"
                            className="shadow-none"
                            title={<PanelHeading icon={<ListChecks size={14} />}>Setup progress</PanelHeading>}
                            actions={finished ? <Badge tone="success" size="xs">Complete</Badge> : null}
                        >
                            <div role="status" aria-live="polite">
                                {finishStatus.length > 0 ? (
                                    <ul className="divide-y divide-theme-border">
                                        {finishStatus.map((item) => (
                                            <li key={item.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                                                    {item.state === 'running' && <Spinner size="xs" className="text-sky-600 dark:text-sky-400" />}
                                                    {item.state === 'done' && <Check size={14} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
                                                    {item.state === 'failed' && <span className="text-rose-600 dark:text-rose-400" aria-hidden="true">&#10007;</span>}
                                                    {item.state === 'pending' && <span className="h-2 w-2 rounded-full bg-slate-600" aria-hidden="true" />}
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <p className={cn('text-xs font-medium', item.state === 'failed' ? 'text-rose-600 dark:text-rose-300' : 'text-theme-text')}>
                                                        {item.label}
                                                    </p>
                                                    {item.detail && (
                                                        <p className="mt-0.5 break-words text-[11px] text-rose-600 dark:text-rose-300">{item.detail}</p>
                                                    )}
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                ) : !finished ? (
                                    <p className="text-xs text-theme-muted">
                                        {finishing
                                            ? 'Finalizing cluster setup…'
                                            : (permissionBusy || handoffBusy || resumeBusy)
                                                ? 'Checking permissions…'
                                                : 'Cluster setup paused. Review the error above and retry.'}
                                    </p>
                                ) : null}
                                {finished && (
                                    <p className="flex items-center gap-2 border-t border-theme-border pt-3 text-sm text-emerald-600 first:border-0 first:pt-0 dark:text-emerald-400">
                                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Cluster setup complete.
                                    </p>
                                )}
                            </div>
                        </Panel>
                    )}
                </section>
            )}
            </div>
        </Modal>
    );
}

export default CreateClusterWizard;
