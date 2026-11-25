import { scaleBytes } from '../../../shared/lib/formatBytes';
import { requestJson } from '../../../shared/api/httpClient';
import { cn } from '../../../shared/lib/cn';
import { usePolling } from '../../../shared/lib/usePolling';
import { useResourceList } from '../../../shared/lib/useResourceList';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AlertCircle, Boxes, ChevronDown, ChevronUp, Cpu, Gpu, HardDrive, MemoryStick, MoreVertical, Network, Pencil, Plus, Rocket, Server, Trash2, Webcam } from 'lucide-react';
import { Badge, Button, EmptyState, Input, Label, Modal, Panel, SectionLabel, Select, Textarea, ModuleHeader, ModulePage } from '../../../shared/ui';
import { HelpTooltip } from '../../../shared/ui/FormControls';
import { FormError } from '../../../shared/ui/FormError';
import { CreateClusterWizard } from './CreateClusterWizard';
import { EditClusterModal } from './EditClusterModal';
import { deleteCluster, parseDeleteCleanupHandoff } from './clusterPermissionBackend';
import { CleanupHandoffPanel } from './PermissionHandoffPanel';
import { storePendingModelMarketCluster } from '../../model-market';
import { PermissionGate, useAuth } from '../../auth';
import { VIEW_PERMISSIONS } from '../../auth/permissions';
import {
    clusterHealthIsAbnormal,
    describeMonitoringNotice,
    monitoringCardDisplay,
    monitoringMetricStatus,
} from './ClusterMonitoringStack/preflightPresentation';

function request(path, options = {}) {
    return requestJson(path, { headers: { 'Content-Type': 'application/json' }, ...options });
}

function syncSession(payload) {
    if (payload?.sessionId && payload?.cluster?.id) {
        sessionStorage.setItem('prism_cluster_session_id', payload.sessionId);
        sessionStorage.setItem('prism_cluster_server_id', payload.cluster.id);
    } else {
        sessionStorage.removeItem('prism_cluster_session_id');
        sessionStorage.removeItem('prism_cluster_server_id');
    }
}

function formatBytes(bytes) {
    if (!bytes || Number.isNaN(Number(bytes))) return '0 B';
    const { value, unit } = scaleBytes(bytes);
    return `${value % 1 === 0 ? value : value.toFixed(1)} ${unit}`;
}

function formatUsagePercent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%` : '—';
}

function UtilizationBar({ capacity, value }) {
    const hasValue = typeof value === 'number' && Number.isFinite(value);
    const width = hasValue ? Math.min(100, Math.max(0, value)) : 0;
    return (
        <div className="min-w-[8rem]">
            <div className="flex items-center justify-between gap-2 text-xs font-medium text-theme-muted">
                <div className="min-w-0 truncate text-theme-text">{capacity}</div>
                <span className="shrink-0">{formatUsagePercent(value)}</span>
            </div>
            <div className="utilization-track mt-1 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-[width]"
                    style={{ width: `${width}%` }}
                />
            </div>
        </div>
    );
}

function formatCores(value) {
    if (value == null || Number.isNaN(Number(value))) return '0';
    const num = Number(value);
    return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

function formatThroughput(bytesPerSec) {
    if (bytesPerSec == null || Number.isNaN(Number(bytesPerSec))) return '—';
    const num = Number(bytesPerSec);
    if (num === 0) return '0 B/s';
    const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
    let val = num;
    let u = 0;
    while (val >= 1024 && u < units.length - 1) {
        val /= 1024;
        u += 1;
    }
    return `${val % 1 === 0 ? val : val.toFixed(1)} ${units[u]}`;
}

function getNodeGpus(node) {
    if (Array.isArray(node.gpus) && node.gpus.length > 0) {
        return node.gpus;
    }
    if (!node.gpu && !node.gpuCount) {
        return [];
    }
    const count = node.gpuCount || 1;
    const totalVram = node.vramBytes || 0;
    const vramPerGpu = count > 0 ? Math.floor(totalVram / count) : 0;
    const gpuUsage = typeof node.gpuUsagePercent === 'number' ? node.gpuUsagePercent : null;
    const vramUsage = typeof node.vramUsagePercent === 'number' ? node.vramUsagePercent : null;
    const fallbackModel = Object.values(node.gpuModelsByProfile || {})
        .flat()
        .find((value) => typeof value === 'string' && value.trim());

    return Array.from({ length: count }, (_, i) => {
        const computePct = gpuUsage === null ? null : Math.min(100, Math.max(0, gpuUsage));
        const vramUsed = vramUsage === null || vramPerGpu <= 0 ? null : Math.floor(vramPerGpu * (vramUsage / 100));

        return {
            id: `gpu-${i}`,
            index: i,
            name: `GPU #${i}`,
            model: fallbackModel || undefined,
            pciAddress: '',
            computeUsagePercent: computePct === null ? null : Math.round(computePct * 10) / 10,
            vramTotalBytes: vramPerGpu,
            vramUsedBytes: vramUsed,
            vramUsagePercent: vramUsed === null ? null : Math.round((vramPerGpu > 0 ? vramUsed / vramPerGpu : 0) * 100 * 10) / 10,
            vramReadThroughputBytes: null,
            vramWriteThroughputBytes: null,
            vramTotalThroughputBytes: null,
            vramBandwidthPercent: null,
        };
    });
}

function statusDotClass(status) {
    return {
        ready: 'bg-emerald-400',
        external: 'bg-sky-400',
        installing: 'bg-amber-400',
        progressing: 'bg-amber-400',
        pending: 'bg-amber-400',
        absent: 'bg-amber-400',
        degraded: 'bg-orange-400',
        unreachable: 'bg-red-400',
        failed: 'bg-red-400',
        inactive: 'bg-slate-500',
        neutral: 'bg-slate-500',
    }[status] || 'bg-slate-500';
}

function MetricStatusLabel({ status, label }) {
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-slate-400">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full motion-safe:animate-pulse [animation-duration:2.4s] ${statusDotClass(status)}`} aria-hidden="true" />
            {label}
        </span>
    );
}

function ClusterMetricCard({
    icon,
    title,
    value,
    unit,
    status,
    usagePercent,
    showUsageBar = false,
    detail,
    actionLabel,
    onClick,
    ariaLabel,
    titleTooltip,
}) {
    const hasUsage = typeof usagePercent === 'number' && Number.isFinite(usagePercent);
    const usageWidth = hasUsage ? Math.min(100, Math.max(0, usagePercent)) : 0;
    const interactive = typeof onClick === 'function';
    const handleKeyDown = (event) => {
        if (!interactive) return;
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick(event);
        }
    };
    return (
        <div
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            onClick={interactive ? onClick : undefined}
            onKeyDown={interactive ? handleKeyDown : undefined}
            aria-label={interactive ? (ariaLabel || title) : undefined}
            title={titleTooltip}
            className={cn(
                'flex h-full flex-col gap-3 rounded-xl border border-slate-700/60 bg-slate-800/60 p-4 text-left shadow-lg backdrop-blur-xl',
                interactive && 'cursor-pointer transition-colors hover:border-sky-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60',
            )}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-slate-400">
                    <span className="shrink-0 text-slate-400">{icon}</span>
                    <span className="truncate">{title}</span>
                </div>
                <MetricStatusLabel status={status.status} label={status.label} />
            </div>
            <h3 className="truncate text-3xl font-bold leading-none text-white">
                {value}
                {unit && <span className="ml-1 align-baseline text-sm font-semibold text-slate-400">{unit}</span>}
            </h3>
            {usagePercent !== undefined && (
                <div className="mt-auto space-y-1">
                    <p className="text-right text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        Usage {formatUsagePercent(usagePercent)}
                    </p>
                    {showUsageBar && (
                        <div className="utilization-track h-1.5 overflow-hidden rounded-full bg-slate-900/80">
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-[width]"
                                style={{ width: `${usageWidth}%` }}
                            />
                        </div>
                    )}
                </div>
            )}
            {(detail || actionLabel) && (
                <div className="mt-auto flex items-center justify-between gap-2 text-[11px] text-slate-400">
                    {detail ? <span className="truncate" title={detail}>{detail}</span> : <span />}
                    {actionLabel && (
                        <span className="shrink-0 font-medium text-sky-400">{actionLabel}</span>
                    )}
                </div>
            )}
        </div>
    );
}

export default function OptimizationClusterOverview({ onNavigate, onToggleMobileNav, initialClusterId = '', initialAction = '' }) {
    const { can, canView } = useAuth();
    const [selectedId, setSelectedId] = useState('');
    const [overview, setOverview] = useState(null);
    const [overviewByCluster, setOverviewByCluster] = useState({});
    const [expandedNodeName, setExpandedNodeName] = useState(null);
    const [error, setError] = useState('');
    const [showCreate, setShowCreate] = useState(false);
    const [openActions, setOpenActions] = useState(null);
    const [clusterSearch, setClusterSearch] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [deleteHandoff, setDeleteHandoff] = useState(null);
    const [confirmAdminCleanup, setConfirmAdminCleanup] = useState(false);
    const [editTarget, setEditTarget] = useState(null);
    const [selectedNodeNames, setSelectedNodeNames] = useState(() => new Set());
    const [maintenanceBusy, setMaintenanceBusy] = useState(false);
    const [maintenanceError, setMaintenanceError] = useState('');
    const [maintenanceConfirm, setMaintenanceConfirm] = useState(null);

    const preferredClusterId = useRef(initialClusterId || '');
    const handledInitialAction = useRef(false);
    const handledEditAction = useRef(false);
    const fetchClusters = useCallback(async ({ signal }) => {
        const payload = await request('/api/cluster/clusters', { signal });
        return payload.items || [];
    }, []);
    const selectAvailableCluster = useCallback((items) => {
        const preferredId = preferredClusterId.current;
        preferredClusterId.current = '';
        const ready = items.filter((cluster) => cluster.ready);
        setSelectedId((current) => {
            if (current && ready.some((cluster) => cluster.id === current)) return current;
            if (preferredId && items.some((cluster) => cluster.id === preferredId)) return preferredId;
            return ready[0]?.id || '';
        });
    }, []);
    const { items: clusters, loading: clustersLoading, error: clusterListError, load: refreshClusters } = useResourceList(fetchClusters, {
        onLoaded: selectAvailableCluster,
        errorFallback: 'Failed to load clusters',
        retainOnError: true,
    });
    usePolling(() => refreshClusters({ quiet: true }));

    useEffect(() => {
        if (!initialClusterId) return;
        preferredClusterId.current = initialClusterId;
        refreshClusters();
    }, [initialClusterId, refreshClusters]);

    useEffect(() => {
        if (initialAction !== 'create' || handledInitialAction.current || !can('cluster:cluster:create')) return;
        handledInitialAction.current = true;
        setShowCreate(true);
    }, [initialAction, can]);

    useEffect(() => {
        if (initialAction !== 'edit' || handledEditAction.current || !initialClusterId) return;
        const target = clusters.find((cluster) => cluster.id === initialClusterId);
        if (!target || !can('cluster:cluster:update')) return;
        handledEditAction.current = true;
        setEditTarget(target);
    }, [clusters, initialAction, initialClusterId, can]);

    const loadClusters = (preferredId = '') => {
        preferredClusterId.current = preferredId;
        return refreshClusters();
    };

    useEffect(() => {
        if (!selectedId) { setOverview(null); return undefined; }
        let cancelled = false;
        const poll = async () => {
            try {
                const payload = await request(`/api/cluster/overview?clusterId=${encodeURIComponent(selectedId)}`);
                if (!cancelled) {
                    setOverview(payload);
                    setError('');
                    setOverviewByCluster((current) => ({ ...current, [selectedId]: payload }));
                }
            } catch (nextError) {
                if (!cancelled) setError(nextError.message);
            }
        };
        poll();
        const interval = window.setInterval(poll, 5000);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [selectedId]);

    // Every *other* registered cluster's overview is also polled (at a
    // slower cadence, since it's only needed for the sidebar's status dot,
    // not the detailed panel) so that an unselected cluster's card reflects
    // its real health -- previously an unselected cluster always rendered
    // green regardless of its actual disk/CPU/memory/component state.
    const readyClusterIds = clusters.filter((cluster) => cluster.ready).map((cluster) => cluster.id).join(',');
    useEffect(() => {
        const ids = readyClusterIds ? readyClusterIds.split(',').filter((id) => id && id !== selectedId) : [];
        if (ids.length === 0) return undefined;
        let cancelled = false;
        const poll = async () => {
            const results = await Promise.allSettled(
                ids.map((id) => request(`/api/cluster/overview?clusterId=${encodeURIComponent(id)}`))
            );
            if (cancelled) return;
            setOverviewByCluster((current) => {
                const next = { ...current };
                results.forEach((result, index) => {
                    if (result.status === 'fulfilled') next[ids[index]] = result.value;
                });
                return next;
            });
        };
        poll();
        const interval = window.setInterval(poll, 10000);
        return () => { cancelled = true; window.clearInterval(interval); };
    }, [readyClusterIds, selectedId]);

    useEffect(() => {
        setSelectedNodeNames(new Set());
        setExpandedNodeName(null);
        setMaintenanceError('');
        setMaintenanceConfirm(null);
    }, [selectedId]);

    useEffect(() => {
        if (!selectedId) { syncSession(null); return undefined; }
        let cancelled = false;
        (async () => {
            try {
                const payload = await request(`/api/cluster/session?clusterId=${encodeURIComponent(selectedId)}`);
                if (!cancelled) syncSession(payload);
            } catch {
                if (!cancelled) syncSession(null);
            }
        })();
        return () => { cancelled = true; };
    }, [selectedId]);

    const resetDeleteState = () => {
        setDeleteError('');
        setDeleteHandoff(null);
        setConfirmAdminCleanup(false);
    };

    const confirmDelete = (cluster) => {
        setDeleteTarget(cluster);
        resetDeleteState();
    };

    const closeDeleteModal = () => {
        if (deleting) return;
        setDeleteTarget(null);
        resetDeleteState();
    };

    const submitDelete = async ({ forceConfirm = false } = {}) => {
        if (!deleteTarget || deleting) return;
        setDeleting(true);
        setDeleteError('');
        try {
            await deleteCluster(deleteTarget.id, {
                confirmAdminCleanup: Boolean(forceConfirm && confirmAdminCleanup),
            });
            setDeleteTarget(null);
            resetDeleteState();
            await loadClusters();
        } catch (nextError) {
            const handoff = parseDeleteCleanupHandoff(nextError);
            if (handoff) {
                const wasHandoff = deleteHandoff !== null;
                const digestChanged = deleteHandoff?.cleanupDigest !== handoff.cleanupDigest;
                setDeleteHandoff(handoff);
                if (digestChanged || (!handoff.confirmRequired && !handoff.unreachable)) {
                    setConfirmAdminCleanup(false);
                }
                if (wasHandoff && !forceConfirm) {
                    const markerStatus = handoff.marker?.status;
                    if (handoff.unreachable) {
                        setDeleteError('Cluster is still unreachable.');
                    } else if (markerStatus === 'missing') {
                        setDeleteError('Cleanup marker ConfigMap was not found yet. Ensure the Orchestration administrator ran the script, then try again.');
                    } else if (markerStatus === 'still_present') {
                        setDeleteError('Target cluster resources are still present. Run the Orchestration administrator cleanup script, then try again.');
                    }
                }
            } else {
                setDeleteError(nextError.message);
            }
        } finally {
            setDeleting(false);
        }
    };

    const openCreate = () => {
        setShowCreate(true);
    };

    const kubernetes = overview?.kubernetes || {};
    const components = kubernetes.components || {};
    const nodes = kubernetes.nodes || [];
    const hardware = kubernetes.hardware || {};
    const monitoringRequired = Boolean(kubernetes.monitoringRequired);
    const prometheusReachable = Boolean(kubernetes.prometheusReachable);
    const telemetrySource = kubernetes.telemetrySource || 'kubernetes';
    const kubernetesNotice = kubernetes.notice || '';
    const nodesReady = nodes.filter((node) => node.ready).length;
    const nodesTotal = nodes.length;
    const workerNodes = nodes.filter((node) => node.role === 'worker');
    const selectableWorkerNames = workerNodes.map((node) => node.name);
    const selectedWorkerNodes = workerNodes.filter((node) => selectedNodeNames.has(node.name));
    const allWorkersSelected = selectableWorkerNames.length > 0 && selectedWorkerNodes.length === selectableWorkerNames.length;
    const toggleNodeSelected = (name) => {
        setSelectedNodeNames((current) => {
            const next = new Set(current);
            if (next.has(name)) next.delete(name); else next.add(name);
            return next;
        });
    };
    const toggleAllWorkersSelected = () => {
        setSelectedNodeNames((current) => (
            current.size === selectableWorkerNames.length && selectableWorkerNames.every((name) => current.has(name))
                ? new Set()
                : new Set(selectableWorkerNames)
        ));
    };
    const requestNodeMaintenance = (disabled) => {
        if (!selectedWorkerNodes.length) return;
        setMaintenanceError('');
        setMaintenanceConfirm({ disabled, names: selectedWorkerNodes.map((node) => node.name) });
    };
    const confirmNodeMaintenance = async () => {
        if (!maintenanceConfirm) return;
        const { disabled, names } = maintenanceConfirm;
        setMaintenanceBusy(true);
        setMaintenanceError('');
        try {
            const payload = await request(
                `/api/cluster/clusters/${encodeURIComponent(selectedId)}/nodes/${disabled ? 'cordon' : 'uncordon'}`,
                { method: 'POST', body: JSON.stringify({ names }) },
            );
            const failures = (payload.items || []).filter((item) => !item.ok);
            if (failures.length) {
                setMaintenanceError(failures.map((item) => `${item.name}: ${item.error || 'failed'}`).join('; '));
            }
            setSelectedNodeNames(new Set());
            const refreshed = await request(`/api/cluster/overview?clusterId=${encodeURIComponent(selectedId)}`);
            setOverview(refreshed);
        } catch (nextError) {
            setMaintenanceError(nextError.message);
        } finally {
            setMaintenanceBusy(false);
            setMaintenanceConfirm(null);
        }
    };
    const workersMetric = nodesTotal === 0
        ? { status: 'absent', label: 'No workers' }
        : nodesReady === nodesTotal
            ? { status: 'ready', label: 'Ready' }
            : { status: 'degraded', label: 'Degraded' };
    // Hardware totals from the backend (`hardware.cpuCores`, etc.) sum every
    // *registered* worker node's capacity, including ones currently
    // NotReady/offline -- i.e. the cluster's "planned" capacity. The
    // "actual" capacity presently usable is the same sum restricted to
    // nodes that are `ready` right now, mirroring how the Workers card
    // already derives `nodesReady`/`nodesTotal` from the same `nodes` list.
    const readyNodes = nodes.filter((node) => node.ready);
    const actualCpuCores = readyNodes.reduce((sum, node) => sum + (node.cpu || 0), 0);
    const actualMemoryBytes = readyNodes.reduce((sum, node) => sum + (node.memoryBytes || 0), 0);
    const actualGpuCount = readyNodes.reduce((sum, node) => sum + (node.gpuCount || 0), 0);
    const actualVramBytes = readyNodes.reduce((sum, node) => sum + (node.vramBytes || 0), 0);
    // A card can only be "ready" (green) when the full planned capacity is
    // actually available right now; any shortfall (offline/NotReady nodes)
    // must read as degraded (red), same binary treatment as Workers.
    const capacityMetric = (actual, planned, { emptyStatus = 'absent', emptyLabel = 'Unavailable' } = {}) => {
        if (!(planned > 0)) return { status: emptyStatus, label: emptyLabel };
        if (actual >= planned - 1e-6) return { status: 'ready', label: 'Available' };
        return { status: 'degraded', label: 'Degraded' };
    };
    const cpuMetric = capacityMetric(actualCpuCores, hardware.cpuCores ?? 0);
    const memoryMetric = capacityMetric(actualMemoryBytes, hardware.memoryBytes ?? 0);
    const gpuMetric = (hardware.availableGpuCount ?? 0) > 0
        ? { status: 'ready', label: 'Available' }
        : { status: 'inactive', label: 'Allocated' };
    const vramMetric = actualVramBytes > 0
        ? { status: 'ready', label: 'Available' }
        : { status: 'inactive', label: 'Unknown' };
    // Disk is sourced directly from each node's kubelet (see backend
    // `_node_disk_usage`), independent of this cluster's own Prometheus, so
    // it stays reportable even when Prometheus itself is broken by a full
    // disk (the exact failure mode this metric exists to catch).
    const diskUsagePercent = hardware.diskUsagePercent;
    const diskMetric = typeof diskUsagePercent !== 'number'
        ? { status: 'inactive', label: 'Unknown' }
        : diskUsagePercent >= 90
            ? { status: 'unreachable', label: 'Critical' }
            : diskUsagePercent >= 75
                ? { status: 'degraded', label: 'High' }
                : { status: 'ready', label: 'Healthy' };
    const monitoringMetric = monitoringMetricStatus(components.monitoring);
    const cpuDisplay = { value: `${formatCores(actualCpuCores)} cores`, unit: `/ ${formatCores(hardware.cpuCores)} cores` };
    // Memory and Disk lead with the capacity still free, not the share already
    // taken -- the usage percentage stays on the card's usage line below. When
    // the backend cannot report free capacity (no usage reading), fall back to
    // the capacity that is online so the card never reads as fully free.
    const memoryAvailableBytes = hardware.memoryAvailableBytes;
    const memoryDisplay = typeof memoryAvailableBytes === 'number'
        ? { value: formatBytes(memoryAvailableBytes), unit: `free / ${formatBytes(hardware.memoryBytes)}` }
        : { value: formatBytes(actualMemoryBytes), unit: `/ ${formatBytes(hardware.memoryBytes)}` };
    const gpuDisplay = { value: hardware.availableGpuCount ?? 0, unit: `available / ${hardware.gpuCount ?? actualGpuCount} total` };
    const formattedVram = formatBytes(actualVramBytes).split(' ');
    const vramDisplay = { value: formattedVram[0] || '0', unit: formattedVram[1] || 'B' };
    // A hardware profile only reports the device metrics it configures, so hide
    // sections for metrics this cluster cannot report instead of showing 0.
    // An empty list (older payload / no GPU hardware) keeps everything visible.
    const deviceMetrics = new Set(hardware.deviceMetrics || []);
    const hasDeviceMetric = (key) => deviceMetrics.size === 0 || deviceMetrics.has(key);
    const showVramColumn = hasDeviceMetric('vramTotalBytes');
    const diskAvailableBytes = hardware.diskAvailableBytes;
    const diskDisplay = typeof diskAvailableBytes === 'number'
        ? { value: formatBytes(diskAvailableBytes), unit: `free / ${formatBytes(hardware.diskBytes)}` }
        : { value: '—', unit: 'unavailable' };
    const readyClusters = clusters.filter((cluster) => cluster.ready);
    const selectedCluster = readyClusters.find((cluster) => cluster.id === selectedId) || overview?.cluster || null;
    const searchQuery = clusterSearch.trim().toLowerCase();
    const filteredClusters = searchQuery
        ? clusters.filter((cluster) => (cluster.name || '').toLowerCase().includes(searchQuery))
        : clusters;
    const orderedClusters = [...filteredClusters].sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0));

    const canOpenObservability = canView('cluster-monitoring-stack');
    const monitoringDisplay = monitoringCardDisplay(components.monitoring, selectedCluster);
    const monitoringNotice = describeMonitoringNotice({
        monitoring: components.monitoring,
        cluster: selectedCluster,
        monitoringRequired,
        kubernetesNotice,
        telemetrySource,
        prometheusReachable,
    });

    const hasClusterAbnormality = Boolean(clusterHealthIsAbnormal(overview));

    const getClusterStatus = (cluster) => {
        if (!cluster?.ready) return 'failed';
        if (cluster.id === selectedId) {
            return hasClusterAbnormality ? 'degraded' : 'ready';
        }
        const abnormal = clusterHealthIsAbnormal(overviewByCluster[cluster.id]);
        return abnormal ? 'degraded' : 'ready';
    };

    const getClusterStatusLabel = (cluster) => {
        const status = getClusterStatus(cluster);
        if (status === 'degraded') return 'Degraded';
        if (status === 'failed') return 'Not ready';
        return 'Ready';
    };

    return (
        <ModulePage className="cluster-page">
                <ModuleHeader
                    icon={Network}
                    title="Clusters"
                    description="Register Kubernetes clusters and keep their connectivity, capacity, and readiness up to date."
                    onToggleMobileNav={onToggleMobileNav}
                />
                <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
                    <section className="min-w-0 space-y-6" aria-label="Cluster selection and management">
                        <Panel className="space-y-2 shadow-none">
                            <div className="flex items-center gap-2">
                                <Label htmlFor="overview-cluster" className="mb-0 text-xs font-normal text-theme-muted">
                                    Target cluster
                                </Label>
                                {selectedCluster?.description && <HelpTooltip label="Cluster description">{selectedCluster.description}</HelpTooltip>}
                            </div>
                                <Select
                                    id="overview-cluster"
                                    value={selectedId}
                                    onChange={(event) => setSelectedId(event.target.value)}
                                    disabled={!readyClusters.length}
                                    className="w-full min-w-0 text-sm"
                                >
                                    {!readyClusters.length && <option value="">No ready clusters</option>}
                                    {readyClusters.map((cluster) => (
                                        <option key={cluster.id} value={cluster.id}>{cluster.name || cluster.id}</option>
                                    ))}
                                </Select>
                                {selectedCluster?.vllmImage && (
                                    <div className="flex items-center justify-between gap-2 rounded-lg border border-theme-border bg-theme-bg/60 px-2.5 py-1.5 text-[11px]">
                                        <Badge tone="info" size="xs" className="shrink-0">Custom vLLM</Badge>
                                        <span className="min-w-0 truncate font-mono text-theme-text" title={selectedCluster.vllmImage}>
                                            {selectedCluster.vllmImage}
                                        </span>
                                    </div>
                                )}
                                <Button
                                    variant="sky"
                                    size="sm"
                                    className="w-full"
                                    disabled={!selectedId}
                                    onClick={() => {
                                        storePendingModelMarketCluster(selectedId);
                                        onNavigate?.('model-market');
                                    }}
                                >
                                    Deploy a model
                                </Button>
                                <PermissionGate permission="deployment:run:read">
                                    <Button variant="secondary" size="sm" className="w-full" disabled={!selectedId}
                                        title="View deployments in the selected cluster"
                                        aria-label="View deployments in the selected cluster"
                                        onClick={() => onNavigate?.('optimization-deployments', { clusterId: selectedId })}>
                                        <Rocket size={14} /><span>Deployments</span>
                                    </Button>
                                </PermissionGate>
                                <PermissionGate permission={VIEW_PERMISSIONS['admin/model-service']}>
                                    <Button variant="secondary" size="sm" className="w-full" disabled={!selectedId}
                                        title="View model services in the selected cluster"
                                        aria-label="View model services in the selected cluster"
                                        onClick={() => onNavigate?.('admin/model-service', { clusterId: selectedId })}>
                                        <Boxes size={14} /><span>Model services</span>
                                    </Button>
                                </PermissionGate>
                        </Panel>

                <Panel className="shadow-none">
                    <SectionLabel>{`Clusters (${clusters.length})`}</SectionLabel>
                            <div className="flex min-w-0 items-center gap-2">
                            <Input
                                value={clusterSearch}
                                onChange={(event) => setClusterSearch(event.target.value)}
                                placeholder="Search cluster name…"
                                aria-label="Search clusters by name"
                                className="h-8 min-w-0 flex-1 py-1 text-xs"
                            />
                            <Button variant="sky" size="sm" className="shrink-0" onClick={openCreate}><Plus size={14} />Add</Button>
                        </div>
                    <div className="mt-4">
                        {!clusters.length && !clustersLoading ? (
                            <EmptyState
                                icon={<Server size={28} />}
                                title="No clusters yet"
                                message="Upload a kubeconfig to manage your first cluster."
                                action={<Button variant="sky" size="sm" onClick={openCreate}><Plus size={14} />Add</Button>}
                            />
                        ) : !filteredClusters.length ? (
                            <p className="mt-4 rounded-xl border border-slate-800/60 bg-slate-950/40 px-5 py-6 text-center text-sm text-slate-500">
                                No clusters match “{clusterSearch.trim()}”.
                            </p>
                        ) : (
                            <div className="grid gap-2">
                                {orderedClusters.map((cluster) => {
                                    const isSelected = cluster.id === selectedId;
                                    return (
                                        <div
                                            key={cluster.id}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => setSelectedId(cluster.id)}
                                            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(cluster.id); } }}
                                            className={`cursor-pointer rounded-xl border transition-all p-3 ${isSelected ? 'bg-slate-800 border-cyan-500 shadow-md shadow-cyan-950/50 text-white' : 'bg-slate-950/50 border-slate-800/80 text-slate-300 hover:bg-slate-800/60 hover:border-slate-700'}`}
                                        >
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <span
                                                        className={`h-2 w-2 shrink-0 rounded-full motion-safe:animate-pulse [animation-duration:2.4s] ${statusDotClass(getClusterStatus(cluster))}`}
                                                        title={getClusterStatusLabel(cluster)}
                                                        aria-label={getClusterStatusLabel(cluster)}
                                                    />
                                                    <span className="font-bold text-xs font-sans text-slate-100 truncate" title={cluster.description || cluster.name}>{cluster.name}</span>
                                                </div>
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            const rect = event.currentTarget.getBoundingClientRect();
                                                            setOpenActions((current) => (current?.id === cluster.id ? null : { id: cluster.id, top: rect.bottom, right: window.innerWidth - rect.right }));
                                                        }}
                                                        className="inline-flex items-center justify-center rounded-lg border border-slate-700/70 bg-slate-900/40 p-1.5 text-slate-300 hover:bg-slate-800/60 transition-colors"
                                                        aria-haspopup="menu"
                                                        aria-expanded={openActions?.id === cluster.id}
                                                        aria-label="Actions"
                                                    >
                                                        <MoreVertical size={15} />
                                                    </button>
                                                    {openActions?.id === cluster.id && createPortal(
                                                        <>
                                                            <div className="fixed inset-0 z-[290]" onClick={() => setOpenActions(null)} />
                                                            <div
                                                                className="fixed z-[300] w-44 overflow-hidden rounded-lg border border-slate-700/70 bg-slate-900 shadow-xl"
                                                                style={{ top: openActions.top + 6, right: openActions.right }}
                                                                role="menu"
                                                            >
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => { setOpenActions(null); onNavigate?.('cluster-monitoring-stack', { clusterId: cluster.id }); }}
                                                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800 transition-colors"
                                                                >
                                                                    <Webcam size={14} className="shrink-0 text-cyan-400" />
                                                                    Observability
                                                                </button>
                                                                <div className="h-px bg-slate-700/70" />
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => { setOpenActions(null); setEditTarget(cluster); }}
                                                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800 transition-colors"
                                                                >
                                                                    <Pencil size={14} className="shrink-0 text-cyan-400" />
                                                                    Edit cluster
                                                                </button>
                                                                <div className="h-px bg-slate-700/70" />
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => { setOpenActions(null); confirmDelete(cluster); }}
                                                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-rose-400 hover:bg-rose-500/10 transition-colors"
                                                                >
                                                                    <Trash2 size={14} className="shrink-0 text-rose-400" />
                                                                    Delete cluster
                                                                </button>
                                                            </div>
                                                        </>,
                                                        document.body
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </Panel>
                    </section>
                    <div className="min-w-0 space-y-4">
                {(clusterListError || error) && (
                    <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm text-red-300 flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        <span>{clusterListError || error}</span>
                    </div>
                )}

                {selectedId && <>
                    {monitoringNotice && (
                        <div
                            role={monitoringNotice.tone === 'danger' ? 'alert' : 'status'}
                            className={cn(
                                'flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-5 py-4 text-sm',
                                monitoringNotice.tone === 'danger'
                                    ? 'border-red-500/35 bg-red-500/10 text-red-900 dark:text-red-200'
                                    : monitoringNotice.tone === 'warning'
                                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                                        : 'border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-200',
                            )}
                        >
                            <div className="flex min-w-0 items-start gap-2.5">
                                <Webcam
                                    className={cn(
                                        'mt-0.5 h-4 w-4 shrink-0',
                                        monitoringNotice.tone === 'danger'
                                            ? 'text-red-500 dark:text-red-400'
                                            : monitoringNotice.tone === 'warning'
                                                ? 'text-amber-500 dark:text-amber-400'
                                                : 'text-sky-500 dark:text-sky-400',
                                    )}
                                />
                                <div className="min-w-0 space-y-0.5">
                                    <p className="font-medium">{monitoringNotice.title}</p>
                                    <p className="text-xs opacity-90">{monitoringNotice.message}</p>
                                    {monitoringNotice.affectedComponents?.length > 0 && (
                                        <p className="text-[11px] opacity-80">
                                            Affected components: {monitoringNotice.affectedComponents.join(', ')}
                                        </p>
                                    )}
                                </div>
                            </div>
                            <PermissionGate permission={VIEW_PERMISSIONS['cluster-monitoring-stack']}>
                                <Button
                                    variant="sky"
                                    size="sm"
                                    className="shrink-0"
                                    onClick={() => onNavigate?.('cluster-monitoring-stack', { clusterId: selectedId })}
                                >
                                    <Webcam size={14} />
                                    <span>Open Observability</span>
                                </Button>
                            </PermissionGate>
                        </div>
                    )}
                    <section className="flex flex-col gap-3">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                            <ClusterMetricCard icon={<Server size={13} />} title="Workers" value={nodesReady} unit={`/ ${nodesTotal}`} status={workersMetric} />
                            <ClusterMetricCard icon={<Cpu size={13} />} title="CPU" value={cpuDisplay.value} unit={cpuDisplay.unit} status={cpuMetric} usagePercent={hardware.cpuUsagePercent} showUsageBar />
                            <ClusterMetricCard icon={<MemoryStick size={13} />} title="Memory" value={memoryDisplay.value} unit={memoryDisplay.unit} status={memoryMetric} usagePercent={hardware.memoryUsagePercent} showUsageBar />
                            <ClusterMetricCard icon={<Gpu size={13} />} title="Deployable GPU" value={gpuDisplay.value} unit={gpuDisplay.unit} status={gpuMetric} usagePercent={hardware.gpuUsagePercent} showUsageBar />
                            {hasDeviceMetric('vramTotalBytes') && (
                                <ClusterMetricCard icon={<MemoryStick size={13} />} title="VRAM" value={vramDisplay.value} unit={vramDisplay.unit} status={vramMetric} usagePercent={hardware.vramUsagePercent} showUsageBar />
                            )}
                            <ClusterMetricCard icon={<HardDrive size={13} />} title="Disk" value={diskDisplay.value} unit={diskDisplay.unit} status={diskMetric} usagePercent={diskUsagePercent} showUsageBar />
                            <ClusterMetricCard
                                icon={<Activity size={13} />}
                                title="Monitoring"
                                value={monitoringDisplay.value}
                                unit={monitoringDisplay.unit}
                                status={monitoringMetric}
                                detail={monitoringDisplay.detail}
                                actionLabel={canOpenObservability ? 'Open Observability' : undefined}
                                onClick={canOpenObservability ? () => onNavigate?.('cluster-monitoring-stack', { clusterId: selectedId }) : undefined}
                                ariaLabel={canOpenObservability ? 'Monitoring — Open Observability' : undefined}
                                titleTooltip={components.monitoring?.message || undefined}
                            />
                        </div>
                    </section>

                    <Panel padding="md" className="relative overflow-hidden rounded-2xl shadow-lg">
                        <div className="relative">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <SectionLabel tone="blue" uppercase={false} className="mb-0 text-sm font-semibold tracking-normal">
                                    {`Workers (${nodesTotal})`}
                                </SectionLabel>
                                {selectedWorkerNodes.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs text-theme-muted">{selectedWorkerNodes.length} selected</span>
                                        <Button variant="sky" size="sm" onClick={() => requestNodeMaintenance(true)} disabled={maintenanceBusy}>
                                            Enter maintenance mode
                                        </Button>
                                        <Button variant="sky" size="sm" onClick={() => requestNodeMaintenance(false)} disabled={maintenanceBusy}>
                                            Exit maintenance mode
                                        </Button>
                                    </div>
                                )}
                            </div>
                            {maintenanceError && <p className="mt-2 text-xs text-rose-600 dark:text-rose-300">{maintenanceError}</p>}
                            <div className="mt-2 overflow-x-auto rounded-xl border border-theme-border">
                                <table className="w-full min-w-[56rem] text-left text-sm">
                                    <thead className="bg-slate-50/80 text-theme-muted dark:bg-slate-950/60">
                                        <tr>
                                            <th className="w-10 px-5 py-3">
                                                <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 rounded border-theme-border bg-theme-card accent-sky-600 dark:accent-cyan-500"
                                                    checked={allWorkersSelected}
                                                    onChange={toggleAllWorkersSelected}
                                                    disabled={!selectableWorkerNames.length}
                                                    aria-label="Select all worker nodes"
                                                />
                                            </th>
                                            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Node</th>
                                            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">CPU</th>
                                            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Memory</th>
                                            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">GPU</th>
                                            {showVramColumn && (
                                                <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">VRAM</th>
                                            )}
                                            <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wider">Disk</th>
                                        </tr>
                                    </thead>
                                    <tbody className="workers-table-body divide-y divide-theme-border">
                                        {nodes.length === 0 && monitoringRequired && (
                                            <tr>
                                                <td colSpan={showVramColumn ? 7 : 6} className="px-5 py-6 text-center text-sm text-theme-muted">
                                                    <div className="flex flex-wrap items-center justify-center gap-3">
                                                        <span>
                                                            Node inventory requires Monitoring or cluster-wide permissions. Open Observability to enable or connect Monitoring.
                                                        </span>
                                                        <PermissionGate permission={VIEW_PERMISSIONS['cluster-monitoring-stack']}>
                                                            <Button
                                                                variant="sky"
                                                                size="sm"
                                                                onClick={() => onNavigate?.('cluster-monitoring-stack', { clusterId: selectedId })}
                                                            >
                                                                Open Observability
                                                            </Button>
                                                        </PermissionGate>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                        {nodes.map((node) => {
                                            const isExpanded = expandedNodeName === node.name;
                                            const nodeGpus = getNodeGpus(node);
                                            const gpuCount = node.gpuCount || nodeGpus.length;
                                            const isMaintenance = Boolean(node.schedulingDisabled);
                                            const gpuPanelId = `worker-gpus-${String(node.name || 'node').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                                            const toggleNodeExpanded = () => setExpandedNodeName((current) => (current === node.name ? null : node.name));
                                            const nodeFallbackModel = Object.values(node.gpuModelsByProfile || {})
                                                .flat()
                                                .find((value) => typeof value === 'string' && value.trim()) || '';
                                            return (
                                                <Fragment key={node.name}>
                                                    <tr
                                                        onClick={toggleNodeExpanded}
                                                        className={cn(
                                                            'cursor-pointer transition-colors',
                                                            isExpanded
                                                                ? 'bg-sky-500/5 dark:bg-slate-800/80'
                                                                : 'hover:bg-slate-500/5 dark:hover:bg-slate-800/40',
                                                        )}
                                                    >
                                                        <td className="w-10 px-5 py-3" onClick={(event) => event.stopPropagation()}>
                                                            {node.role === 'worker' && (
                                                                <input
                                                                    type="checkbox"
                                                                    className="h-3.5 w-3.5 rounded border-theme-border bg-theme-card accent-sky-600 dark:accent-cyan-500"
                                                                    checked={selectedNodeNames.has(node.name)}
                                                                    onChange={() => toggleNodeSelected(node.name)}
                                                                    aria-label={`Select ${node.name}`}
                                                                />
                                                            )}
                                                        </td>
                                                        <td className="px-5 py-3">
                                                            <div className="flex items-center gap-2">
                                                                <button
                                                                    type="button"
                                                                    onClick={(event) => {
                                                                        event.stopPropagation();
                                                                        toggleNodeExpanded();
                                                                    }}
                                                                    aria-expanded={isExpanded}
                                                                    aria-controls={gpuPanelId}
                                                                    aria-label={isExpanded ? `Collapse GPU details for ${node.name}` : `Expand GPU details for ${node.name}`}
                                                                    title={isExpanded ? 'Collapse GPU details' : 'Expand GPU details'}
                                                                    className={cn(
                                                                        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50',
                                                                        isExpanded
                                                                            ? 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:border-cyan-400/40 dark:bg-cyan-400/15 dark:text-cyan-300'
                                                                            : 'border-theme-border bg-theme-card text-theme-muted hover:border-sky-500/40 hover:text-theme-text dark:hover:border-cyan-400/40',
                                                                    )}
                                                                >
                                                                    {isExpanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                                                                </button>
                                                                <span
                                                                    className={cn(
                                                                        'h-1.5 w-1.5 shrink-0 rounded-full motion-safe:animate-pulse [animation-duration:2.4s]',
                                                                        statusDotClass(node.ready ? 'ready' : 'failed'),
                                                                    )}
                                                                    title={node.ready ? 'Ready' : 'Not ready'}
                                                                    aria-label={node.ready ? 'Ready' : 'Not ready'}
                                                                />
                                                                <span className="font-mono text-[15px] text-theme-text">{node.name}</span>
                                                                {isMaintenance && (
                                                                    <Badge tone="warning" size="xs" className="rounded-full">
                                                                        Maintenance
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </td>
                                                        <td className="px-5 py-3"><UtilizationBar capacity={`${formatCores(node.cpu)} cores`} value={node.cpuUsagePercent} /></td>
                                                        <td className="px-5 py-3"><UtilizationBar capacity={formatBytes(node.memoryBytes)} value={node.memoryUsagePercent} /></td>
                                                        <td className="px-5 py-3">
                                                            <UtilizationBar
                                                                capacity={gpuCount > 0 ? (
                                                                    <button
                                                                        type="button"
                                                                        onClick={(event) => {
                                                                            event.stopPropagation();
                                                                            toggleNodeExpanded();
                                                                        }}
                                                                        aria-expanded={isExpanded}
                                                                        aria-controls={gpuPanelId}
                                                                        aria-label={isExpanded ? `Hide ${gpuCount} GPU details on ${node.name}` : `Show ${gpuCount} GPU details on ${node.name}`}
                                                                        className={cn(
                                                                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50',
                                                                            isExpanded
                                                                                ? 'border-sky-500/50 bg-sky-500/15 text-sky-700 dark:border-cyan-400/50 dark:bg-cyan-400/15 dark:text-cyan-200'
                                                                                : 'border-sky-500/30 bg-sky-500/10 text-sky-700 hover:border-sky-500/50 hover:bg-sky-500/20 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-300 dark:hover:border-cyan-400/50 dark:hover:bg-cyan-400/20',
                                                                        )}
                                                                    >
                                                                        <Gpu size={11} aria-hidden="true" />
                                                                        <span>{gpuCount} {gpuCount === 1 ? 'GPU' : 'GPUs'}</span>
                                                                        {isExpanded ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
                                                                    </button>
                                                                ) : '—'}
                                                                value={node.gpuUsagePercent}
                                                            />
                                                        </td>
                                                        {showVramColumn && (
                                                            <td className="px-5 py-3"><UtilizationBar capacity={node.vramBytes > 0 ? formatBytes(node.vramBytes) : '—'} value={node.vramUsagePercent} /></td>
                                                        )}
                                                        <td className="px-5 py-3"><UtilizationBar capacity={node.diskBytes ? formatBytes(node.diskBytes) : '—'} value={node.diskUsagePercent} /></td>
                                                    </tr>
                                                    {isExpanded && (
                                                        <tr
                                                            id={gpuPanelId}
                                                            className="border-y border-sky-500/30 bg-theme-bg/70 dark:border-cyan-500/30 dark:bg-slate-950/90"
                                                        >
                                                            <td colSpan={showVramColumn ? 7 : 6} className="p-4">
                                                                <div className="space-y-4 rounded-xl border border-theme-border bg-theme-card p-4 shadow-sm">
                                                                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-theme-border pb-2.5">
                                                                        <div className="flex flex-wrap items-center gap-2">
                                                                            <Gpu className="text-sky-600 dark:text-cyan-400" size={16} aria-hidden="true" />
                                                                            <span className="text-xs font-semibold text-theme-text">
                                                                                GPU Accelerators on <code className="font-mono text-sky-700 dark:text-cyan-300">{node.name}</code>
                                                                            </span>
                                                                            <Badge tone="info" size="sm" className="rounded-full font-medium normal-case tracking-normal">
                                                                                {nodeGpus.length} {nodeGpus.length === 1 ? 'GPU' : 'GPUs'}
                                                                            </Badge>
                                                                        </div>
                                                                        <Button
                                                                            type="button"
                                                                            variant="ghost"
                                                                            size="xs"
                                                                            onClick={() => setExpandedNodeName(null)}
                                                                            aria-label={`Collapse GPU details for ${node.name}`}
                                                                        >
                                                                            <span>Collapse</span>
                                                                            <ChevronUp size={12} aria-hidden="true" />
                                                                        </Button>
                                                                    </div>

                                                                    {nodeGpus.length === 0 ? (
                                                                        <p className="py-4 text-center text-xs text-theme-muted">
                                                                            No GPU accelerators detected on this worker node.
                                                                        </p>
                                                                    ) : (
                                                                        <>
                                                                            {!node.ready && (
                                                                                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
                                                                                    This node is Not Ready (kubelet has stopped reporting status). The GPU
                                                                                    metrics below are the last values collected before contact was lost and
                                                                                    may be stale.
                                                                                </p>
                                                                            )}
                                                                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                                                                {nodeGpus.map((gpu, gpuIdx) => {
                                                                                    const gpuIndexLabel = typeof gpu.index === 'number' ? `GPU #${gpu.index}` : `GPU #${gpuIdx}`;
                                                                                    const gpuModelLabel = [gpu.model, gpu.name, nodeFallbackModel]
                                                                                        .map((val) => (typeof val === 'string' ? val.trim() : ''))
                                                                                        .filter(Boolean)
                                                                                        .find((val) => val.toLowerCase() !== gpuIndexLabel.toLowerCase()) || '';
                                                                                    const pciAddress = String(gpu.pciAddress || gpu.pciBdf || '').trim();

                                                                                    const hasCompute = typeof gpu.computeUsagePercent === 'number' && Number.isFinite(gpu.computeUsagePercent);
                                                                                    const showCompute = hasDeviceMetric('computeUsagePercent') || (hasCompute && gpu.computeUsagePercent > 0);

                                                                                    const vramTotal = typeof gpu.vramTotalBytes === 'number' && Number.isFinite(gpu.vramTotalBytes) ? gpu.vramTotalBytes : 0;
                                                                                    const hasVramUsed = typeof gpu.vramUsedBytes === 'number' && Number.isFinite(gpu.vramUsedBytes);
                                                                                    const effectiveVramPercent = typeof gpu.vramUsagePercent === 'number' && Number.isFinite(gpu.vramUsagePercent)
                                                                                        ? gpu.vramUsagePercent
                                                                                        : (vramTotal > 0 && hasVramUsed ? (gpu.vramUsedBytes / vramTotal) * 100 : null);
                                                                                    const hasVramPercent = typeof effectiveVramPercent === 'number' && Number.isFinite(effectiveVramPercent);
                                                                                    const showVram = hasDeviceMetric('vramTotalBytes') || vramTotal > 0 || hasVramUsed;

                                                                                    const hasBandwidthPct = typeof gpu.vramBandwidthPercent === 'number' && Number.isFinite(gpu.vramBandwidthPercent);
                                                                                    const hasTotalThroughput = typeof gpu.vramTotalThroughputBytes === 'number' && Number.isFinite(gpu.vramTotalThroughputBytes);
                                                                                    const hasReadThroughput = typeof gpu.vramReadThroughputBytes === 'number' && Number.isFinite(gpu.vramReadThroughputBytes);
                                                                                    const hasWriteThroughput = typeof gpu.vramWriteThroughputBytes === 'number' && Number.isFinite(gpu.vramWriteThroughputBytes);

                                                                                    const showBandwidthPct = hasDeviceMetric('vramBandwidthPercent') || (hasBandwidthPct && gpu.vramBandwidthPercent > 0);
                                                                                    const showTotalThroughput = hasDeviceMetric('vramTotalThroughputBytes') || (hasTotalThroughput && gpu.vramTotalThroughputBytes > 0);
                                                                                    const showReadThroughput = hasDeviceMetric('vramReadThroughputBytes') || (hasReadThroughput && gpu.vramReadThroughputBytes > 0);
                                                                                    const showWriteThroughput = hasDeviceMetric('vramWriteThroughputBytes') || (hasWriteThroughput && gpu.vramWriteThroughputBytes > 0);

                                                                                    const effectiveTotalThroughput = (showTotalThroughput && hasTotalThroughput)
                                                                                        ? gpu.vramTotalThroughputBytes
                                                                                        : (showReadThroughput || showWriteThroughput) && (hasReadThroughput || hasWriteThroughput)
                                                                                            ? (gpu.vramReadThroughputBytes || 0) + (gpu.vramWriteThroughputBytes || 0)
                                                                                            : null;
                                                                                    const showMemoryBandwidthSection = showBandwidthPct || showTotalThroughput || showReadThroughput || showWriteThroughput;

                                                                                    return (
                                                                                        <div
                                                                                            key={gpu.id || gpu.index || gpuIdx}
                                                                                            className="gpu-card flex flex-col gap-2.5 rounded-lg border border-theme-border bg-theme-bg/60 p-3 shadow-sm dark:bg-slate-950/80"
                                                                                        >
                                                                                            <div className="flex items-start justify-between gap-2 border-b border-theme-border pb-2">
                                                                                                <div className="min-w-0 space-y-0.5">
                                                                                                    <div className="flex min-w-0 items-center gap-1.5">
                                                                                                        <span
                                                                                                            className={cn(
                                                                                                                'h-2 w-2 shrink-0 rounded-full',
                                                                                                                node.ready ? 'bg-emerald-500 dark:bg-emerald-400 motion-safe:animate-pulse' : 'bg-slate-400 dark:bg-slate-600',
                                                                                                            )}
                                                                                                            title={node.ready ? 'Reporting' : 'Node not ready; metrics may be stale'}
                                                                                                            aria-hidden="true"
                                                                                                        />
                                                                                                        <span className="truncate text-xs font-bold text-theme-text">{gpuIndexLabel}</span>
                                                                                                    </div>
                                                                                                    {gpuModelLabel && (
                                                                                                        <p className="truncate text-[11px] font-medium text-theme-muted" title={gpuModelLabel}>
                                                                                                            {gpuModelLabel}
                                                                                                        </p>
                                                                                                    )}
                                                                                                </div>
                                                                                                <code className="shrink-0 font-mono text-[10px] text-theme-muted">{pciAddress || '—'}</code>
                                                                                            </div>

                                                                                            {showCompute && (
                                                                                                <div className="space-y-1">
                                                                                                    <div className="flex justify-between text-[11px]">
                                                                                                        <span className="text-theme-muted">Compute Utilization</span>
                                                                                                        <span className="font-semibold text-sky-700 dark:text-cyan-300">{formatUsagePercent(gpu.computeUsagePercent)}</span>
                                                                                                    </div>
                                                                                                    <div className="utilization-track h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                                                                        <div
                                                                                                            className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all"
                                                                                                            style={{ width: `${hasCompute ? Math.min(100, Math.max(0, gpu.computeUsagePercent)) : 0}%` }}
                                                                                                        />
                                                                                                    </div>
                                                                                                </div>
                                                                                            )}

                                                                                            {showVram && (
                                                                                                <div className="space-y-1">
                                                                                                    <div className="flex justify-between text-[11px]">
                                                                                                        <span className="text-theme-muted">VRAM Capacity</span>
                                                                                                        <span className="font-semibold text-violet-700 dark:text-purple-300">{formatUsagePercent(effectiveVramPercent)}</span>
                                                                                                    </div>
                                                                                                    <div className="utilization-track h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                                                                        <div
                                                                                                            className="h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-400 transition-all"
                                                                                                            style={{ width: `${hasVramPercent ? Math.min(100, Math.max(0, effectiveVramPercent)) : 0}%` }}
                                                                                                        />
                                                                                                    </div>
                                                                                                    <div className="text-right font-mono text-[10px] text-theme-muted">
                                                                                                        {hasVramUsed ? formatBytes(gpu.vramUsedBytes) : '—'} / {vramTotal > 0 ? formatBytes(vramTotal) : '—'}
                                                                                                    </div>
                                                                                                </div>
                                                                                            )}

                                                                                            {showMemoryBandwidthSection && (
                                                                                                <div className="space-y-1.5 border-t border-theme-border pt-1.5">
                                                                                                    {showBandwidthPct && (
                                                                                                        <div className="space-y-1">
                                                                                                            <div className="flex justify-between text-[11px]">
                                                                                                                <span className="text-theme-muted">VRAM Bandwidth</span>
                                                                                                                <span className="font-semibold text-emerald-700 dark:text-emerald-300">{formatUsagePercent(gpu.vramBandwidthPercent)}</span>
                                                                                                            </div>
                                                                                                            <div className="utilization-track h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                                                                                <div
                                                                                                                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-300 transition-all"
                                                                                                                    style={{ width: `${hasBandwidthPct ? Math.min(100, Math.max(0, gpu.vramBandwidthPercent)) : 0}%` }}
                                                                                                                />
                                                                                                            </div>
                                                                                                        </div>
                                                                                                    )}
                                                                                                    {(showTotalThroughput || effectiveTotalThroughput != null) && (
                                                                                                        <div className="flex items-center justify-between text-[10px] text-theme-muted">
                                                                                                            <span>Memory I/O</span>
                                                                                                            <span className="font-mono font-medium text-theme-text">
                                                                                                                {effectiveTotalThroughput != null ? formatThroughput(effectiveTotalThroughput) : '—'}
                                                                                                            </span>
                                                                                                        </div>
                                                                                                    )}
                                                                                                    {(showReadThroughput || showWriteThroughput) && (
                                                                                                        <div className="grid grid-cols-2 gap-1 text-[10px] text-theme-muted">
                                                                                                            {showReadThroughput && (
                                                                                                                <div>
                                                                                                                    Read: <span className="font-mono text-theme-text">{hasReadThroughput ? formatThroughput(gpu.vramReadThroughputBytes) : '—'}</span>
                                                                                                                </div>
                                                                                                            )}
                                                                                                            {showWriteThroughput && (
                                                                                                                <div>
                                                                                                                    Write: <span className="font-mono text-theme-text">{hasWriteThroughput ? formatThroughput(gpu.vramWriteThroughputBytes) : '—'}</span>
                                                                                                                </div>
                                                                                                            )}
                                                                                                        </div>
                                                                                                    )}
                                                                                                </div>
                                                                                            )}
                                                                                        </div>
                                                                                    );
                                                                                })}
                                                                            </div>
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            {!nodes.length && !monitoringRequired && <p className="px-5 py-5 text-sm text-theme-muted">No workers reported.</p>}
                        </div>
                    </Panel>

                </>}
                    </div>
                </div>

        {showCreate && (
            <CreateClusterWizard
                onClose={() => setShowCreate(false)}
                onCreated={(createdCluster) => {
                    setShowCreate(false);
                    loadClusters(createdCluster?.id);
                }}
            />
        )}

        {editTarget && (
            <EditClusterModal
                cluster={editTarget}
                onClose={() => setEditTarget(null)}
                onSaved={() => {
                    setEditTarget(null);
                    loadClusters(editTarget.id);
                }}
            />
        )}

            <Modal
                isOpen={!!deleteTarget}
                onClose={closeDeleteModal}
                title={deleteHandoff
                    ? (deleteHandoff.unreachable ? 'Cluster unreachable' : 'Orchestration administrator cleanup required')
                    : 'Delete cluster'}
                size={deleteHandoff ? 'lg' : 'sm'}
                footer={deleteHandoff ? (
                    <>
                        <Button variant="secondary" onClick={closeDeleteModal} disabled={deleting}>Close</Button>
                        <Button variant="sky" onClick={() => submitDelete({ forceConfirm: false })} isLoading={deleting}>
                            {deleteHandoff.unreachable ? 'Retry & Delete' : 'Re-check & Delete'}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button variant="secondary" onClick={closeDeleteModal} disabled={deleting}>Cancel</Button>
                        <Button variant="danger" onClick={() => submitDelete({ forceConfirm: false })} isLoading={deleting}>Delete</Button>
                    </>
                )}
            >
                {deleteHandoff ? (
                    <CleanupHandoffPanel
                        handoff={deleteHandoff}
                        confirmed={confirmAdminCleanup}
                        onConfirmChange={setConfirmAdminCleanup}
                        onConfirmDelete={() => submitDelete({ forceConfirm: true })}
                        busy={deleting}
                        error={deleteError}
                    />
                ) : (
                    <div className="space-y-3">
                        <p className="text-sm text-theme-muted">
                            Delete <span className="font-semibold text-theme-text">{deleteTarget?.name || deleteTarget?.id}</span>?
                            Its kubeconfig and metadata will be permanently removed.
                        </p>
                        <FormError message={deleteError} />
                    </div>
                )}
            </Modal>

            <Modal
                isOpen={!!maintenanceConfirm}
                onClose={() => !maintenanceBusy && setMaintenanceConfirm(null)}
                title={maintenanceConfirm?.disabled ? 'Enter maintenance mode' : 'Exit maintenance mode'}
                size="sm"
                footer={<>
                    <Button variant="secondary" onClick={() => setMaintenanceConfirm(null)} disabled={maintenanceBusy}>Cancel</Button>
                    <Button variant={maintenanceConfirm?.disabled ? 'danger' : 'primary'} onClick={confirmNodeMaintenance} isLoading={maintenanceBusy}>
                        {maintenanceConfirm?.disabled ? 'Cordon nodes' : 'Uncordon nodes'}
                    </Button>
                </>}
            >
                <div className="space-y-3">
                    <p className="text-sm text-slate-300">
                        {maintenanceConfirm?.disabled
                            ? 'The following worker nodes will stop receiving new Pods. Pods already running on them keep running until they finish or are rescheduled manually.'
                            : 'The following worker nodes will become schedulable again and may receive new Pods.'}
                    </p>
                    <ul className="max-h-32 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950/60 p-2 font-mono text-xs text-slate-200">
                        {(maintenanceConfirm?.names || []).map((name) => <li key={name}>{name}</li>)}
                    </ul>
                </div>
            </Modal>
        </ModulePage>
    );
}
