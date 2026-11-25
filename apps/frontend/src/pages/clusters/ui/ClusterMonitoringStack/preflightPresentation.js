const OPTIONAL_ABSENT_DIAGNOSTIC_CODES = new Set([
    'GRAFANA_URL_OPTIONAL',
    'ACCELERATOR_METRICS_NOT_DETECTED',
]);

const ABNORMAL_MONITORING_STATUSES = new Set(['degraded', 'unreachable', 'failed']);
const AFFECTED_COMPONENT_STATUSES = new Set(['degraded', 'missing', 'unreachable', 'failed']);
const NOTICE_MONITORING_STATUSES = new Set(['degraded', 'absent', 'unreachable', 'failed']);

function formatComponentName(name) {
    return String(name || '').replace(/_/g, ' ').trim();
}

function resolveRoleAndMode(monitoring, cluster, { monitoringRequired = false } = {}) {
    const rawAccessMode = monitoring?.accessMode ?? monitoring?.access_mode;
    const rawCanManage = monitoring?.canManage ?? monitoring?.can_manage;
    const rawMode = monitoring?.monitoringMode
        ?? monitoring?.monitoring_mode
        ?? cluster?.monitoringMode
        ?? cluster?.monitoring_mode;

    const isNonAdmin = rawAccessMode === 'non_admin'
        || rawCanManage === false
        || (rawAccessMode !== 'admin' && Boolean(monitoringRequired));
    const isExisting = rawMode === 'existing';
    const hasKnownRoleOrMode = rawAccessMode === 'admin'
        || rawAccessMode === 'non_admin'
        || typeof rawCanManage === 'boolean'
        || rawMode === 'managed'
        || rawMode === 'existing';

    return {
        isNonAdmin,
        isExisting,
        hasKnownRoleOrMode,
        accessMode: isNonAdmin ? 'non_admin' : 'admin',
        monitoringMode: isExisting ? 'existing' : 'managed',
    };
}

export function checkPassed(check) {
    return check?.passed === true || ['passed', 'ready', 'ok', 'success'].includes(check?.status);
}

export function checkTone(check) {
    if (checkPassed(check)) return 'success';
    return check?.blocking === false ? 'warning' : 'danger';
}

export function checkLabel(check) {
    if (checkPassed(check)) return 'Passed';
    return check?.blocking === false ? 'Missing' : 'Failed';
}

export function isOptionalAbsentComponent(component) {
    if (!component || typeof component !== 'object') return false;
    if (component.optional === true) return true;
    if (component.status !== 'missing') return false;
    const diagnostics = Array.isArray(component.diagnostics) ? component.diagnostics : [];
    return diagnostics.some((diag) => OPTIONAL_ABSENT_DIAGNOSTIC_CODES.has(diag?.code));
}

export function summarizeMonitoringComponents(components) {
    const list = Array.isArray(components) ? components : [];
    const counted = list.filter((component) => !isOptionalAbsentComponent(component));
    const ready = counted.filter((component) => ['ready', 'external'].includes(component?.status)).length;
    const desired = counted.length;
    const affected = counted.filter((component) => AFFECTED_COMPONENT_STATUSES.has(component?.status));
    return { ready, desired, counted, affected };
}

export function getNonAdminClusterStackAction(snapshot) {
    if (!snapshot || snapshot.access_mode !== 'non_admin') return null;
    if (snapshot.cluster?.reachable === false) return null;
    if (snapshot.monitoring_mode === 'existing') return null;
    if (['external', 'unsupported', 'installing', 'progressing'].includes(snapshot.status)) return null;
    if (snapshot.status === 'absent') return 'install';
    if (
        ['degraded', 'unreachable', 'failed'].includes(snapshot.status)
        || summarizeMonitoringComponents(snapshot.components).affected.length > 0
    ) {
        return 'reinstall';
    }
    return null;
}

export function getNonAdminAcceleratorAction(snapshot) {
    if (!snapshot) return null;
    const isNonAdmin = snapshot.cluster_access_mode === 'non_admin'
        || (snapshot.cluster_reachable !== false && snapshot.can_manage === false);
    if (!isNonAdmin || snapshot.cluster_reachable === false) return null;
    if (['unsupported', 'installing', 'progressing'].includes(snapshot.status)) return null;
    if (snapshot.status === 'absent') return 'install';
    if (
        ['degraded', 'unreachable', 'failed'].includes(snapshot.status)
        || summarizeMonitoringComponents(snapshot.components).affected.length > 0
    ) {
        return 'reinstall';
    }
    return null;
}

export function monitoringMetricStatus(monitoring) {
    const status = monitoring?.status;
    const accessMode = monitoring?.accessMode ?? monitoring?.access_mode;
    const monitoringMode = monitoring?.monitoringMode ?? monitoring?.monitoring_mode;
    const isConfiguredModel = accessMode === 'non_admin' || monitoringMode === 'existing';

    switch (status) {
        case 'ready':
            return { status: 'ready', label: 'Ready' };
        case 'external':
            return { status: 'external', label: 'External' };
        case 'installing':
            return { status: 'installing', label: 'Installing' };
        case 'progressing':
            return { status: 'progressing', label: 'Progressing' };
        case 'absent':
            return { status: 'absent', label: isConfiguredModel ? 'Not configured' : 'Not installed' };
        case 'degraded':
            return { status: 'degraded', label: 'Degraded' };
        case 'unreachable':
            return { status: 'unreachable', label: 'Unreachable' };
        case 'unsupported':
            return { status: 'inactive', label: 'Unsupported' };
        case 'failed':
            return { status: 'failed', label: 'Failed' };
        default:
            return { status: 'neutral', label: status || 'Unknown' };
    }
}

export function monitoringIsAbnormal(monitoring) {
    return ABNORMAL_MONITORING_STATUSES.has(monitoring?.status);
}

export function clusterHealthIsAbnormal(overviewPayload) {
    if (!overviewPayload) return null;
    const kubernetes = overviewPayload.kubernetes || {};
    const components = kubernetes.components || {};
    if (kubernetes.monitoringRequired) {
        return monitoringIsAbnormal(components.monitoring);
    }

    const nodes = kubernetes.nodes || [];
    const hardware = kubernetes.hardware || {};
    const nodesReady = nodes.filter((node) => node.ready).length;
    const nodesTotal = nodes.length;
    const readyNodes = nodes.filter((node) => node.ready);
    const actualCpuCores = readyNodes.reduce((sum, node) => sum + (node.cpu || 0), 0);
    const actualMemoryBytes = readyNodes.reduce((sum, node) => sum + (node.memoryBytes || 0), 0);
    const actualGpuCount = readyNodes.reduce((sum, node) => sum + (node.gpuCount || 0), 0);
    const underProvisioned = (actual, planned) => planned > 0 && actual < planned - 1e-6;
    const diskUsagePercent = hardware.diskUsagePercent;
    const diskDegraded = typeof diskUsagePercent === 'number' && diskUsagePercent >= 75;

    return Boolean(
        nodesReady < nodesTotal
        || underProvisioned(actualCpuCores, hardware.cpuCores ?? 0)
        || underProvisioned(actualMemoryBytes, hardware.memoryBytes ?? 0)
        || underProvisioned(actualGpuCount, hardware.gpuCount ?? 0)
        || diskDegraded
        || (components.intelDevicePlugin?.installed && components.intelDevicePlugin.status !== 'ready')
        || monitoringIsAbnormal(components.monitoring),
    );
}

export function monitoringCardDisplay(monitoring, cluster) {
    const hasExplicitCounts = monitoring?.ready !== undefined && monitoring?.desired !== undefined;
    const fallbackSummary = Array.isArray(monitoring?.components) && monitoring.components.length > 0
        ? summarizeMonitoringComponents(monitoring.components)
        : null;
    const ready = hasExplicitCounts ? (monitoring.ready ?? 0) : (fallbackSummary?.ready ?? monitoring?.ready ?? 0);
    const desired = hasExplicitCounts ? (monitoring.desired ?? 0) : (fallbackSummary?.desired ?? monitoring?.desired ?? 0);

    const hideDenominator = monitoring?.status === 'unsupported'
        || (monitoring?.status === 'unreachable' && desired === 0);
    const value = hideDenominator ? '—' : ready;
    const unit = hideDenominator ? '' : `/ ${desired}`;

    const { isNonAdmin, isExisting, hasKnownRoleOrMode } = resolveRoleAndMode(monitoring, cluster);
    let detail = monitoring?.message || '';
    if (monitoring?.status !== 'unsupported' && hasKnownRoleOrMode) {
        if (isNonAdmin) {
            detail = isExisting ? 'Non-admin · Prometheus HTTP (existing)' : 'Non-admin · Prometheus HTTP (managed)';
        } else {
            detail = isExisting ? 'Admin · Prometheus HTTP (existing)' : 'Admin · K8s stack (managed)';
        }
    }

    return { value, unit, detail };
}

export function describeMonitoringNotice({
    monitoring,
    cluster,
    monitoringRequired = false,
    kubernetesNotice = '',
    telemetrySource = 'kubernetes',
    prometheusReachable = false,
} = {}) {
    const status = monitoring?.status;
    const { affected } = summarizeMonitoringComponents(monitoring?.components);
    const affectedComponents = affected.map((component) => formatComponentName(component.name)).filter(Boolean);

    if (monitoringRequired) {
        if (ABNORMAL_MONITORING_STATUSES.has(status)) {
            return {
                tone: 'danger',
                title: 'Monitoring endpoint is unreachable',
                message: 'Open Observability to click Reinstall for an Orchestration administrator repair script (or update external URLs via Edit cluster on the Clusters page), then click Re-check.',
                affectedComponents,
            };
        }
        return {
            tone: 'info',
            title: 'Monitoring required for cluster-wide telemetry',
            message: kubernetesNotice
                || 'Open Observability to click Install for an Orchestration administrator setup script (or configure external URLs via Edit cluster on the Clusters page), then click Re-check.',
            affectedComponents,
        };
    }

    if (kubernetesNotice) {
        return {
            tone: 'warning',
            title: telemetrySource === 'prometheus' && prometheusReachable
                ? 'Prometheus telemetry notice'
                : 'Cluster telemetry notice',
            message: kubernetesNotice,
            affectedComponents,
        };
    }

    if (!NOTICE_MONITORING_STATUSES.has(status)) {
        return null;
    }

    const { isNonAdmin, isExisting } = resolveRoleAndMode(monitoring, cluster);

    if (isExisting) {
        if (status === 'absent') {
            return {
                tone: 'warning',
                title: 'Existing monitoring endpoints are not configured',
                message: 'Configure external Prometheus and optional Grafana URLs via Edit cluster on the Clusters page, then click Re-check in Observability.',
                affectedComponents,
            };
        }
        if (status === 'degraded') {
            return {
                tone: 'danger',
                title: 'Existing monitoring stack is degraded',
                message: 'Update external Prometheus and optional Grafana URLs via Edit cluster on the Clusters page, then click Re-check in Observability to inspect component diagnostics.',
                affectedComponents,
            };
        }
        return {
            tone: 'danger',
            title: status === 'failed' ? 'Existing monitoring stack failed' : 'Existing monitoring endpoints are unreachable',
            message: 'Update external Prometheus and optional Grafana URLs via Edit cluster on the Clusters page, then click Re-check in Observability.',
            affectedComponents,
        };
    }

    if (isNonAdmin) {
        if (status === 'absent') {
            return {
                tone: 'info',
                title: 'Monitoring stack is not installed',
                message: 'Open Observability and click Install to run the Orchestration administrator setup script (or configure external URLs via Edit cluster on the Clusters page), then click Re-check.',
                affectedComponents,
            };
        }
        if (status === 'degraded') {
            return {
                tone: 'danger',
                title: 'Monitoring stack is degraded',
                message: 'Open Observability and click Reinstall to run the Orchestration administrator repair script (or update external URLs via Edit cluster on the Clusters page), then click Re-check.',
                affectedComponents,
            };
        }
        return {
            tone: 'danger',
            title: status === 'failed' ? 'Monitoring stack failed' : 'Monitoring stack is unreachable',
            message: 'Open Observability and click Reinstall to run the Orchestration administrator repair script (or update external URLs via Edit cluster on the Clusters page), then click Re-check.',
            affectedComponents,
        };
    }

    if (status === 'absent') {
        return {
            tone: 'info',
            title: 'Observability stack is not installed',
            message: 'Open Observability and click Install to install the monitoring stack.',
            affectedComponents,
        };
    }
    if (status === 'degraded') {
        return {
            tone: 'danger',
            title: 'Observability stack is degraded',
            message: 'Open Observability to inspect component diagnostics or click Reinstall to reinstall the monitoring stack.',
            affectedComponents,
        };
    }
    return {
        tone: 'danger',
        title: status === 'failed' ? 'Observability stack failed' : 'Observability stack is unreachable',
        message: 'Open Observability and click Re-check to verify cluster connectivity and monitoring status.',
        affectedComponents,
    };
}
