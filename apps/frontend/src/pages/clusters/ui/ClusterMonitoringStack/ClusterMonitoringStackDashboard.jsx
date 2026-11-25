// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useMonitoringOperation } from './useMonitoringOperation';
import {
    DEFAULT_MONITORING_NAMESPACE,
    openMonitoringLink,
    resolveClusterMonitoringNamespace,
    resolveEffectiveMonitoringNamespace,
    resolveMonitoringNamespaceOverride,
} from './monitoringLinks';
import { requestMonitoringJson } from '../../../../shared/api/monitoringClient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    AlertOctagon,
    Boxes,
    CheckCircle2,
    CloudCog,
    Cpu,
    RefreshCw,
    Rocket,
    ShieldCheck,
    Webcam,
    X,
} from 'lucide-react';
import {
    Badge,
    Button,
    RefreshButton,
    EmptyState,
    Input,
    Label,
    LoadingState,
    Modal,
    SectionLabel,
    Select,
    Spinner,
    ModuleHeader,
    ModulePage,
    Panel,
} from '../../../../shared/ui';
import { FormError } from '../../../../shared/ui/FormError';
import { cn } from '../../../../shared/lib/cn';
import { AcceleratorObservabilityPanel, GrafanaLogo, PrometheusLogo } from './AcceleratorObservabilityPanel';
import { DeploymentObservabilityPanel } from './DeploymentObservabilityPanel';
import { DeploymentProfilingPanel } from './DeploymentProfilingPanel';
import { ClusterStackComponentTable } from './ClusterStackComponentTable';
import { ClusterStackOperationProgress, MonitoringAdminScriptPanel } from './ClusterStackOperationProgress';
import { ClusterStackSummary } from './ClusterStackSummary';
import { InstallClusterStackModal } from './InstallClusterStackModal';
import {
    getNonAdminClusterStackAction,
    isOptionalAbsentComponent,
    summarizeMonitoringComponents,
} from './preflightPresentation';
import {
    getClusterStackAdminScript,
    getClusterStackLinks,
    getClusterStackOperation,
    recheckClusterStack,
} from './clusterMonitoringStackBackend';
import { useClusterMonitoringStackStatus } from './useClusterMonitoringStackStatus';

const SERVICE_TABS = [
    { value: 'cluster', label: 'Cluster', icon: CloudCog },
    { value: 'accelerator', label: 'Accelerators', icon: Cpu },
    { value: 'deployment', label: 'Deployments', icon: Rocket },
];

export default function ClusterMonitoringStackDashboard({ onToggleMobileNav, initialClusterId, initialProfileDeployment }) {
    const [namespaceInput, setNamespaceInput] = useState(DEFAULT_MONITORING_NAMESPACE);
    const [namespaceOverride, setNamespaceOverride] = useState(null);
    const [clusters, setClusters] = useState([]);
    const [clustersLoaded, setClustersLoaded] = useState(false);
    const [clusterId, setClusterId] = useState('');
    const [clustersError, setClustersError] = useState(null);
    const [installOpen, setInstallOpen] = useState(false);
    const [reinstallMode, setReinstallMode] = useState(false);
    const [activeServiceTab, setActiveServiceTab] = useState('cluster');
    const [profilingDeployment, setProfilingDeployment] = useState(null);
    const [operation, setOperation] = useState(null);
    const [operationError, setOperationError] = useState(null);
    const [installSuccess, setInstallSuccess] = useState(null);
    const [completedOperationId, setCompletedOperationId] = useState(null);
    const [openingLink, setOpeningLink] = useState(null);
    const [linksError, setLinksError] = useState(null);

    const [adminScriptModalOpen, setAdminScriptModalOpen] = useState(false);
    const [adminScriptAction, setAdminScriptAction] = useState('install');
    const [adminScript, setAdminScript] = useState(null);
    const [adminScriptMeta, setAdminScriptMeta] = useState(null);
    const [adminScriptLoading, setAdminScriptLoading] = useState(false);
    const [adminScriptError, setAdminScriptError] = useState('');
    const [adminScriptNotice, setAdminScriptNotice] = useState('');
    const [recheckError, setRecheckError] = useState('');
    const [rechecking, setRechecking] = useState(false);
    const adminScriptAbortRef = useRef(null);
    const recheckContextEpochRef = useRef(0);

    const selectedCluster = clusters.find((cluster) => cluster.id === clusterId) || null;
    const clusterDefaultNamespace = resolveClusterMonitoringNamespace(selectedCluster);
    const effectiveNamespace = resolveEffectiveMonitoringNamespace({
        clusterId,
        selectedCluster,
        namespaceOverride,
    });
    const statusEnabled = clustersLoaded && Boolean(clusterId) && Boolean(selectedCluster);
    const status = useClusterMonitoringStackStatus(effectiveNamespace, clusterId, { enabled: statusEnabled });
    const refreshStatus = status.refresh;
    const snapshot = status.data;
    const snapshotOperationId = snapshot?.active_operation_id;
    const operationId = operation?.operation_id
        || (snapshotOperationId !== completedOperationId ? snapshotOperationId : null);
    const hasSnapshotSettings = Boolean(snapshot?.monitoring_mode);
    const effectiveMonitoringMode = ((hasSnapshotSettings ? snapshot.monitoring_mode : selectedCluster?.monitoringMode) || 'managed') === 'existing'
        ? 'existing'
        : 'managed';
    const effectivePrometheusUrl = (hasSnapshotSettings ? snapshot.prometheus_url : selectedCluster?.prometheusUrl) || '';
    const effectiveGrafanaUrl = (hasSnapshotSettings ? snapshot.grafana_url : selectedCluster?.grafanaUrl) || '';
    const effectivePrometheusNodePort = (hasSnapshotSettings ? snapshot.prometheus_node_port : selectedCluster?.prometheusNodePort) ?? null;
    const effectiveGrafanaNodePort = (hasSnapshotSettings ? snapshot.grafana_node_port : selectedCluster?.grafanaNodePort) ?? null;

    useEffect(() => {
        if (initialProfileDeployment) {
            setActiveServiceTab('deployment');
            setProfilingDeployment(initialProfileDeployment);
        }
    }, [initialProfileDeployment]);

    useEffect(() => {
        setNamespaceInput(effectiveNamespace);
    }, [clusterId, effectiveNamespace]);

    useEffect(() => {
        if (
            namespaceOverride
            && (namespaceOverride.clusterId !== clusterId || namespaceOverride.value === clusterDefaultNamespace)
        ) {
            setNamespaceOverride(null);
        }
    }, [clusterId, clusterDefaultNamespace, namespaceOverride]);

    const loadClusters = useCallback(async ({ isCancelled } = {}) => {
        try {
            const payload = await requestMonitoringJson('/api/cluster/clusters');
            if (isCancelled?.()) return null;
            const ready = (payload?.items || []).filter((cluster) => cluster.ready);
            setClusters(ready);
            setClustersError(null);
            if (ready.length === 0) {
                setClusterId('');
            } else {
                setClusterId((current) => {
                    if (current && ready.some((cluster) => cluster.id === current)) return current;
                    if (initialClusterId && ready.some((cluster) => cluster.id === initialClusterId)) return initialClusterId;
                    return ready[0].id;
                });
            }
            setClustersLoaded(true);
            return ready;
        } catch (error) {
            if (isCancelled?.()) return null;
            setClusters([]);
            setClusterId('');
            setClustersError(error);
            setClustersLoaded(true);
            return [];
        }
    }, [initialClusterId]);

    useMonitoringOperation({
        operationId,
        operationStatus: operation?.status,
        completedOperationId,
        namespace: effectiveNamespace,
        loadOperation: getClusterStackOperation,
        refreshStatus,
        onSucceeded: loadClusters,
        setOperation,
        setOperationError,
        setCompletedOperationId,
        setInstallSuccess,
    });

    useEffect(() => {
        if (!installSuccess) return undefined;
        const timer = window.setTimeout(() => setInstallSuccess(null), 10000);
        return () => window.clearTimeout(timer);
    }, [installSuccess]);

    useEffect(() => {
        let cancelled = false;
        loadClusters({ isCancelled: () => cancelled });
        return () => { cancelled = true; };
    }, [loadClusters]);

    const resetAdminScriptContext = useCallback(() => {
        recheckContextEpochRef.current += 1;
        adminScriptAbortRef.current?.abort();
        adminScriptAbortRef.current = null;
        setAdminScriptModalOpen(false);
        setAdminScript(null);
        setAdminScriptMeta(null);
        setAdminScriptLoading(false);
        setAdminScriptError('');
        setAdminScriptNotice('');
        setRecheckError('');
        setRechecking(false);
    }, []);

    useEffect(() => {
        resetAdminScriptContext();
    }, [clusterId, resetAdminScriptContext]);

    useEffect(() => {
        setAdminScriptMeta(null);
    }, [effectiveNamespace, snapshot?.monitoring_mode]);

    useEffect(() => () => {
        recheckContextEpochRef.current += 1;
        adminScriptAbortRef.current?.abort();
    }, []);

    const handleClusterChange = (nextClusterId) => {
        setClusterId(nextClusterId);
        setNamespaceOverride(null);
        setOperation(null);
        setOperationError(null);
        setInstallSuccess(null);
        setCompletedOperationId(null);
        setLinksError(null);
    };

    const applyNamespace = (event) => {
        event.preventDefault();
        const nextOverride = resolveMonitoringNamespaceOverride({
            clusterId,
            inputValue: namespaceInput,
            selectedCluster,
        });
        const nextNamespace = resolveEffectiveMonitoringNamespace({
            clusterId,
            selectedCluster,
            namespaceOverride: nextOverride,
        });
        setNamespaceOverride(nextOverride);
        setNamespaceInput(nextNamespace);
        if (nextNamespace !== effectiveNamespace) {
            resetAdminScriptContext();
            setOperation(null);
            setOperationError(null);
            setInstallSuccess(null);
            setCompletedOperationId(null);
        } else {
            refreshStatus();
        }
    };

    const openClusterLink = async (kind) => {
        setOpeningLink(kind);
        setLinksError(null);
        try {
            const payload = await getClusterStackLinks(effectiveNamespace, { clusterId });
            openMonitoringLink(payload, kind);
        } catch (error) {
            setLinksError(error.message || `Unable to open ${kind} dashboard`);
        } finally {
            setOpeningLink(null);
        }
    };

    const startOperation = (nextOperation) => {
        const nextOpNamespace = typeof nextOperation?.namespace === 'string'
            ? nextOperation.namespace.trim()
            : '';
        const namespaceChanged = Boolean(nextOpNamespace && nextOpNamespace !== effectiveNamespace);
        if (nextOpNamespace && clusterId) {
            setNamespaceOverride(resolveMonitoringNamespaceOverride({
                clusterId,
                inputValue: nextOpNamespace,
                selectedCluster,
            }));
            setNamespaceInput(nextOpNamespace);
        }
        if (namespaceChanged) {
            resetAdminScriptContext();
        }
        setOperation(nextOperation);
        setOperationError(null);
        setInstallSuccess(null);
        setCompletedOperationId(null);
        if (!namespaceChanged) {
            refreshStatus();
        }
    };

    const openInstall = () => {
        setReinstallMode(false);
        setInstallOpen(true);
    };
    const openReinstall = () => {
        setReinstallMode(true);
        setInstallOpen(true);
    };

    const handleGenerateAdminScript = async ({ mode } = {}) => {
        if (!clusterId) return;
        adminScriptAbortRef.current?.abort();
        const controller = new AbortController();
        adminScriptAbortRef.current = controller;
        const effectiveMode = mode || effectiveMonitoringMode;
        const targetNamespace = effectiveNamespace;
        setAdminScriptLoading(true);
        setAdminScriptError('');
        try {
            const payload = await getClusterStackAdminScript({
                namespace: targetNamespace,
                mode: effectiveMode,
                includeAccelerators: true,
                clusterId,
                signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            setAdminScript(payload);
            setAdminScriptMeta({ clusterId, namespace: targetNamespace, mode: effectiveMode });
        } catch (error) {
            if (error?.name === 'AbortError' || controller.signal.aborted) return;
            setAdminScriptError(error?.message || 'Unable to generate Orchestration administrator script');
        } finally {
            if (adminScriptAbortRef.current === controller) {
                setAdminScriptLoading(false);
                adminScriptAbortRef.current = null;
            }
        }
    };

    const openAdminScriptModal = (action = 'install') => {
        setAdminScriptAction(action);
        setAdminScriptModalOpen(true);
        setAdminScriptNotice('');
        setAdminScriptError('');
        setRecheckError('');
        const effectiveMode = effectiveMonitoringMode;
        const cacheMatches = Boolean(
            adminScript?.script
            && adminScriptMeta?.clusterId === clusterId
            && adminScriptMeta?.namespace === effectiveNamespace
            && adminScriptMeta?.mode === effectiveMode,
        );
        if (!cacheMatches) {
            setAdminScript(null);
            handleGenerateAdminScript({ mode: effectiveMode });
        }
    };

    const closeAdminScriptModal = () => {
        if (rechecking) return;
        adminScriptAbortRef.current?.abort();
        adminScriptAbortRef.current = null;
        setAdminScriptLoading(false);
        setAdminScriptModalOpen(false);
        setAdminScriptNotice('');
    };

    const handleRecheck = async ({ fromModal = false } = {}) => {
        if (!clusterId) return;
        const requestEpoch = recheckContextEpochRef.current;
        const targetClusterId = clusterId;
        const targetNamespace = effectiveNamespace;
        setRechecking(true);
        setAdminScriptError('');
        setRecheckError('');
        setAdminScriptNotice('');
        try {
            const recheckSnapshot = await recheckClusterStack(targetNamespace, { clusterId: targetClusterId });
            if (recheckContextEpochRef.current !== requestEpoch) return;
            const updatedClusters = await loadClusters();
            if (recheckContextEpochRef.current !== requestEpoch) return;
            const updatedCluster = updatedClusters?.find((cluster) => cluster.id === targetClusterId) || null;
            const activeOverride = recheckSnapshot?.marker_found ? null : namespaceOverride;
            if (recheckSnapshot?.marker_found && namespaceOverride?.clusterId === targetClusterId) {
                setNamespaceOverride(null);
            }
            const nextNamespace = resolveEffectiveMonitoringNamespace({
                clusterId: targetClusterId,
                selectedCluster: updatedCluster,
                namespaceOverride: activeOverride,
            });
            const latestStatus = await refreshStatus(nextNamespace);
            if (recheckContextEpochRef.current !== requestEpoch) return;
            const effectiveSnapshot = latestStatus || recheckSnapshot;
            if (fromModal) {
                if (effectiveSnapshot?.status === 'ready' && getNonAdminClusterStackAction(effectiveSnapshot) === null) {
                    setAdminScriptModalOpen(false);
                    setAdminScriptNotice('');
                } else {
                    const remaining = summarizeMonitoringComponents(effectiveSnapshot?.components)
                        .affected
                        .map((component) => String(component.name || '').replace(/_/g, ' ').trim())
                        .filter(Boolean);
                    const statusText = effectiveSnapshot?.status || 'unknown';
                    setAdminScriptNotice(
                        remaining.length > 0
                            ? `Cluster monitoring status is still ${statusText} (affected: ${remaining.join(', ')}). Confirm the Orchestration administrator script completed, then click Re-check.`
                            : `Cluster monitoring status is still ${statusText}. Confirm the Orchestration administrator script completed, then click Re-check.`,
                    );
                }
            }
        } catch (error) {
            if (recheckContextEpochRef.current !== requestEpoch) return;
            const message = error?.message || 'Unable to re-check cluster monitoring status';
            if (fromModal) {
                setAdminScriptError(message);
            } else {
                setRecheckError(message);
            }
        } finally {
            if (recheckContextEpochRef.current === requestEpoch) {
                setRechecking(false);
            }
        }
    };

    const context = snapshot?.cluster?.context || 'Current kube context';
    const isUnreachable = snapshot?.status === 'unreachable' || snapshot?.cluster?.reachable === false;
    const isNonAdmin = snapshot?.access_mode === 'non_admin';
    const isExistingMode = snapshot?.monitoring_mode === 'existing';
    const canManage = Boolean(snapshot) && snapshot.can_manage !== false && !isNonAdmin && !isUnreachable;
    const canManageManagedStack = canManage && !isExistingMode;
    const nonAdminStackAction = getNonAdminClusterStackAction(snapshot);
    const nonAdminStackLabel = nonAdminStackAction === 'reinstall' ? 'Reinstall' : 'Install';

    const unhealthyStack = snapshot && ['absent', 'degraded', 'unreachable', 'unsupported'].includes(snapshot.status);
    const unhealthyDetails = snapshot?.components
        ?.filter((component) => ['degraded', 'missing'].includes(component.status) && !isOptionalAbsentComponent(component))
        .map((component) => String(component.name || '').replace(/_/g, ' '))
        .filter(Boolean) || [];
    const isWarningTone = snapshot?.status === 'absent' || snapshot?.status === 'unsupported';

    return (
        <ModulePage className="observability-page" contentClassName="flex flex-col gap-3 lg:py-6">
                <ModuleHeader
                    icon={Webcam}
                    title="Observability"
                    description="Install and monitor the cluster observability stack powering metrics, dashboards, and accelerator profiling."
                    onToggleMobileNav={onToggleMobileNav}
                />
                <Panel padding="none" className="shadow-none">
                    <div className="flex items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
                        <div
                            className="flex min-w-0 flex-wrap items-center gap-1"
                            role="tablist"
                            aria-label="Observability service"
                        >
                            {SERVICE_TABS.map((tab) => {
                                const active = tab.value === activeServiceTab;
                                const Icon = tab.icon;
                                return (
                                    <button
                                        key={tab.value}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        onClick={() => setActiveServiceTab(tab.value)}
                                        className={cn(
                                            'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50',
                                            active
                                                ? 'observability-service-tab-active bg-sky-500/20 text-white shadow-[0_0_18px_rgba(56,189,248,0.18)] ring-1 ring-sky-400/30'
                                                : 'text-theme-muted hover:bg-theme-bg hover:text-theme-text',
                                        )}
                                    >
                                        <Icon className="h-4 w-4 shrink-0" />
                                        {tab.label}
                                    </button>
                                );
                            })}
                        </div>

                        <RefreshButton onClick={refreshStatus} disabled={status.loading} refreshing={status.loading} label="Refresh observability status" />
                    </div>
                    <div className={cn(
                        'grid items-start gap-4 p-4',
                        activeServiceTab === 'cluster' && clusterId
                            ? 'md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]'
                            : 'max-w-sm',
                    )}>
                            <div className="min-w-0">
                                <Label htmlFor="observability-cluster" className="mb-2 block">Target cluster</Label>
                                <Select
                                    id="observability-cluster"
                                    aria-label="Target cluster"
                                    value={clusterId}
                                    onChange={(event) => handleClusterChange(event.target.value)}
                                    disabled={clusters.length === 0}
                                    className="h-9 w-full min-w-0 py-1 text-xs"
                                >
                                    {clusters.length === 0 && <option value="">{clustersLoaded ? 'No ready clusters' : 'Loading clusters…'}</option>}
                                    {clusters.map((cluster) => (
                                        <option key={cluster.id} value={cluster.id}>
                                            {cluster.name || cluster.id}
                                        </option>
                                    ))}
                                </Select>
                                <span className="mt-2 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-theme-muted" title={context}>
                                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{context}</span>
                                </span>
                                {clustersError && (
                                    <p className="mt-2 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300/90">
                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                        {clustersError.message || 'Unable to load clusters'}
                                    </p>
                                )}
                            </div>
                {activeServiceTab === 'cluster' && clusterId && (
                <>
                        <form onSubmit={applyNamespace} className="min-w-0">
                            <Label htmlFor="monitoring-namespace" className="mb-2 block">Namespace</Label>
                            <div className="flex min-w-0 items-center gap-2">
                                <Input
                                    id="monitoring-namespace"
                                    value={namespaceInput}
                                    onChange={(event) => setNamespaceInput(event.target.value)}
                                    placeholder={clusterDefaultNamespace}
                                    className="h-9 min-w-0 flex-1 py-1 text-xs"
                                />
                                <Button type="submit" variant="secondary" size="sm" className="h-9 shrink-0">Inspect</Button>
                            </div>
                        </form>
                        <div className="min-w-0">
                            <Label className="mb-2 block">GUIs</Label>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9"
                                    onClick={() => openClusterLink('prometheus')}
                                    isLoading={openingLink === 'prometheus'}
                                    disabled={openingLink !== null}
                                >
                                    <PrometheusLogo className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" /> Prometheus
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9"
                                    onClick={() => openClusterLink('grafana')}
                                    isLoading={openingLink === 'grafana'}
                                    disabled={openingLink !== null}
                                >
                                    <GrafanaLogo className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /> Grafana
                                </Button>
                            </div>
                                {linksError && (
                                    <span className="mt-2 flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300/90">
                                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                                        {linksError}
                                    </span>
                                )}
                        </div>
                </>
                )}
                    </div>
                </Panel>

                {activeServiceTab === 'cluster' && (
                    !clustersLoaded && !clusterId ? (
                        <LoadingState label="Discovering observability infrastructure…" />
                    ) : !clusterId ? (
                        <section className="relative overflow-hidden rounded-2xl border border-theme-border bg-theme-card p-5 shadow-xl dark:border-slate-800/80 dark:bg-gradient-to-br dark:from-slate-900/80 dark:via-slate-900/40 dark:to-slate-950/90">
                            <div className="relative">
                                <div className="mb-4">
                                    <SectionLabel tone="sky">Cluster infrastructure</SectionLabel>
                                </div>
                                <EmptyState
                                    icon={<Boxes className="h-10 w-10" />}
                                    title="No ready cluster selected"
                                    message="Cluster infrastructure observability requires a ready Kubernetes cluster. No status is shown until a ready cluster is available."
                                />
                            </div>
                        </section>
                    ) : (
                    <>
                {status.error && (
                    <div
                        role="alert"
                        aria-live="assertive"
                        className="relative overflow-hidden rounded-xl border border-red-500/40 bg-red-50 p-4 shadow-sm dark:bg-gradient-to-r dark:from-red-950/70 dark:via-red-950/40 dark:to-slate-950"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/15">
                                    <AlertOctagon className="h-5 w-5 text-red-600 dark:text-red-300" />
                                </span>
                                <div>
                                    <div className="text-sm font-bold text-red-900 dark:text-red-200">Observability service is not responding normally</div>
                                    <p className="mt-1 text-xs leading-relaxed text-red-700 dark:text-red-200/75">
                                        {status.error.message}
                                        {snapshot && ' The last successful snapshot is shown below and may be stale.'}
                                    </p>
                                </div>
                            </div>
                            <Button variant="secondary" size="sm" onClick={refreshStatus} isLoading={status.loading}>
                                <RefreshCw className="h-3.5 w-3.5" /> Retry
                            </Button>
                        </div>
                    </div>
                )}

                {installSuccess && (
                    <div
                        role="status"
                        aria-live="polite"
                        className="relative overflow-hidden rounded-xl border border-emerald-500/35 bg-emerald-50 p-4 shadow-sm dark:bg-gradient-to-r dark:from-emerald-950/70 dark:via-emerald-950/30 dark:to-slate-950"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-start gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/15">
                                    <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
                                </span>
                                <div>
                                    <div className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                                        Cluster observability stack installed successfully
                                    </div>
                                    <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-200/70">
                                        Prometheus and Grafana in <span className="font-mono">{installSuccess.namespace}</span> passed readiness verification.
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setInstallSuccess(null)}
                                className="rounded-lg p-1.5 text-emerald-600/70 transition-colors hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-300/60 dark:hover:text-emerald-200"
                                aria-label="Dismiss installation success message"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                )}

                {unhealthyStack && !status.error && (
                    <div
                        role="alert"
                        aria-live="polite"
                        className={cn(
                            'relative overflow-hidden rounded-xl border border-theme-border bg-theme-card p-4 shadow-xl dark:bg-slate-950',
                            isWarningTone
                                ? 'dark:border-amber-500/35 dark:bg-gradient-to-r dark:from-amber-950/60 dark:via-amber-950/25 dark:to-slate-950'
                                : 'dark:border-red-500/40 dark:bg-gradient-to-r dark:from-red-950/70 dark:via-red-950/35 dark:to-slate-950',
                        )}
                    >
                        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                            <div className="flex items-start gap-3">
                                <span
                                    className={cn(
                                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                                        isWarningTone
                                            ? 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/15'
                                            : 'border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/15',
                                    )}
                                >
                                    <AlertTriangle
                                        className={cn(
                                            'h-5 w-5',
                                            isWarningTone
                                                ? 'text-amber-600 dark:text-amber-300'
                                                : 'text-red-600 dark:text-red-300',
                                        )}
                                    />
                                </span>
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-bold text-theme-text dark:text-white">Observability stack is not fully operational</span>
                                        <Badge
                                            tone={isWarningTone ? 'warning' : 'danger'}
                                            size="xs"
                                        >
                                            {snapshot.status}
                                        </Badge>
                                        {isNonAdmin && <Badge tone="info" size="xs">Non-admin access</Badge>}
                                    </div>
                                    <p className="mt-1 text-xs leading-relaxed text-theme-muted dark:text-slate-300">{snapshot.message}</p>
                                    {unhealthyDetails.length > 0 && (
                                        <p className="mt-1 text-[10px] text-theme-muted">
                                            Affected components: {unhealthyDetails.join(', ')}
                                        </p>
                                    )}
                                </div>
                            </div>
                            {canManageManagedStack && snapshot.status === 'absent' && !operationId ? (
                                <Button variant="sky" size="sm" onClick={openInstall}>
                                    Install stack
                                </Button>
                            ) : canManageManagedStack && snapshot.status === 'degraded' && !operationId ? (
                                <Button variant="sky" size="sm" onClick={openReinstall}>
                                    Reinstall
                                </Button>
                            ) : isNonAdmin || isExistingMode ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    {nonAdminStackAction && (
                                        <Button
                                            variant="sky"
                                            size="sm"
                                            onClick={() => openAdminScriptModal(nonAdminStackAction)}
                                        >
                                            {nonAdminStackLabel}
                                        </Button>
                                    )}
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => handleRecheck()}
                                        disabled={rechecking || status.loading}
                                    >
                                        {rechecking ? <Spinner size="xs" /> : <RefreshCw className="h-3.5 w-3.5" />} Re-check
                                    </Button>
                                </div>
                            ) : (
                                <Button variant="secondary" size="sm" onClick={refreshStatus} isLoading={status.loading}>
                                    <RefreshCw className="h-3.5 w-3.5" /> Recheck
                                </Button>
                            )}
                        </div>
                        {!adminScriptModalOpen && recheckError && (
                            <div className="mt-3">
                                <FormError message={recheckError} />
                            </div>
                        )}
                    </div>
                )}

                {status.loading && !snapshot ? (
                    <LoadingState label="Discovering observability infrastructure…" />
                ) : snapshot ? (
                    <>
                        {isNonAdmin && (
                            <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-theme-text">
                                <div className="space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold">Limited Kubernetes permissions</span>
                                        <Badge tone="info" size="xs">Non-admin access</Badge>
                                    </div>
                                    <p className="max-w-[78ch] leading-relaxed text-theme-muted">
                                        Cluster-wide Helm and CRD discovery are disabled for this kubeconfig. Component health below is probed via Prometheus and Grafana HTTP endpoints. Use Install / Reinstall when needed to generate an Orchestration administrator script, or update external monitoring URLs via Edit cluster on the Clusters page, then click Re-check.
                                    </p>
                                </div>
                            </div>
                        )}

                        <ClusterStackSummary snapshot={snapshot} namespace={effectiveNamespace} />
                        {canManageManagedStack && (
                            <ClusterStackOperationProgress
                                operation={operation}
                                error={operationError}
                                onRetryPreflight={snapshot.status === 'absent' ? openInstall : null}
                            />
                        )}
                        <ClusterStackComponentTable
                            components={snapshot.components}
                            actions={canManageManagedStack && snapshot.status === 'ready' && !operationId ? (
                                <Button variant="sky" size="sm" onClick={openReinstall}>
                                    <RefreshCw className="h-3.5 w-3.5" /> Reinstall
                                </Button>
                            ) : !unhealthyStack && nonAdminStackAction ? (
                                <Button
                                    variant="sky"
                                    size="sm"
                                    onClick={() => openAdminScriptModal(nonAdminStackAction)}
                                >
                                    <RefreshCw className="h-3.5 w-3.5" /> {nonAdminStackLabel}
                                </Button>
                            ) : null}
                        />

                        {(isNonAdmin || effectiveMonitoringMode === 'existing') && (
                            <Panel
                                padding="sm"
                                className="border-theme-border bg-theme-card shadow-none"
                                title="Monitoring endpoints"
                                actions={(
                                    <Badge tone={effectiveMonitoringMode === 'existing' ? 'info' : 'neutral'} size="xs">
                                        {effectiveMonitoringMode === 'existing' ? 'Existing' : 'Managed'}
                                    </Badge>
                                )}
                            >
                                <div className="space-y-3">
                                    <dl className="grid gap-3 sm:grid-cols-3">
                                        <div className="min-w-0 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2">
                                            <dt className="text-[11px] font-medium text-theme-muted">Monitoring mode</dt>
                                            <dd className="mt-1 text-xs font-medium text-theme-text">
                                                {effectiveMonitoringMode === 'existing'
                                                    ? 'Existing (External Prometheus / Grafana)'
                                                    : 'Managed (Lens monitoring stack)'}
                                            </dd>
                                        </div>
                                        <div className="min-w-0 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2">
                                            <dt className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-medium text-theme-muted">
                                                <span>Prometheus endpoint</span>
                                                {effectiveMonitoringMode === 'managed' && effectivePrometheusNodePort != null && (
                                                    <Badge tone="neutral" size="xs">
                                                        NodePort {effectivePrometheusNodePort}
                                                    </Badge>
                                                )}
                                            </dt>
                                            <dd className={cn(
                                                'mt-1 break-all font-mono text-xs',
                                                effectivePrometheusUrl ? 'text-theme-text' : 'text-theme-muted',
                                            )}>
                                                {effectivePrometheusUrl || 'Not configured'}
                                            </dd>
                                        </div>
                                        <div className="min-w-0 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2">
                                            <dt className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-medium text-theme-muted">
                                                <span>Grafana endpoint</span>
                                                {effectiveMonitoringMode === 'managed' && effectiveGrafanaNodePort != null && (
                                                    <Badge tone="neutral" size="xs">
                                                        NodePort {effectiveGrafanaNodePort}
                                                    </Badge>
                                                )}
                                            </dt>
                                            <dd className={cn(
                                                'mt-1 break-all font-mono text-xs',
                                                effectiveGrafanaUrl ? 'text-theme-text' : 'text-theme-muted',
                                            )}>
                                                {effectiveGrafanaUrl || 'Not configured'}
                                            </dd>
                                        </div>
                                    </dl>
                                    <p className="text-xs leading-relaxed text-theme-muted">
                                        {effectiveMonitoringMode === 'existing'
                                            ? 'External Prometheus and Grafana URLs are configured via Edit cluster on the Clusters page. Click Re-check after updating them to refresh status.'
                                            : 'Managed endpoints and NodePorts are discovered automatically during installation or Re-check. To switch to external endpoints, update monitoring settings via Edit cluster on the Clusters page.'}
                                    </p>
                                </div>
                            </Panel>
                        )}

                        {canManageManagedStack && snapshot.status === 'absent' && !operationId && (
                            <div className="relative overflow-hidden rounded-2xl border border-theme-border bg-theme-card p-2 shadow-xl dark:border-cyan-500/20 dark:bg-slate-950 dark:bg-gradient-to-br dark:from-cyan-950/40 dark:via-slate-900/80 dark:to-slate-950">
                                <EmptyState
                                    icon={<CloudCog className="h-10 w-10" />}
                                    title="Observability stack is not installed"
                                    message="Run mandatory preflight checks, review the installation plan, then install Prometheus and Grafana infrastructure."
                                    action={<Button variant="sky" onClick={openInstall}>Install observability stack</Button>}
                                />
                            </div>
                        )}

                        {canManageManagedStack && snapshot.status === 'degraded' && (
                            <div className="relative overflow-hidden rounded-2xl border border-theme-border bg-theme-card p-2 shadow-xl dark:border-amber-500/20 dark:bg-slate-950 dark:bg-gradient-to-br dark:from-amber-950/30 dark:via-slate-900/80 dark:to-slate-950">
                                <EmptyState
                                    icon={<AlertTriangle className="h-10 w-10" />}
                                    iconClassName="border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                                    title="Observability stack is degraded"
                                    message="Review component diagnostics, or reinstall the stack. Reinstalling removes the existing release and deletes stored metrics."
                                    action={<Button variant="sky" onClick={openReinstall}>Reinstall</Button>}
                                />
                            </div>
                        )}
                    </>
                ) : (
                    <div className="rounded-2xl border border-theme-border bg-theme-card dark:border-slate-800 dark:bg-slate-900/70">
                        <EmptyState
                            title="Cluster status unavailable"
                            message="Check access to the current Kubernetes context and try again."
                            action={<Button variant="outline" onClick={refreshStatus}>Retry</Button>}
                        />
                    </div>
                )}
                    </>
                    )
                )}

                {activeServiceTab === 'accelerator' && (
                    <AcceleratorObservabilityPanel
                        clusterId={clusterId}
                        monitoringNamespace={effectiveNamespace}
                        enabled={statusEnabled}
                        onMonitoringUpdated={loadClusters}
                    />
                )}

                {activeServiceTab === 'deployment' && (
                    profilingDeployment ? (
                        <DeploymentProfilingPanel
                            clusterId={clusterId}
                            monitoringNamespace={effectiveNamespace}
                            deployment={profilingDeployment}
                            onBack={() => setProfilingDeployment(null)}
                        />
                    ) : (
                        <DeploymentObservabilityPanel
                            clusterId={clusterId}
                            monitoringNamespace={effectiveNamespace}
                            onOpenProfiling={setProfilingDeployment}
                        />
                    )
                )}

            {canManageManagedStack && (
                <InstallClusterStackModal
                    isOpen={installOpen}
                    namespace={effectiveNamespace}
                    clusterId={clusterId}
                    reinstall={reinstallMode}
                    onClose={() => setInstallOpen(false)}
                    onOperationStarted={startOperation}
                />
            )}

            <Modal
                isOpen={isNonAdmin && adminScriptModalOpen}
                onClose={rechecking ? undefined : closeAdminScriptModal}
                title={adminScriptAction === 'reinstall'
                    ? 'Reinstall observability stack (Orchestration administrator)'
                    : 'Install observability stack (Orchestration administrator)'}
                subtitle={`Generate and run an idempotent Orchestration administrator script for namespace ${effectiveNamespace}, then click Re-check.`}
                size="lg"
                closeOnBackdrop={!rechecking}
                closeOnEscape={!rechecking}
                footer={(
                    <Button variant="secondary" size="sm" onClick={closeAdminScriptModal} disabled={rechecking}>
                        Close
                    </Button>
                )}
            >
                <MonitoringAdminScriptPanel
                    embedded
                    title="Orchestration administrator install / repair script"
                    description="Run this idempotent Orchestration administrator script to install or repair the monitoring stack in this namespace and record discovered NodePorts."
                    script={adminScript?.script || ''}
                    filename={adminScript?.filename || 'lens-cluster-monitoring-admin.sh'}
                    instructions={adminScript?.instructions}
                    warnings={adminScript?.warnings}
                    loading={adminScriptLoading}
                    rechecking={rechecking}
                    error={adminScriptError}
                    notice={adminScriptNotice}
                    onGenerate={() => handleGenerateAdminScript({ mode: effectiveMonitoringMode })}
                    onRecheck={() => handleRecheck({ fromModal: true })}
                    generateLabel="Generate Orchestration administrator script"
                    recheckLabel="Re-check"
                />
            </Modal>
        </ModulePage>
    );
}
