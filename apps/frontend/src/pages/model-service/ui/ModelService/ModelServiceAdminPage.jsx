import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../../../../shared/api/httpClient';
import { AlertTriangle, ArrowDown, Boxes, Check, CheckCircle2, ChevronRight, ClipboardCopy, Download, ListFilter, Loader2, Plus, RefreshCw, Repeat, RotateCcw, Search, ShieldAlert } from 'lucide-react';
import { usePolling } from '../../../../shared/lib/usePolling';
import { useResourceList } from '../../../../shared/lib/useResourceList';
import { useNotice } from '../../../../shared/lib/useNotice';
import { useSubmission } from '../../../../shared/lib/useSubmission';
import { useClipboard } from '../../../../shared/lib/useClipboard';
import { downloadBlob } from '../../../../shared/lib/download';
import { cn } from '../../../../shared/lib/cn';
import { errorMessage } from '../../../../shared/lib/errorMessage';
import { Button } from '../../../../shared/ui/Button';
import { Badge, StatusChip } from '../../../../shared/ui/Badge';
import { Input, Label, Select, Textarea } from '../../../../shared/ui/FormControls';
import { EmptyState } from '../../../../shared/ui/EmptyState';
import { FormError } from '../../../../shared/ui/FormError';
import { Panel } from '../../../../shared/ui/Panel';
import { Modal } from '../../../../shared/ui/Modal';
import { ModuleHeader } from '../../../../shared/ui/ModuleHeader';
import { ModulePage } from '../../../../shared/ui/ModulePage';
import { SectionLabel } from '../../../../shared/ui/SectionLabel';
import { Spinner } from '../../../../shared/ui/Spinner';
import { Toast } from '../../../../shared/ui/Toast';
import { PermissionGate, useAuth } from '../../../auth';
import {
    addModel,
    applyMutationHandoffResult,
    clusterHandoffMode,
    componentHandoffAction,
    deleteGroup,
    deleteMember,
    fetchClusterHandoff,
    generateGatewayRemediation,
    getGatewayIppConfig,
    getGatewayStatus,
    getModelAccess,
    grantModelAccess,
    performClusterBannerRecheck,
    performHandoffRecheck,
    performHandoffScriptRefresh,
    revokeModelAccess,
    listGroups,
    listMembers,
    listPublishableDeployments,
    streamComponentLogs,
    setGroupStatus,
    setGatewayIppConfig,
    reconcileGateway,
    streamGatewayOperation,
    updateGroup,
    updateMember,
    updateTrafficDistribution,
    setProvidersStatus,
} from './modelServiceBackend';
import { clusterCapabilities, DataPlaneTopology } from './DataPlaneTopology';
import { loadCluster, listLensHosts } from '../../../optimization';
import { ComponentLogViewer, GatewayOperationLogDrawer } from './GatewayOperationLogDrawer';
import { availableModelProviders, buildHandoffModalState, filterServiceFlow, memberIsRoutable, MAX_TRAFFIC_WEIGHT, trafficDistributionError, trafficShare, trafficTotal } from '../../model/modelService';
import { CARD } from './modelServiceStyles';


const STATUS_DOT = {
    active: 'bg-emerald-400',
    deployed: 'bg-emerald-400',
    ready: 'bg-emerald-400',
    running: 'bg-emerald-400',
    installed: 'bg-emerald-400',
    pending: 'bg-amber-400',
    missing: 'bg-amber-400',
    unhealthy: 'bg-rose-500',
    degraded: 'bg-amber-400',
    external: 'bg-cyan-400',
    unknown: 'bg-amber-400',
    stopped: 'bg-slate-500',
    standby: 'bg-slate-500',
    absent: 'bg-slate-500',
    disabled: 'bg-slate-500',
};

// Admin "Manage models": left picks a model service, right shows its members.
// Styling mirrors the clusters overview page.
export function ModelServiceAdminPage({ onToggleMobileNav, onNavigate, initialClusterId = '', initialGroupId = '', initialAction = '', initialExecutionId = '' }) {
    const { can } = useAuth();
    const [groups, setGroups] = useState([]);
    const [members, setMembers] = useState([]);
    const [deployments, setDeployments] = useState([]);
    const [status, setStatus] = useState({ clusters: [] });
    const [loaded, setLoaded] = useState(false);
    const [flowClusterId, setFlowClusterId] = useState(initialClusterId);
    const [flowModelQuery, setFlowModelQuery] = useState('');
    const [flowStatus, setFlowStatus] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useNotice(6000);
    const [modelOpen, setModelOpen] = useState(false);
    const [modelForm, setModelForm] = useState({ name: '', clusterId: '', executionId: '' });
    const [trafficDraft, setTrafficDraft] = useState(null);
    const [selectedGroupId, setSelectedGroupId] = useState('');
    const [detail, setDetail] = useState(null);
    const [serviceEdit, setServiceEdit] = useState(null);
    const [memberDelete, setMemberDelete] = useState(null);
    const [modelDelete, setModelDelete] = useState(null);
    const [accessGroup, setAccessGroup] = useState(null);
    const [ippConfigEdit, setIppConfigEdit] = useState(null);
    const [operationLog, setOperationLog] = useState(null);
    const [handoffModal, setHandoffModal] = useState(null);
    const [bannerRecheckingId, setBannerRecheckingId] = useState('');
    const [gatewayConfigCluster, setGatewayConfigCluster] = useState(null);
    const [logsTarget, setLogsTarget] = useState(null);
    const [logsLines, setLogsLines] = useState([]);
    const loadedOnceRef = useRef(false);
    const loadSeqRef = useRef(0);
    const focusedGroupId = useRef('');
    const focusedClusterScope = useRef('');
    const handledInitialAction = useRef(false);
    const memberGroups = groups
        .map((group) => {
            const groupMembers = members.filter((member) => member.groupId === group.id);
            const clusterIds = [...new Set([group.clusterId, ...groupMembers.map((member) => member.clusterId)].filter(Boolean))];
            return {
                id: group.id,
                name: group.name,
                status: group.status,
                clusters: clusterIds.map((clusterId) => ({
                    clusterId,
                    clusterName: status.clusters.find((cluster) => cluster.clusterId === clusterId)?.clusterName || clusterId,
                    deployments: groupMembers
                        .filter((member) => member.clusterId === clusterId)
                        .map((member) => ({
                            memberId: member.id,
                            clusterId: member.clusterId,
                            id: member.executionId,
                            name: deployments.find((item) => item.executionId === member.executionId)?.name || member.executionId,
                            status: member.status,
                            weight: member.weight,
                            endpointKind: member.endpointKind,
                            components: member.healthJson?.components || null,
                            poolName: member.poolName,
                            eppRef: member.eppRef,
                            routable: memberIsRoutable({
                                status: member.status,
                                weight: member.weight,
                                endpointKind: member.endpointKind,
                                components: member.healthJson?.components || {},
                            }),
                            namespace: member.targetNamespace,
                            targetService: member.targetService,
                            target: `${member.targetService}.${member.targetNamespace}:${member.targetPort}`,
                        })),
                })),
            };
        })
        .filter((group) => group.clusters.length > 0);
    const filteredFlow = filterServiceFlow(status.clusters, memberGroups, { clusterId: flowClusterId, modelQuery: flowModelQuery, status: flowStatus });
    const handoffClusters = filteredFlow.clusters.filter((cluster) => cluster.reconcileStatus === 'admin_handoff_required');
    const authErrorClusters = filteredFlow.clusters.filter((cluster) => Boolean(cluster.authError));
    const flowModelNames = [...new Set(memberGroups
        .filter((group) => (!flowStatus || group.status === flowStatus))
        .filter((group) => !flowClusterId || group.clusters.some((cluster) => cluster.clusterId === flowClusterId))
        .map((group) => group.name))].sort((a, b) => a.localeCompare(b));
    const hasFlowFilters = Boolean(flowClusterId || flowModelQuery || flowStatus);

    const load = useCallback(async () => {
        const seq = ++loadSeqRef.current;
        try {
            const snapshot = await fetchModelServiceAdminSnapshot();
            if (seq !== loadSeqRef.current) return;
            setGroups(snapshot.groups);
            setMembers(snapshot.members);
            setDeployments(snapshot.deployments);
            setStatus(snapshot.status);
            setError('');
        } catch (failure) {
            if (seq !== loadSeqRef.current) return;
            setError(failure?.message || 'Failed to load model services');
        } finally {
            if (seq === loadSeqRef.current) {
                loadedOnceRef.current = true;
                setLoaded(true);
            }
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    usePolling(() => load({ quiet: true }));
    useEffect(() => {
        if (groups.length === 0) return;
        if (!groups.some((group) => group.id === selectedGroupId)) {
            setSelectedGroupId(groups[0].id);
        }
    }, [groups, selectedGroupId]);

    useEffect(() => {
        if (!initialGroupId || focusedGroupId.current === initialGroupId) return;
        if (!groups.some((group) => group.id === initialGroupId)) return;
        focusedGroupId.current = initialGroupId;
        setSelectedGroupId(initialGroupId);
        const group = groups.find((item) => item.id === initialGroupId);
        if (group?.clusterId) setFlowClusterId(group.clusterId);
    }, [groups, initialGroupId]);

    useEffect(() => {
        if (!initialClusterId) return;
        setFlowClusterId(initialClusterId);
    }, [initialClusterId]);

    useEffect(() => {
        if (initialGroupId || !initialClusterId || groups.length === 0) return;
        if (focusedClusterScope.current === initialClusterId) return;
        const first = groups.find((group) => group.clusterId === initialClusterId);
        if (!first) return;
        focusedClusterScope.current = initialClusterId;
        setSelectedGroupId(first.id);
        setFlowClusterId(initialClusterId);
    }, [groups, initialClusterId, initialGroupId]);

    const modelSubmission = useSubmission('Failed to add model');
    const trafficSubmission = useSubmission('Failed to save and apply traffic distribution');
    const deleteSubmission = useSubmission('Failed to delete');
    const syncSubmission = useSubmission('Failed to sync data plane');
    const toggleSubmission = useSubmission('Failed to update member');
    const serviceEditSubmission = useSubmission('Failed to update model service');
    const serviceToggleSubmission = useSubmission('Failed to update model service');
    const ippConfigSubmission = useSubmission('Failed to save IPP config');
    const gatewaySubmission = useSubmission('Failed to install gateway');

    const openTrafficDistribution = (groupId) => {
        const group = groups.find((item) => item.id === groupId);
        if (!group) {
            setNotice('Model no longer exists. Refresh the page before editing traffic.');
            return;
        }
        const providers = members.filter((member) => member.groupId === groupId);
        trafficSubmission.setError('');
        setTrafficDraft({
            groupId, name: group.name, clusterId: group.clusterId,
            clusterName: status.clusters.find((cluster) => cluster.clusterId === group.clusterId)?.clusterName || group.clusterId,
            providerModel: group.servedName || group.modelRef,
            expectedWeights: Object.fromEntries(providers.map((member) => [member.executionId, member.weight])),
            rows: providers.map((member) => ({
                executionId: member.executionId,
                name: deployments.find((deployment) => deployment.executionId === member.executionId)?.name || member.executionId,
                status: member.status, weight: String(member.weight),
                endpointKind: member.endpointKind,
                components: member.healthJson?.components || null,
            })),
        });
    };

    const openHandoffPayload = (handoff, clusterId = '') => {
        if (!handoff) return;
        setHandoffModal(buildHandoffModalState(handoff, { clusterId, clusters: status.clusters }));
    };

    const openClusterHandoff = (cluster, mode = clusterHandoffMode(cluster), { persist = false } = {}) => syncSubmission.run(async () => {
        const payload = await fetchClusterHandoff(cluster, mode, { persist });
        openHandoffPayload(payload, cluster.clusterId);
    });

    const recheckHandoff = () => performHandoffRecheck({
        handoffModal,
        setHandoffModal,
        setStatus,
        setNotice,
        load,
    });

    const refreshHandoffScript = () => performHandoffScriptRefresh({
        handoffModal,
        setHandoffModal,
        setStatus,
    });

    const recheckClusterBanner = (cluster) => performClusterBannerRecheck(cluster, {
        bannerRecheckingId,
        setBannerRecheckingId,
        setHandoffModal,
        setStatus,
        setNotice,
        setError: syncSubmission.setError,
        load,
    });

    const submitTrafficDistribution = () => trafficSubmission.run(async () => {
        const validation = trafficDistributionError(trafficDraft.rows);
        if (validation) throw new Error(validation);
        const clusterId = trafficDraft.clusterId;
        const result = await updateTrafficDistribution(trafficDraft.groupId, {
            expectedWeights: trafficDraft.expectedWeights,
            members: trafficDraft.rows.map((row) => ({ executionId: row.executionId, weight: Number(row.weight) })),
        });
        setTrafficDraft({
            ...trafficDraft,
            expectedWeights: Object.fromEntries(result.items.map((member) => [member.executionId, member.weight])),
            rows: result.items.map((member) => ({
                executionId: member.executionId, status: member.status, weight: String(member.weight),
                name: trafficDraft.rows.find((row) => row.executionId === member.executionId)?.name || member.executionId,
                endpointKind: trafficDraft.rows.find((row) => row.executionId === member.executionId)?.endpointKind,
                components: trafficDraft.rows.find((row) => row.executionId === member.executionId)?.components,
            })),
        });
        await load({ quiet: true });
        if (result.reconcileStatus === 'admin_handoff_required') {
            setTrafficDraft(null);
            await applyMutationHandoffResult(result, {
                clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            setNotice('Traffic weights saved. Run the Orchestration administrator script to sync routes.');
            return;
        }
        if (result.operation.status !== 'succeeded') {
            throw new Error(`Configuration saved, but Gateway reconciliation failed: ${result.operation.message || 'See Reconcile logs.'}`);
        }
        await applyMutationHandoffResult(result, {
            clusterId,
            clusters: status.clusters,
            setHandoffModal,
            setStatus,
        });
        setTrafficDraft(null);
        setNotice('Traffic weights saved and submitted to the Gateway.');
    });

    const submitModel = () => modelSubmission.run(async () => {
        if (!modelForm.name.trim() || !selectedDeployment?.model) {
            throw new Error('Enter a public model name and select an available ready provider.');
        }
        const clusterId = modelForm.clusterId;
        const result = await addModel({
            name: modelForm.name.trim(),
            clusterId,
            executionId: selectedDeployment.executionId,
        });
        await load({ quiet: true });
        if (result.reconcileStatus === 'admin_handoff_required') {
            setModelOpen(false);
            setSelectedGroupId(result.group.id);
            await applyMutationHandoffResult(result, {
                clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            setNotice('Model saved. Run the Orchestration administrator script to apply routes in Kubernetes.');
            return;
        }
        if (result.operation && result.operation.status !== 'succeeded') {
            throw new Error(`Deployment added with weight ${result.weight}, but Gateway reconciliation failed: ${result.operation.message || 'Use Reconcile to retry.'}`);
        }
        await applyMutationHandoffResult(result, {
            clusterId,
            clusters: status.clusters,
            setHandoffModal,
            setStatus,
        });
        setModelOpen(false);
        setSelectedGroupId(result.group.id);
        setNotice(result.created
            ? 'Model added. The cluster gateway and model route will sync automatically.'
            : `Deployment added to ${result.group.name} with weight ${result.weight}. Use Traffic distribution to adjust its share.`);
    });

    const removeProvider = () => deleteSubmission.run(async () => {
        if (!memberDelete) return;
        const clusterId = memberDelete.clusterId;
        const result = await deleteMember(memberDelete.id);
        setMemberDelete(null);
        const outcome = await applyMutationHandoffResult(result, {
            clusterId,
            clusters: status.clusters,
            setHandoffModal,
            setStatus,
        });
        if (outcome === 'admin_handoff_required') {
            setNotice('Provider removed from model. Run the Orchestration administrator script to clean up routes.');
        } else {
            setNotice('Provider removed from model.');
        }
        await load({ quiet: true });
    });

    const removeModel = () => deleteSubmission.run(async () => {
        if (!modelDelete) return;
        const clusterId = modelDelete.clusterId;
        try {
            const result = await deleteGroup(modelDelete.id);
            setModelDelete(null);
            const outcome = await applyMutationHandoffResult(result, {
                clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            if (outcome === 'admin_handoff_required') {
                setNotice('Model record removed. Run the Orchestration administrator script to clean up Kubernetes routes.');
            } else {
                setNotice('Model removed. Its HTTPRoute and model mapping were safely cleaned up.');
            }
        } finally {
            await load({ quiet: true });
        }
    });

    const toggleAllProviders = (groupId, online) => toggleSubmission.run(async () => {
        setNotice('');
        serviceToggleSubmission.setError('');
        const group = groups.find((item) => item.id === groupId);
        try {
            const items = await setProvidersStatus(groupId, online ? 'active' : 'disabled');
            const outcome = await applyMutationHandoffResult(items, {
                clusterId: group?.clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            if (outcome === 'admin_handoff_required') {
                setNotice('Provider statuses updated. Run the Orchestration administrator script to sync routes.');
            } else {
                setNotice(online
                    ? 'All providers online. Weights and Pods are unchanged; stopped models remain stopped and weight 0 stays standby.'
                    : 'All providers offline. Weights, model state and running Pods are unchanged.');
            }
        } finally {
            await load({ quiet: true });
        }
    });

    const runGatewayOperation = (payloadOrList, title) => {
        const list = Array.isArray(payloadOrList) ? payloadOrList : [payloadOrList];
        setOperationLog({ title, status: 'running', lines: [], message: '' });
        const append = (line) => setOperationLog((prev) => (prev ? { ...prev, lines: [...prev.lines, line] } : prev));
        (async () => {
            let handoffPayload = null;
            let handoffClusterId = '';
            for (const payload of list) {
                await new Promise((resolve) => {
                    (payload.op === 'reconcile' ? reconcileGateway : streamGatewayOperation)(payload, (type, data) => {
                        if (type === 'log') append(data.message);
                        else if (type === 'complete') {
                            if (data.message) append(data.message);
                            if (data?.detailJson?.reconcileStatus === 'admin_handoff_required' && data?.detailJson?.handoff) {
                                handoffPayload = data.detailJson.handoff;
                                handoffClusterId = payload.clusterId;
                            }
                            resolve();
                        } else if (type === 'error') {
                            append(data.message || 'Unexpected error.');
                            resolve();
                        }
                    }).catch((error) => {
                        append(errorMessage(error, 'Log stream failed.'));
                        resolve();
                    });
                });
            }
            setOperationLog((prev) => (prev ? { ...prev, status: 'succeeded' } : prev));
            if (handoffPayload) {
                setOperationLog(null);
                openHandoffPayload(handoffPayload, handoffClusterId);
                setNotice('Orchestration administrator route sync required.');
            } else {
                setNotice(`${title} finished`);
            }
            load({ quiet: true });
        })();
    };

    const handleSync = () => {
        const clusterIds = [...new Set(members.map((member) => member.clusterId))].sort();
        if (clusterIds.length === 0) {
            setNotice('No clusters with members to reconcile');
            return;
        }
        const adminClusterIds = [];
        const nonAdminClusters = [];
        for (const clusterId of clusterIds) {
            const cluster = status.clusters.find((item) => item.clusterId === clusterId);
            if (clusterCapabilities(cluster).canReconcile) adminClusterIds.push(clusterId);
            else nonAdminClusters.push(cluster || { clusterId });
        }
        if (adminClusterIds.length > 0) {
            runGatewayOperation(adminClusterIds.map((clusterId) => ({ op: 'reconcile', clusterId })), 'Reconcile data plane');
        }
        if (nonAdminClusters.length > 0) {
            syncSubmission.run(async () => {
                let firstHandoff = null;
                for (const cluster of nonAdminClusters) {
                    const handoff = await generateGatewayRemediation({ clusterId: cluster.clusterId, mode: 'routes' });
                    if (!firstHandoff) firstHandoff = { handoff, clusterId: cluster.clusterId };
                }
                if (adminClusterIds.length === 0 && firstHandoff) {
                    openHandoffPayload(firstHandoff.handoff, firstHandoff.clusterId);
                } else if (firstHandoff) {
                    setNotice('Orchestration administrator sync scripts generated for Non-Admin clusters.');
                }
                await load({ quiet: true });
            });
        }
    };

    const toggleMember = (member) => toggleSubmission.run(async () => {
        setNotice('');
        serviceToggleSubmission.setError('');
        const online = member.status === 'disabled';
        try {
            const result = await updateMember(member.id, { status: online ? 'active' : 'disabled' });
            const outcome = await applyMutationHandoffResult(result, {
                clusterId: member.clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            if (outcome === 'admin_handoff_required') {
                setNotice('Deployment status updated. Run the Orchestration administrator script to sync routes.');
            } else {
                setNotice(online
                    ? (member.weight === 0
                        ? 'Deployment online at weight 0 (standby). Set its weight in Traffic distribution to receive requests.'
                        : 'Deployment online. It receives traffic only while its model service is enabled.')
                    : 'Deployment offline. Its weight and running Pods are unchanged.');
            }
        } finally {
            await load({ quiet: true });
        }
    });


    const openIppConfig = (cluster) => {
        ippConfigSubmission.setError('');
        const clusterIdValue = cluster.clusterId;
        const caps = clusterCapabilities(cluster);
        setIppConfigEdit({
            clusterId: clusterIdValue,
            name: cluster.clusterName || clusterIdValue,
            config: '',
            default: '',
            loading: true,
            canManageGatewayConfig: caps.canManageConfig,
        });
        getGatewayIppConfig(clusterIdValue)
            .then((payload) => setIppConfigEdit((cur) => (
                cur && cur.clusterId === clusterIdValue
                    ? {
                        ...cur,
                        config: payload.config || '',
                        default: payload.default || '',
                        loading: false,
                        canManageGatewayConfig: payload.canManageGatewayConfig ?? cur.canManageGatewayConfig,
                    }
                    : cur
            )))
            .catch((err) => setIppConfigEdit((cur) => (
                cur ? { ...cur, loading: false, loadError: errorMessage(err) } : cur
            )));
    };

    const submitIppConfig = () => ippConfigSubmission.run(async () => {
        const clusterId = ippConfigEdit.clusterId;
        if (ippConfigEdit.canManageGatewayConfig === false) {
            const handoff = await generateGatewayRemediation({
                clusterId,
                mode: 'ipp_config',
                ippConfig: ippConfigEdit.config || undefined,
            });
            setIppConfigEdit(null);
            openHandoffPayload(handoff, clusterId);
            setNotice('IPP Orchestration administrator script generated.');
            await load({ quiet: true });
            return;
        }
        const result = await setGatewayIppConfig(clusterId, ippConfigEdit.config);
        setIppConfigEdit(null);
        if (result?.detailJson?.reconcileStatus === 'admin_handoff_required' && result?.detailJson?.handoff) {
            openHandoffPayload(result.detailJson.handoff, clusterId);
            setNotice('IPP Orchestration administrator script generated.');
        } else {
            setNotice('IPP config applied.');
        }
        await load({ quiet: true });
    });

    const installGatewayForCluster = (cluster) => runGatewayOperation(
        { op: 'install-gateway', clusterId: cluster.clusterId, provider: cluster.gatewayProvider || null },
        `Install Gateway (${cluster.clusterName || cluster.clusterId})`,
    );

    const openLogs = (kind, cluster, member) => {
        const clusterName = cluster.clusterName || cluster.clusterId;
        const target = (() => {
            if (kind === 'gateway') {
                return { title: `Gateway logs — ${clusterName}`, payload: { clusterId: cluster.clusterId, component: 'gateway' } };
            }
            if (kind === 'ipp') {
                return {
                    title: `IPP logs — ${clusterName}`,
                    payload: {
                        clusterId: cluster.clusterId, component: 'ipp',
                        namespace: cluster.ippNamespace || cluster.gatewayNamespace, name: cluster.ippName || 'lens-ipp',
                    },
                };
            }
            if (kind === 'epp' && member) {
                return {
                    title: `EPP logs — ${member.name || member.eppRef}`,
                    payload: {
                        clusterId: member.clusterId || cluster.clusterId,
                        namespace: member.namespace, name: member.eppRef || member.targetService,
                    },
                };
            }
            return null;
        })();
        if (target) setLogsTarget(target);
    };

    useEffect(() => {
        if (!logsTarget) return undefined;
        setLogsLines([]);
        const controller = new AbortController();
        let nextId = 0;
        const append = (line) => {
            if (controller.signal.aborted) return;
            const entry = { raw: line, id: nextId++ };
            setLogsLines((current) => [...current, entry].slice(-500));
        };
        streamComponentLogs(logsTarget.payload, (type, data) => {
            if (type === 'log') append(data.message);
            else if (type === 'error') append(`[error] ${data.message}`);
        }, controller.signal).catch((failure) => {
            append(`[error] ${errorMessage(failure, 'log stream failed')}`);
        });
        return () => controller.abort();
    }, [logsTarget]);

    const handleComponentAction = (cluster, kind, action, service, member) => {
        const clusterId = cluster.clusterId;
        const handoffAction = componentHandoffAction(action);
        if (handoffAction) {
            openClusterHandoff(cluster, handoffAction.mode, { persist: handoffAction.persist });
            return;
        }
        if (action === 'logs') {
            openLogs(kind, cluster, member);
            return;
        }
        if (kind === 'gateway' && (action === 'start' || action === 'stop')) {
            runGatewayOperation(
                { op: action === 'stop' ? 'gateway-stop' : 'gateway-start', clusterId },
                `${action === 'stop' ? 'Stop' : 'Start'} Gateway (${cluster.clusterName || clusterId})`,
            );
            return;
        }
        if (kind === 'gateway' && action === 'install') {
            installGatewayForCluster(cluster);
            return;
        }
        if (kind === 'gateway' && action === 'uninstall') {
            runGatewayOperation({ op: 'uninstall-gateway', clusterId }, 'Uninstall Gateway');
            return;
        }
        if (kind === 'gateway' && action === 'reconcile') {
            runGatewayOperation({ op: 'reconcile', clusterId }, `Reconcile ${cluster.clusterName || clusterId}`);
            return;
        }
        if (kind === 'gateway' && action === 'configure') {
            setGatewayConfigCluster(cluster);
            return;
        }
        if (kind === 'ipp' && action === 'install') {
            runGatewayOperation({ op: 'install-ipp', clusterId }, 'Install IPP');
            return;
        }
        if (kind === 'ipp' && action === 'uninstall') {
            runGatewayOperation({ op: 'uninstall-ipp', clusterId }, 'Uninstall IPP');
            return;
        }
        if (kind === 'ipp' && action === 'configure') {
            openIppConfig(cluster);
            return;
        }
        if (kind === 'ipp' && (action === 'start' || action === 'stop')) {
            runGatewayOperation({
                op: 'scale', clusterId, namespace: cluster.gatewayNamespace, name: 'lens-ipp',
                replicas: action === 'stop' ? 0 : 1,
            }, `${action === 'stop' ? 'Stop' : 'Start'} IPP`);
            return;
        }
        if (kind === 'epp' && member) {
            runGatewayOperation({
                op: 'scale', clusterId, namespace: member.namespace,
                name: member.eppRef || member.targetService, replicas: action === 'stop' ? 0 : 1,
            }, `${action === 'stop' ? 'Stop' : 'Start'} EPP`);
        }
    };


    const openAddModel = () => {
        modelSubmission.setError('');
        setModelForm({ name: '', clusterId: '', executionId: '' });
        setModelOpen(true);
    };

    useEffect(() => {
        if (initialAction !== 'add' || handledInitialAction.current) return;
        if (!can('model-service:group:manage') || !can('model-service:member:manage')) return;
        handledInitialAction.current = true;
        setModelForm({ name: '', clusterId: initialClusterId || '', executionId: initialExecutionId || '' });
        setModelOpen(true);
    }, [can, initialAction, initialClusterId, initialExecutionId]);

    const openServiceDetails = (service) => {
        const group = groups.find((item) => item.id === service.id);
        if (!group) return;
        setDetail({
            title: group.name,
            subtitle: 'Model service',
            rows: [
                { label: 'Cluster', value: group.clusterId },
                { label: 'Model ref', value: group.modelRef },
                { label: 'Served name', value: group.servedName },
                { label: 'Base model', value: group.baseModel },
                { label: 'Display name', value: group.displayName },
                { label: 'Status', value: group.status },
                { label: 'Members', value: String(service.memberCount) },
                { label: 'Description', value: group.description },
            ],
        });
    };

    const openDeploymentDetails = (deployment) => {
        const member = members.find((item) => item.id === deployment.memberId);
        const info = deployments.find((item) => item.executionId === member?.executionId);
        setDetail({
            title: deployment.name,
            subtitle: 'Service provider',
            rows: [
                { label: 'Model service', value: groups.find((item) => item.id === member?.groupId)?.name },
                { label: 'Execution', value: member?.executionId },
                { label: 'Cluster', value: member?.clusterId },
                { label: 'Target', value: deployment.target },
                { label: 'Endpoint kind', value: member?.endpointKind },
                { label: 'Status', value: member?.status },
                { label: 'Model', value: info?.model },
                { label: 'Last health', value: member?.lastHealthAt },
            ],
        });
    };

    const openEditService = (service) => {
        const group = groups.find((item) => item.id === service.id);
        if (!group) return;
        serviceEditSubmission.setError('');
        setServiceEdit({
            groupId: group.id,
            name: group.name,
            modelRef: group.modelRef,
            servedName: group.servedName || '',
            baseModel: group.baseModel || '',
            clusterId: group.clusterId || '',
            displayName: group.displayName || '',
            description: group.description || '',
            status: group.status || 'active',
        });
    };

    const toggleService = (service) => serviceToggleSubmission.run(async () => {
        const group = groups.find((item) => item.id === service.id);
        if (!group) throw new Error('Model no longer exists. Refresh the page before changing its state.');
        setNotice('');
        toggleSubmission.setError('');
        const resume = group.status === 'disabled';
        try {
            const result = await setGroupStatus(group.id, resume ? 'active' : 'disabled');
            const outcome = await applyMutationHandoffResult(result, {
                clusterId: group.clusterId,
                clusters: status.clusters,
                setHandoffModal,
                setStatus,
            });
            if (outcome === 'admin_handoff_required') {
                setNotice(resume
                    ? 'Model enabled. Run the Orchestration administrator script to sync routes.'
                    : 'Model stopped. Run the Orchestration administrator script to remove active routes.');
            } else {
                setNotice(resume
                    ? 'Model enabled. Only online providers with positive weights receive traffic.'
                    : 'Model stopped serving. Provider states, weights and running Pods are unchanged.');
            }
        } finally {
            await load({ quiet: true });
        }
    });

    const submitServiceEdit = () => serviceEditSubmission.run(async () => {
        if (!serviceEdit?.name.trim() || !serviceEdit?.modelRef.trim()) {
            throw new Error('Name and model ref are required.');
        }
        const clusterId = serviceEdit.clusterId;
        const result = await updateGroup(serviceEdit.groupId, {
            name: serviceEdit.name.trim(),
            modelRef: serviceEdit.modelRef.trim(),
            servedName: serviceEdit.servedName.trim() || undefined,
            baseModel: serviceEdit.baseModel.trim() || undefined,
            clusterId: serviceEdit.clusterId || undefined,
            displayName: serviceEdit.displayName.trim(),
            description: serviceEdit.description,
            status: serviceEdit.status,
        });
        setServiceEdit(null);
        const outcome = await applyMutationHandoffResult(result, {
            clusterId: result?.clusterId || clusterId,
            clusters: status.clusters,
            setHandoffModal,
            setStatus,
        });
        if (outcome === 'admin_handoff_required') {
            setNotice('Model updated. Run the Orchestration administrator script to sync routes.');
        }
        await load({ quiet: true });
    });

    const allClusters = [...new Set([
        ...status.clusters.map((item) => item.clusterId),
        ...deployments.map((item) => item.clusterId),
    ])]
        .sort()
        .map((id) => ({
            id,
            name: status.clusters.find((item) => item.clusterId === id)?.clusterName
                || deployments.find((item) => item.clusterId === id)?.clusterName || '',
        }));
    const readyDeployments = availableModelProviders(deployments, members, modelForm.clusterId);
    const selectedDeployment = readyDeployments.find((item) => item.executionId === modelForm.executionId);
    const existingModel = groups.find((group) => (
        group.clusterId === modelForm.clusterId && group.name === modelForm.name.trim()
    ));

    const memberDeleteGroup = memberDelete ? groups.find((group) => group.id === memberDelete.groupId) : null;
    const memberDeleteProviderCount = memberDelete
        ? members.filter((member) => member.groupId === memberDelete.groupId).length
        : 0;
    const memberDeleteIsLast = memberDeleteProviderCount <= 1;
    const memberDeleteClusterName = status.clusters.find(
        (cluster) => cluster.clusterId === memberDelete?.clusterId,
    )?.clusterName || memberDelete?.clusterId;
    const pageError = [
        { message: error, clear: () => setError('') },
        ...[deleteSubmission, syncSubmission, toggleSubmission, serviceToggleSubmission, gatewaySubmission]
            .map((submission) => ({ message: submission.error, clear: () => submission.setError('') })),
    ].find((item) => item.message);

    return (
        <ModulePage className="model-services-page" contentClassName="flex h-[var(--workspace-height)] flex-col pb-4">
            <div className="flex min-h-0 w-full flex-1 flex-col">
                <ModuleHeader
                    className="[&>div:first-child]:flex-1"
                    icon={Boxes}
                    title="Model services"
                    description="Publish models and manage their serving routes."
                    onToggleMobileNav={onToggleMobileNav}
                />

                <section className={cn(CARD, 'model-services-card flex min-h-0 flex-1 flex-col p-4')}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <SectionLabel className="mb-0 mr-2">Service Flow</SectionLabel>
                            <PermissionGate permission="model-service:member:manage">
                                <Button variant="sky" size="sm" onClick={openAddModel}>
                                    <Plus size={14} /> Add model
                                </Button>
                            </PermissionGate>
                            <PermissionGate permission="model-service:gateway:reconcile">
                                <Button variant="secondary" size="sm" onClick={handleSync} isLoading={syncSubmission.pending}>
                                    <Repeat size={14} /> Reconcile
                                </Button>
                            </PermissionGate>
                        </div>
                        <Panel padding="none" tone="subtle"
                            className="flex w-full flex-wrap items-center gap-1 p-1 shadow-none sm:w-auto"
                            role="search" aria-label="Filter service flow">
                            <div className="w-full min-w-0 sm:w-44">
                                <Label htmlFor="service-flow-cluster" className="sr-only">Cluster</Label>
                                <Select id="service-flow-cluster" variant="toolbar" icon={Boxes}
                                    value={flowClusterId} onChange={(event) => setFlowClusterId(event.target.value)}>
                                    <option value="">All clusters</option>
                                    {flowClusterId && !loaded && (
                                        <option value={flowClusterId}>Loading cluster…</option>
                                    )}
                                    {loaded && flowClusterId && !status.clusters.some((cluster) => cluster.clusterId === flowClusterId) && (
                                        <option value={flowClusterId}>{flowClusterId} (unavailable)</option>
                                    )}
                                    {status.clusters.map((cluster) => (
                                        <option key={cluster.clusterId} value={cluster.clusterId}>{cluster.clusterName || cluster.clusterId}</option>
                                    ))}
                                </Select>
                            </div>
                            <span className="hidden h-4 border-l border-theme-border sm:block" aria-hidden="true" />
                            <div className="w-full min-w-0 sm:w-36">
                                <Label htmlFor="service-flow-status" className="sr-only">Model service status</Label>
                                <Select id="service-flow-status" variant="toolbar" icon={ListFilter}
                                    value={flowStatus} onChange={(event) => setFlowStatus(event.target.value)}>
                                    <option value="">All statuses</option>
                                    <option value="active">Active</option>
                                    <option value="disabled">Disabled</option>
                                </Select>
                            </div>
                            <span className="hidden h-4 border-l border-theme-border sm:block" aria-hidden="true" />
                            <div className="min-w-0 flex-1 sm:w-64 sm:flex-none">
                                <Label htmlFor="service-flow-model" className="sr-only">Public model name</Label>
                                <Input id="service-flow-model" type="search" icon={Search} variant="toolbar"
                                    placeholder="Search public model names" list="service-flow-model-names"
                                    value={flowModelQuery} onChange={(event) => setFlowModelQuery(event.target.value)} />
                                <datalist id="service-flow-model-names">
                                    {flowModelNames.map((name) => <option key={name} value={name} />)}
                                </datalist>
                            </div>
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={!hasFlowFilters}
                                aria-label="Clear filters" title="Clear filters"
                                onClick={() => { setFlowClusterId(''); setFlowModelQuery(''); setFlowStatus(''); }}>
                                <RotateCcw size={14} aria-hidden="true" />
                            </Button>
                        </Panel>
                    </div>
                    {authErrorClusters.length > 0 && (
                        <div role="alert" className="mt-3 space-y-1 border-l-4 border-rose-500 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">
                            <p className="font-semibold">Kubernetes authentication error</p>
                            {authErrorClusters.map((cluster) => (
                                <p key={cluster.clusterId}>
                                    <span className="font-medium">{cluster.clusterName || cluster.clusterId}:</span> {cluster.authError}
                                </p>
                            ))}
                        </div>
                    )}
                    <ModelServiceHandoffBanner
                        clusters={handoffClusters}
                        pending={syncSubmission.pending}
                        recheckingClusterId={bannerRecheckingId}
                        onViewScript={(cluster) => openClusterHandoff(cluster, clusterHandoffMode(cluster))}
                        onRecheck={recheckClusterBanner}
                    />
                    <div className="relative mt-3 flex min-h-0 flex-1 flex-col" aria-busy={!loaded}>
                        {hasFlowFilters && filteredFlow.clusters.length === 0 ? (
                            <EmptyState title="No matching service flow"
                                message="Try another cluster, model service status or public model name, or clear the filters." />
                        ) : <DataPlaneTopology
                            onNavigate={onNavigate}
                            clusters={filteredFlow.clusters}
                            memberGroups={filteredFlow.memberGroups}
                            statusDot={STATUS_DOT}
                            onComponentAction={handleComponentAction}
                            onEditTraffic={openTrafficDistribution}
                            onManageAccess={(id) => setAccessGroup(groups.find((group) => group.id === id))}
                            onInstallGateway={installGatewayForCluster}
                            savingGateway={gatewaySubmission.pending}
                            onToggleDeployment={(deployment) => {
                                const member = members.find((item) => item.id === deployment.memberId);
                                if (member) toggleMember(member);
                            }}
                            onDeleteDeployment={(deployment) => {
                                const member = members.find((item) => item.id === deployment.memberId);
                                if (member) { deleteSubmission.setError(''); setMemberDelete(member); }
                            }}
                            onViewServiceDetails={openServiceDetails}
                            onEditService={openEditService}
                            onToggleService={toggleService}
                            onSetProvidersStatus={toggleAllProviders}
                            onRemoveModel={(id) => {
                                deleteSubmission.setError('');
                                setModelDelete(groups.find((group) => group.id === id) || null);
                            }}
                            publicationPending={toggleSubmission.pending || serviceToggleSubmission.pending || deleteSubmission.pending}
                            onViewDeploymentDetails={openDeploymentDetails}
                        />}
                        {!loaded && (
                            <div role="status" aria-live="polite"
                                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-white/70 backdrop-blur-[1px] dark:bg-slate-950/55">
                                <Loader2 className="h-5 w-5 animate-spin text-[#037ffc] dark:text-emerald-300" aria-hidden="true" />
                                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Loading service flow…</span>
                            </div>
                        )}
                    </div>
                </section>

            </div>

            <Toast message={pageError?.message || notice}
                title={pageError ? 'Attention required' : 'Model services'}
                tone={pageError ? 'danger' : 'info'}
                onDismiss={pageError ? pageError.clear : () => setNotice('')} />

            <Modal isOpen={Boolean(trafficDraft)} onClose={() => { if (!trafficSubmission.pending) setTrafficDraft(null); }}
                title="Traffic distribution" variant="drawer" size="md"
                closeOnBackdrop={!trafficSubmission.pending} closeOnEscape={!trafficSubmission.pending}
                footer={
                    <>
                        <Button variant="secondary" disabled={trafficSubmission.pending} onClick={() => setTrafficDraft(null)} className="not-dark:bg-transparent not-dark:text-[#33475b] not-dark:hover:bg-[#e6f6fe]">Cancel</Button>
                        <Button variant="sky" isLoading={trafficSubmission.pending} onClick={submitTrafficDistribution}
                            disabled={!trafficDraft || Boolean(trafficDistributionError(trafficDraft.rows))}>Save and apply</Button>
                    </>
                }>
                {trafficDraft && <TrafficDistributionForm draft={trafficDraft} onChange={setTrafficDraft}
                    deployments={deployments} members={members} pending={trafficSubmission.pending}
                    error={trafficSubmission.error || trafficDistributionError(trafficDraft.rows)} />}
            </Modal>

            <Modal
                isOpen={modelOpen}
                onClose={() => { if (!modelSubmission.pending) setModelOpen(false); }}
                title="Add model"
                variant="drawer"
                subtitle="Choose a provider, then define the model name users will call."
                size="md"
                className="add-model-dialog"
                closeOnBackdrop={!modelSubmission.pending}
                closeOnEscape={!modelSubmission.pending}
                footer={
                    <>
                        <Button variant="secondary" size="sm" disabled={modelSubmission.pending}
                            onClick={() => setModelOpen(false)} className="not-dark:bg-transparent not-dark:text-[#33475b] not-dark:hover:bg-[#e6f6fe]">Cancel</Button>
                        <Button variant="primary" size="sm" onClick={submitModel} isLoading={modelSubmission.pending}
                            disabled={!modelForm.name.trim() || !selectedDeployment?.model}>Add</Button>
                    </>
                }
            >
                <AddModelForm form={modelForm} onChange={setModelForm} clusters={allClusters} models={groups}
                    deployments={readyDeployments} selectedDeployment={selectedDeployment} existingModel={existingModel}
                    pending={modelSubmission.pending} error={modelSubmission.error} />
            </Modal>

            <Modal
                isOpen={Boolean(serviceEdit)}
                onClose={() => setServiceEdit(null)}
                title={serviceEdit ? `Edit model service — ${serviceEdit.name}` : 'Edit model service'}
                size="md"
                footer={(
                    <>
                        <Button variant="secondary" size="sm" onClick={() => setServiceEdit(null)}>Cancel</Button>
                        <Button variant="sky" size="sm" onClick={submitServiceEdit} isLoading={serviceEditSubmission.pending}>Save</Button>
                    </>
                )}
            >
                <div className="space-y-3">
                    <div>
                        <label className="block text-xs text-slate-400" htmlFor="edit-service-name">Name (public model name)</label>
                        <Input id="edit-service-name" value={serviceEdit?.name ?? ''} maxLength={100}
                            onChange={(event) => setServiceEdit((current) => (current ? { ...current, name: event.target.value } : current))} className="mt-1" />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400" htmlFor="edit-service-modelref">Model ref</label>
                        <Input id="edit-service-modelref" value={serviceEdit?.modelRef ?? ''} maxLength={200}
                            onChange={(event) => setServiceEdit((current) => (current ? { ...current, modelRef: event.target.value } : current))} className="mt-1" />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400" htmlFor="edit-service-display">Display name</label>
                        <Input id="edit-service-display" value={serviceEdit?.displayName ?? ''} maxLength={200}
                            onChange={(event) => setServiceEdit((current) => (current ? { ...current, displayName: event.target.value } : current))} className="mt-1" />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400" htmlFor="edit-service-description">Description</label>
                        <Input id="edit-service-description" value={serviceEdit?.description ?? ''}
                            onChange={(event) => setServiceEdit((current) => (current ? { ...current, description: event.target.value } : current))} className="mt-1" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-slate-400" htmlFor="edit-service-cluster">Cluster</label>
                            <Input id="edit-service-cluster" value={serviceEdit?.clusterId ?? ''} maxLength={32} disabled
                                className="mt-1" />
                            <p className="mt-1 text-[11px] text-slate-500">A model service stays in its cluster.</p>
                        </div>
                        <div>
                            <label className="block text-xs text-slate-400" htmlFor="edit-service-status">Status</label>
                            <Select id="edit-service-status" value={serviceEdit?.status ?? 'active'}
                                onChange={(event) => setServiceEdit((current) => (current ? { ...current, status: event.target.value } : current))} className="mt-1">
                                <option value="active">active</option>
                                <option value="disabled">disabled</option>
                            </Select>
                        </div>
                        <div>
                            <label className="block text-xs text-slate-400" htmlFor="edit-service-served">Served name</label>
                            <Input id="edit-service-served" value={serviceEdit?.servedName ?? ''} maxLength={200}
                                onChange={(event) => setServiceEdit((current) => (current ? { ...current, servedName: event.target.value } : current))} className="mt-1" />
                        </div>
                        <div>
                            <label className="block text-xs text-slate-400" htmlFor="edit-service-base">Base model</label>
                            <Input id="edit-service-base" value={serviceEdit?.baseModel ?? ''} maxLength={200}
                                onChange={(event) => setServiceEdit((current) => (current ? { ...current, baseModel: event.target.value } : current))} className="mt-1" />
                        </div>
                    </div>
                </div>
            </Modal>


            <Modal
                isOpen={Boolean(ippConfigEdit)}
                onClose={() => setIppConfigEdit(null)}
                title={ippConfigEdit ? `Configure IPP — ${ippConfigEdit.name}` : 'Configure IPP'}
                size="lg"
                footer={(
                    <>
                        <Button variant="secondary" size="sm" onClick={() => setIppConfigEdit(null)}>Cancel</Button>
                        <Button variant="secondary" size="sm" disabled={!ippConfigEdit?.default}
                            onClick={() => setIppConfigEdit((cur) => (cur ? { ...cur, config: cur.default } : cur))}>
                            Use chart default
                        </Button>
                        <Button variant="sky" size="sm" onClick={submitIppConfig} isLoading={ippConfigSubmission.pending} disabled={ippConfigEdit?.loading}>
                            {ippConfigEdit?.canManageGatewayConfig === false ? 'Generate IPP script' : 'Save & apply'}
                        </Button>
                    </>
                )}
            >
                <p className="text-xs text-theme-muted">
                    {ippConfigEdit?.canManageGatewayConfig === false
                        ? 'Inference Payload Processor config (PayloadProcessorConfig body). Generate an Orchestration administrator script to apply this config in Kubernetes.'
                        : 'Inference Payload Processor config (PayloadProcessorConfig body). Read live from the cluster; saving upgrades IPP.'}
                </p>
                <FormError message={ippConfigSubmission.error} className="mt-2" />
                {ippConfigEdit?.loadError && <p role="alert" className="mt-2 text-xs text-rose-300">{ippConfigEdit.loadError}</p>}
                {ippConfigEdit?.loading ? (
                    <p className="mt-2 text-xs text-theme-muted">Loading…</p>
                ) : (
                    <Textarea className="mt-2 h-72 w-full font-mono text-xs" value={ippConfigEdit?.config ?? ''}
                        onChange={(event) => setIppConfigEdit((cur) => (cur ? { ...cur, config: event.target.value } : cur))} />
                )}
            </Modal>

            <Modal isOpen={Boolean(modelDelete)}
                onClose={() => { if (!deleteSubmission.pending) setModelDelete(null); }}
                title="Remove model" size="sm"
                closeOnBackdrop={!deleteSubmission.pending} closeOnEscape={!deleteSubmission.pending}
                footer={<>
                    <Button variant="secondary" disabled={deleteSubmission.pending} onClick={() => setModelDelete(null)}>Cancel</Button>
                    <Button variant="danger" isLoading={deleteSubmission.pending}
                        disabled={members.some((member) => member.groupId === modelDelete?.id)}
                        onClick={removeModel}>Remove model</Button>
                </>}>
                <p className="text-sm text-theme-muted">
                    Remove {modelDelete?.name}? All deployments must first be removed from this model.
                    Its HTTPRoute and model mapping will be cleaned up before the model record is deleted.
                    Cleanup failure keeps the record for retry. Other models, deployments and Pods are not deleted.
                </p>
                <FormError message={deleteSubmission.error} />
            </Modal>

            <Modal
                isOpen={Boolean(memberDelete)}
                onClose={() => setMemberDelete(null)}
                title={memberDeleteIsLast ? 'Remove last provider from model' : 'Remove from model'}
                size="sm"
                footer={(
                    <>
                        <Button variant="secondary" size="sm" onClick={() => setMemberDelete(null)}>Cancel</Button>
                        <Button variant="danger" size="sm" isLoading={deleteSubmission.pending}
                            onClick={() => removeProvider()}>
                            Remove from model
                        </Button>
                    </>
                )}
            >
                <p className="text-xs text-theme-muted">
                    {memberDeleteIsLast ? (
                        <>
                            Remove the last provider (<span className="font-semibold text-theme-text">{memberDeleteClusterName}</span>)
                            {' '}of <span className="font-semibold text-theme-text">{memberDeleteGroup?.name}</span>?
                            {' '}The empty model remains available for adding providers or Remove model. Callers cannot use it without an online, positive-weight provider.
                        </>
                    ) : (
                        <>
                            Remove provider <span className="font-semibold text-theme-text">{memberDelete?.name}</span> in
                            {' '}<span className="font-semibold text-theme-text">{memberDeleteClusterName}</span> from model
                            {' '}<span className="font-semibold text-theme-text">{memberDeleteGroup?.name}</span>?
                            {' '}The model keeps its other {memberDeleteProviderCount - 1} provider(s), and routing is updated to exclude this provider.
                        </>
                    )}
                    {' '}The deployment and its running Pods are not deleted.
                </p>
                {deleteSubmission.error && (
                    <p role="alert" className="mt-2 text-xs text-rose-300">{deleteSubmission.error}</p>
                )}
            </Modal>

            <Modal
                isOpen={Boolean(detail)}
                onClose={() => setDetail(null)}
                title={detail?.title}
                subtitle={detail?.subtitle}
                size="md"
            >
                <dl className="space-y-2">
                    {(detail?.rows || []).map((row) => (
                        <div key={row.label} className="flex gap-3 text-xs">
                            <dt className="w-28 shrink-0 text-slate-500">{row.label}</dt>
                            <dd className="min-w-0 flex-1 break-words text-slate-200">{row.value || '—'}</dd>
                        </div>
                    ))}
                </dl>
            </Modal>

            <Modal
                isOpen={Boolean(logsTarget)}
                onClose={() => setLogsTarget(null)}
                title={logsTarget?.title || 'Logs'}
                variant="drawer"
                className="max-w-none md:w-5/6"
            >
                <ComponentLogViewer entries={logsLines} />
            </Modal>

            {accessGroup && <ModelAccessDrawer key={accessGroup.id} group={accessGroup} onClose={() => setAccessGroup(null)} />}
            <GatewayOperationLogDrawer
                isOpen={Boolean(operationLog)}
                onClose={() => setOperationLog(null)}
                title={operationLog?.title}
                status={operationLog?.status}
                lines={operationLog?.lines || []}
                message={operationLog?.message || ''}
            />
            <GatewayConfigModal
                cluster={gatewayConfigCluster}
                onClose={() => setGatewayConfigCluster(null)}
                onSaved={() => applyGatewayConfigSaved({
                    setGatewayConfigCluster,
                    setNotice,
                    load,
                })}
            />
            <Modal
                isOpen={Boolean(handoffModal)}
                onClose={() => { if (!handoffModal?.busy && !handoffModal?.refreshing) setHandoffModal(null); }}
                title={handoffModal?.clusterName
                    ? `Orchestration administrator handoff — ${handoffModal.clusterName}`
                    : 'Orchestration administrator handoff'}
                subtitle={handoffModalSubtitle(handoffModal)}
                size="lg"
                closeOnBackdrop={!handoffModal?.busy && !handoffModal?.refreshing}
                closeOnEscape={!handoffModal?.busy && !handoffModal?.refreshing}
                footer={(
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={Boolean(handoffModal?.busy || handoffModal?.refreshing)}
                        onClick={() => setHandoffModal(null)}
                    >
                        Close
                    </Button>
                )}
            >
                {handoffModal?.handoff && (
                    <ModelServiceHandoffPanel
                        handoff={handoffModal.handoff}
                        verifyResult={handoffModal.verifyResult}
                        clusterName={handoffModal.clusterName}
                        onRecheck={recheckHandoff}
                        onRefreshScript={refreshHandoffScript}
                        busy={Boolean(handoffModal.busy)}
                        refreshing={Boolean(handoffModal.refreshing)}
                        error={handoffModal.error}
                    />
                )}
            </Modal>
        </ModulePage>
    );
}

export function ModelServiceHandoffBanner({
    clusters = [],
    pending = false,
    recheckingClusterId = '',
    onViewScript,
    onRecheck,
}) {
    if (!Array.isArray(clusters) || clusters.length === 0) return null;
    const controlsBusy = Boolean(pending || recheckingClusterId);
    return (
        <div role="status" aria-live="polite" className="mt-3 space-y-2 border-l-4 border-amber-500 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <div className="flex items-center gap-2">
                <ShieldAlert size={14} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <span className="font-semibold">Orchestration administrator route sync required</span>
            </div>
            <div className="space-y-1.5">
                {clusters.map((cluster) => (
                    <div key={cluster.clusterId} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-theme-text dark:text-amber-100">
                            {cluster.clusterName || cluster.clusterId}
                            {cluster.pendingOperationsCount ? ` — ${cluster.pendingOperationsCount} pending` : ''}
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="xs"
                                disabled={controlsBusy}
                                onClick={() => onViewScript?.(cluster)}
                            >
                                View Orchestration administrator script
                            </Button>
                            <Button
                                type="button"
                                variant="sky"
                                size="xs"
                                isLoading={recheckingClusterId === cluster.clusterId}
                                disabled={controlsBusy}
                                onClick={() => onRecheck?.(cluster)}
                            >
                                Re-check
                            </Button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function hasAdvisoryRouteChecks(isVerified, routeChecks) {
    return Boolean(
        isVerified
        && Array.isArray(routeChecks)
        && routeChecks.some((check) => ['loading', 'degraded', 'unreachable'].includes(check?.status) || Boolean(check?.advisory)),
    );
}

function routeCheckChipStatus(status) {
    if (status === 'ready') return 'ready';
    if (status === 'degraded') return 'degraded';
    if (status === 'unreachable' || status === 'unknown') return 'unknown';
    return 'pending';
}

export function handoffModalSubtitle(handoffModal) {
    const isVerified = Boolean(handoffModal?.verifyResult?.verified)
        || (!handoffModal?.verifyResult && handoffModal?.handoff?.reconcileStatus === 'synced');
    if (!isVerified) {
        return 'Ask an Orchestration administrator to run this idempotent script, then click Re-check.';
    }
    const routeChecks = Array.isArray(handoffModal?.verifyResult?.routeChecks)
        ? handoffModal.verifyResult.routeChecks
        : [];
    if (hasAdvisoryRouteChecks(isVerified, routeChecks)) {
        return 'Orchestration administrator route sync verified. Backend route probes reported advisory warnings.';
    }
    return 'Orchestration administrator route sync verified. Routes are ready.';
}

export function ModelServiceHandoffPanel({
    handoff,
    verifyResult = null,
    clusterName = '',
    onRecheck,
    onRefreshScript,
    busy = false,
    refreshing = false,
    error = '',
    onDownloadScript,
    onCopyScript,
}) {
    const clipboard = useClipboard();
    const [localError, setLocalError] = useState('');

    const script = typeof handoff?.adminScript === 'string' ? handoff.adminScript : '';
    const filename = handoff?.filename || 'lens-model-service-admin.sh';
    const pendingOperations = Array.isArray(handoff?.pendingOperations) ? handoff.pendingOperations : [];
    const warnings = Array.isArray(handoff?.warnings) ? handoff.warnings : [];
    const routeChecks = Array.isArray(verifyResult?.routeChecks) ? verifyResult.routeChecks : [];
    const isVerified = Boolean(verifyResult?.verified) || (!verifyResult && handoff?.reconcileStatus === 'synced');
    const hasAdvisoryChecks = hasAdvisoryRouteChecks(isVerified, routeChecks);
    const visiblePendingOperations = isVerified ? [] : pendingOperations;
    const isBusy = Boolean(busy || refreshing);
    const shouldExpandDetails = !isVerified;
    const [detailsOpen, setDetailsOpen] = useState(shouldExpandDetails);

    useEffect(() => {
        setDetailsOpen(shouldExpandDetails);
    }, [shouldExpandDetails]);

    useEffect(() => {
        setLocalError('');
    }, [handoff?.desiredHash, handoff?.adminScript]);

    const handleDetailsToggle = (event) => {
        if (event.target !== event.currentTarget) return;
        setDetailsOpen(event.currentTarget.open);
    };
    const markerStatus = verifyResult?.markerStatus || '';
    const markerNamespace = (isVerified
        ? verifyResult?.markerNamespace || handoff?.markerNamespace
        : handoff?.markerNamespace || verifyResult?.markerNamespace) || 'default';
    const markerName = (isVerified
        ? verifyResult?.markerName || handoff?.markerName
        : handoff?.markerName || verifyResult?.markerName) || 'not available';
    const desiredHash = (isVerified
        ? verifyResult?.desiredHash || handoff?.desiredHash
        : handoff?.desiredHash || verifyResult?.desiredHash) || 'not available';

    const downloadScript = () => {
        try {
            setLocalError('');
            if (onDownloadScript) onDownloadScript(script, filename);
            else downloadBlob(new Blob([script], { type: 'text/x-shellscript' }), filename);
        } catch {
            setLocalError('Could not download the script. Copy it instead.');
        }
    };

    const copyScript = async () => {
        setLocalError('');
        try {
            if (onCopyScript) {
                await onCopyScript(script);
                return;
            }
            const copied = await clipboard.copy(script);
            if (!copied) setLocalError('Could not copy the script. Download it instead.');
        } catch {
            setLocalError('Could not copy the script. Download it instead.');
        }
    };

    const statusMeta = isVerified
        ? { label: 'Verified', tone: 'success', border: 'border-l-emerald-500', iconClass: 'text-emerald-600 dark:text-emerald-400' }
        : markerStatus === 'stale'
            ? { label: 'Stale', tone: 'danger', border: 'border-l-rose-500', iconClass: 'text-rose-600 dark:text-rose-400' }
            : markerStatus === 'partial'
                ? { label: 'Partial', tone: 'warning', border: 'border-l-amber-500', iconClass: 'text-amber-600 dark:text-amber-400' }
                : markerStatus === 'forbidden'
                    ? { label: 'Unconfirmed', tone: 'warning', border: 'border-l-amber-500', iconClass: 'text-amber-600 dark:text-amber-400' }
                    : markerStatus === 'missing'
                        ? { label: 'Missing marker', tone: 'warning', border: 'border-l-amber-500', iconClass: 'text-amber-600 dark:text-amber-400' }
                        : { label: 'Awaiting Orchestration administrator', tone: 'warning', border: 'border-l-amber-500', iconClass: 'text-amber-600 dark:text-amber-400' };

    return (
        <Panel
            padding="sm"
            tone="soft"
            className={cn('border-l-4 shadow-none', statusMeta.border)}
            title={(
                <span className="flex items-center gap-2">
                    <ShieldAlert size={15} className={statusMeta.iconClass} aria-hidden="true" />
                    {clusterName ? `Orchestration administrator route sync — ${clusterName}` : 'Orchestration administrator route sync'}
                </span>
            )}
            actions={<Badge tone={statusMeta.tone} size="xs">{statusMeta.label}</Badge>}
        >
            <div className="space-y-3" role="status" aria-live="polite">
                {isVerified && (
                    <p className="flex items-center gap-2 border-l-2 border-emerald-500 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
                        <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                        <span>{verifyResult?.message || 'Orchestration administrator route sync verified. Routes are ready.'}</span>
                    </p>
                )}

                {!isVerified && markerStatus === 'partial' && (
                    <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            {verifyResult?.message || 'Orchestration administrator handoff is partial. Re-run the Orchestration administrator script below, then click Re-check.'}
                        </span>
                    </p>
                )}

                {!isVerified && markerStatus === 'stale' && (
                    <p className="flex items-start gap-2 border-l-2 border-rose-500 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-800 dark:text-rose-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            {verifyResult?.message || 'The completion marker belongs to an older route state. Run the updated Orchestration administrator script below, then click Re-check.'}
                        </span>
                    </p>
                )}

                {!isVerified && markerStatus === 'forbidden' && (
                    <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            {verifyResult?.message || `Lens received 403 Forbidden reading ConfigMap ${markerName} in namespace ${markerNamespace}. Verify route readiness or grant ConfigMap get access there, then click Re-check.`}
                        </span>
                    </p>
                )}

                {!isVerified && markerStatus === 'missing' && (
                    <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            {verifyResult?.message || 'Completion marker was not found yet. Ask an Orchestration administrator to run the script below, then click Re-check.'}
                        </span>
                    </p>
                )}

                {!isVerified && verifyResult?.message && !['partial', 'stale', 'forbidden', 'missing'].includes(markerStatus) && (
                    <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{verifyResult.message}</span>
                    </p>
                )}

                {hasAdvisoryChecks && (
                    <p className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                            Advisory: handoff is verified and synced, though live route probes reported non-blocking backend warnings (loading, degraded, or unreachable from Lens).
                        </span>
                    </p>
                )}

                {routeChecks.length > 0 && (
                    <ul className="space-y-1 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2" aria-label="Route verification checks">
                        {routeChecks.map((check, index) => (
                            <li key={`${check.groupId || check.name || index}-route-check`} className="flex items-center justify-between gap-2 text-xs">
                                <span className="truncate font-mono text-theme-text">{check.name || check.groupName || check.model || 'route'}</span>
                                <StatusChip
                                    variant="compact"
                                    status={routeCheckChipStatus(check.status)}
                                    title={check.detail || undefined}
                                    label={check.httpStatus ? `${check.status || 'unknown'} (${check.httpStatus})` : (check.status || 'unknown')}
                                />
                            </li>
                        ))}
                    </ul>
                )}

                {warnings.map((warningText, index) => (
                    <p
                        key={`${index}-${warningText}`}
                        className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                    >
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{warningText}</span>
                    </p>
                ))}

                {!isVerified && script && (
                    <div className="space-y-2 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2.5">
                        <p className="text-xs font-semibold text-theme-text">Orchestration administrator script</p>
                        <p className="max-w-[68ch] text-xs leading-relaxed text-theme-muted">
                            {handoff?.instructions || 'Send this idempotent script to an Orchestration administrator to run once, then click Re-check (contains no kubeconfig or user secret).'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={downloadScript} disabled={isBusy}>
                                <Download size={13} aria-hidden="true" /> Download
                            </Button>
                            <Button variant="outline" size="sm" onClick={copyScript} disabled={isBusy}>
                                {clipboard.copied
                                    ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    : <ClipboardCopy size={13} aria-hidden="true" />}
                                {clipboard.copied ? 'Copied' : 'Copy'}
                            </Button>
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-theme-border pt-3">
                    <Button
                        variant={isVerified ? 'ghost' : 'sky'}
                        size="sm"
                        onClick={onRecheck}
                        isLoading={busy}
                        disabled={isBusy || !onRecheck}
                    >
                        <RefreshCw size={13} aria-hidden="true" /> Re-check
                    </Button>
                    {onRefreshScript && !isVerified && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onRefreshScript}
                            isLoading={refreshing}
                            disabled={isBusy}
                        >
                            <RotateCcw size={13} aria-hidden="true" /> Refresh script
                        </Button>
                    )}
                </div>

                <FormError message={error || localError} />

                {isBusy && (
                    <p className="flex items-center gap-2 text-[11px] text-theme-muted">
                        <Spinner size="xs" /> {refreshing ? 'Refreshing script…' : 'Verifying…'}
                    </p>
                )}

                {(visiblePendingOperations.length > 0 || script || handoff?.desiredHash || handoff?.markerName) && (
                    <details
                        className="group/details border-t border-theme-border pt-3"
                        open={detailsOpen}
                        onToggle={handleDetailsToggle}
                    >
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-theme-muted hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 [&::-webkit-details-marker]:hidden">
                            <span className="flex items-center gap-1.5">
                                <ChevronRight
                                    size={13}
                                    aria-hidden="true"
                                    className="shrink-0 transition-transform motion-reduce:transition-none group-open/details:rotate-90"
                                />
                                View operation details
                            </span>
                            <span className="font-mono text-[11px]">{`${visiblePendingOperations.length} pending`}</span>
                        </summary>

                        <div className="mt-3 space-y-4">
                            {visiblePendingOperations.length > 0 && (
                                <ul className="space-y-1.5" aria-label="Pending Orchestration administrator operations">
                                    {visiblePendingOperations.map((item, index) => (
                                        <li key={item.id || `${item.kind}-${item.namespace}-${item.name}-${index}`} className="border-l-2 border-amber-500/80 pl-3 text-xs">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Badge tone={item.action === 'delete' ? 'danger' : 'warning'} size="xxs">
                                                    {item.action || 'apply'}
                                                </Badge>
                                                <span className="font-mono text-[11px] text-theme-text">
                                                    {item.kind}{item.namespace ? ` ${item.namespace}/${item.name}` : ` ${item.name}`}
                                                </span>
                                            </div>
                                            {item.summary && (
                                                <p className="mt-0.5 text-[11px] text-theme-muted">{item.summary}</p>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            <div className="space-y-1 border-t border-theme-border pt-3">
                                <p className="text-xs font-semibold text-theme-text">Completion marker</p>
                                <dl className="grid gap-1 text-[11px] text-theme-muted sm:grid-cols-[8rem_1fr]">
                                    <dt>Desired hash</dt><dd className="break-all font-mono">{desiredHash}</dd>
                                    <dt>Marker</dt><dd className="break-all font-mono">{`${markerNamespace}/${markerName}`}</dd>
                                    <dt>Mode</dt><dd className="font-mono">{handoff?.mode || 'routes'}</dd>
                                </dl>
                            </div>

                            {script && (
                                <div className="space-y-1.5 border-t border-theme-border pt-3">
                                    <p className="text-xs font-semibold text-theme-text">Script preview</p>
                                    <pre className="max-h-60 overflow-auto rounded-lg border border-theme-border bg-theme-bg/70 p-3 font-mono text-[11px] leading-relaxed text-theme-text">
                                        {script}
                                    </pre>
                                </div>
                            )}
                        </div>
                    </details>
                )}
            </div>
        </Panel>
    );
}

export default ModelServiceAdminPage;

export async function fetchModelServiceAdminSnapshot() {
    const [groups, members, deployments, status] = await Promise.all([
        listGroups(),
        listMembers(),
        listPublishableDeployments(),
        getGatewayStatus(),
    ]);
    return { groups, members, deployments, status };
}

export function applyGatewayConfigSaved({ setGatewayConfigCluster, setNotice, load }) {
    setGatewayConfigCluster(null);
    setNotice('Gateway configuration saved');
    return load({ quiet: true });
}

export function resolveGatewayConfigFields(cluster, fullCluster = null, hosts = []) {
    const resolvedPort = fullCluster?.gatewayPort ?? cluster?.gatewayPort;
    return {
        gatewayProvider: fullCluster?.gatewayProvider || cluster?.gatewayProvider || 'istio',
        gatewayPort: resolvedPort ? String(resolvedPort) : '',
        gatewayPublicUrl: fullCluster?.gatewayPublicUrl || cluster?.gatewayPublicUrl || '',
        gatewayAuthzHost: fullCluster?.gatewayAuthzHost || cluster?.gatewayAuthzHost || hosts[0] || '',
    };
}

export function buildGatewayConfigPatch(
    { gatewayProvider, gatewayPort, gatewayPublicUrl, gatewayAuthzHost },
    baselineCluster,
) {
    const baseline = baselineCluster || {};
    const trimmedPort = String(gatewayPort ?? '').trim();
    const baselinePort = baseline.gatewayPort ? String(baseline.gatewayPort) : '';
    const trimmedPublicUrl = String(gatewayPublicUrl ?? '').trim();
    const trimmedAuthzHost = String(gatewayAuthzHost ?? '').trim();
    return {
        ...(gatewayProvider !== (baseline.gatewayProvider || '') && { gatewayProvider: gatewayProvider || null }),
        ...(trimmedPort !== baselinePort && { gatewayPort: trimmedPort ? Number(trimmedPort) : null }),
        ...(trimmedPublicUrl !== (baseline.gatewayPublicUrl || '') && { gatewayPublicUrl: trimmedPublicUrl || null }),
        ...(trimmedAuthzHost !== (baseline.gatewayAuthzHost || '') && { gatewayAuthzHost: trimmedAuthzHost || null }),
    };
}

export async function submitGatewayConfig({ clusterId, fields, baselineCluster }) {
    const patch = buildGatewayConfigPatch(fields, baselineCluster);
    return requestJson(`/api/cluster/clusters/${encodeURIComponent(clusterId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
}

export function GatewayConfigModal({ cluster, onClose, onSaved }) {
    const [loadedCluster, setLoadedCluster] = useState(null);
    const [loadingConfig, setLoadingConfig] = useState(false);
    const [gatewayProvider, setGatewayProvider] = useState('istio');
    const [gatewayPort, setGatewayPort] = useState('');
    const [gatewayPublicUrl, setGatewayPublicUrl] = useState('');
    const [gatewayAuthzHost, setGatewayAuthzHost] = useState('');
    const [lensHosts, setLensHosts] = useState([]);
    const [portError, setPortError] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!cluster) return undefined;
        let alive = true;
        setLoadedCluster(null);
        setLoadingConfig(true);
        setGatewayProvider(cluster.gatewayProvider || 'istio');
        setGatewayPort(cluster.gatewayPort ? String(cluster.gatewayPort) : '');
        setGatewayPublicUrl(cluster.gatewayPublicUrl || '');
        setGatewayAuthzHost('');
        setPortError('');
        setError('');
        Promise.all([loadCluster(cluster.clusterId), listLensHosts()])
            .then(([fullCluster, hosts]) => {
                if (!alive) return;
                setLoadedCluster(fullCluster || null);
                const fields = resolveGatewayConfigFields(cluster, fullCluster, hosts);
                setGatewayProvider(fields.gatewayProvider);
                setGatewayPort(fields.gatewayPort);
                setGatewayPublicUrl(fields.gatewayPublicUrl);
                setGatewayAuthzHost(fields.gatewayAuthzHost);
                setLensHosts(hosts);
            })
            .catch((failure) => {
                if (alive) setError(errorMessage(failure, 'Failed to load Gateway configuration'));
            })
            .finally(() => {
                if (alive) setLoadingConfig(false);
            });
        return () => { alive = false; };
    }, [cluster]);

    if (!cluster) return null;

    const baselineCluster = loadedCluster || cluster;

    const checkGatewayPort = async () => {
        const value = gatewayPort.trim();
        const knownPort = baselineCluster.gatewayPort ?? cluster.gatewayPort;
        if (!value || (knownPort && Number(value) === knownPort)) {
            setPortError('');
            return;
        }
        try {
            const payload = await requestJson(
                `/api/cluster/clusters/${encodeURIComponent(cluster.clusterId)}/gateway-port-check?port=${Number(value)}`,
            );
            setPortError(payload.available ? '' : (payload.owner ? `Port ${value} is already used by ${payload.owner}` : (payload.reason || 'Port is not available')));
        } catch (failure) {
            setPortError(failure?.message || 'Could not check the port');
        }
    };

    const canSave = !busy && !loadingConfig && !portError && (gatewayProvider === 'gke' || Boolean(gatewayAuthzHost.trim()));

    const submit = async () => {
        if (!canSave) return;
        setBusy(true);
        setError('');
        try {
            const payload = await submitGatewayConfig({
                clusterId: cluster.clusterId,
                fields: { gatewayProvider, gatewayPort, gatewayPublicUrl, gatewayAuthzHost },
                baselineCluster,
            });
            onSaved?.(payload.cluster);
        } catch (failure) {
            setError(errorMessage(failure, 'Failed to save Gateway configuration'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            isOpen
            onClose={() => !busy && onClose?.()}
            title={`Configure Gateway — ${cluster.clusterName || cluster.clusterId}`}
            size="md"
            variant="drawer"
            footer={(
                <>
                    <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
                    <Button variant="sky" onClick={submit} isLoading={busy} disabled={!canSave}>Save changes</Button>
                </>
            )}
        >
            <div className="space-y-5">
                <div className="space-y-2">
                    <Label htmlFor="gateway-config-provider">Model gateway provider</Label>
                    <Select id="gateway-config-provider" value={gatewayProvider} onChange={(event) => setGatewayProvider(event.target.value)} disabled={busy}>
                        <option value="">Not set</option>
                        <option value="istio">Istio</option>
                        <option value="envoy-ai-gateway" disabled>Envoy AI Gateway (not supported yet)</option>
                        <option value="agentgateway" disabled>agentgateway (not supported yet)</option>
                        <option value="gke" disabled>GKE Gateway (not supported yet)</option>
                    </Select>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="gateway-config-port">Gateway exposed port (NodePort)</Label>
                    <Input
                        id="gateway-config-port"
                        type="number"
                        min="30000"
                        max="32767"
                        value={gatewayPort}
                        onChange={(event) => { setGatewayPort(event.target.value); setPortError(''); }}
                        onBlur={checkGatewayPort}
                        placeholder="Optional, e.g. 30080"
                        disabled={busy}
                    />
                    {portError && <p role="alert" className="text-xs text-rose-300">{portError}</p>}
                    <p className="text-xs text-slate-500">NodePort the shared Gateway is exposed on. Leave empty and the cluster assigns a random one; the actual port is shown in the Gateway status.</p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="gateway-config-public-url">Gateway host/IP (optional)</Label>
                    <Input
                        id="gateway-config-public-url"
                        value={gatewayPublicUrl}
                        onChange={(event) => setGatewayPublicUrl(event.target.value)}
                        placeholder="e.g. 10.112.229.74"
                        disabled={busy}
                    />
                    <p className="text-xs text-slate-500">Externally reachable host/IP clients call to reach the Gateway. Leave empty and Lens derives one from the exposed port and the cluster node.</p>
                </div>
                <div className="space-y-2">
                    <Label htmlFor="gateway-config-authz-host">Lens address</Label>
                    <Input
                        id="gateway-config-authz-host"
                        list="gateway-config-lens-hosts"
                        value={gatewayAuthzHost}
                        onChange={(event) => setGatewayAuthzHost(event.target.value)}
                        placeholder="Pick one or type a host/IP"
                        disabled={busy || gatewayProvider === 'gke'}
                    />
                    <datalist id="gateway-config-lens-hosts">
                        {lensHosts.map((host) => <option key={host} value={host} />)}
                    </datalist>
                    <p className="text-xs text-slate-500">{gatewayProvider === 'gke' ? 'GKE Gateway has no Lens address hook, so callers are not checked.' : 'The host or IP this cluster uses to reach Lens (Lens adds its own port).'}</p>
                </div>
                {error && <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</p>}
            </div>
        </Modal>
    );
}

export function ModelAccessDrawer({ group, onClose }) {
    const [subjectType, setSubjectType] = useState('user');
    const [subjectId, setSubjectId] = useState('');
    const fetchAccess = useCallback(({ signal }) => getModelAccess(group.id, { signal }), [group.id]);
    const { items: access, loading, error, load } = useResourceList(fetchAccess, {
        retainOnError: true, errorFallback: 'Failed to load model access',
    });
    const { pending, error: saveError, run } = useSubmission('Failed to update model access');
    usePolling(() => load({ quiet: true }), { enabled: !pending });
    const grants = access.grants || [];
    const subjects = (subjectType === 'group' ? access.groups : access.users) || [];
    const grant = (event) => {
        event.preventDefault();
        run(async () => {
            await grantModelAccess(group.id, { subjectType, subjectId });
            setSubjectId('');
            await load();
        });
    };
    const revoke = (bindingId) => run(async () => {
        await revokeModelAccess(group.id, bindingId);
        await load();
    });
    return (
        <Modal isOpen variant="drawer" size="md" title="Manage access" subtitle={group.name}
            onClose={pending ? undefined : onClose} closeOnBackdrop={!pending} closeOnEscape={!pending}
            footer={<Button variant="secondary" onClick={onClose} disabled={pending}>Close</Button>}>
            <div className="flex flex-col gap-5">
                <p className="text-sm text-theme-muted">
                    Grant inference through this model to a user or group with inference access to its cluster.
                    Access covers all of this model&apos;s providers, including providers added later.
                    It does not grant deployment management or permission to share.
                    Scoped operators retain their existing inference access.
                </p>
                <FormError message={error || saveError} />
                <form onSubmit={grant} className="flex flex-col gap-3">
                    <div>
                        <Label htmlFor="model-access-type" help="Grant this model to one user or to members of a group. Each caller still needs inference permission in the model's cluster.">Grant to</Label>
                        <Select id="model-access-type" value={subjectType} disabled={pending}
                            onChange={(event) => { setSubjectType(event.target.value); setSubjectId(''); }}>
                            <option value="user">User</option><option value="group">Group</option>
                        </Select>
                    </div>
                    <div>
                        <Label htmlFor="model-access-subject" help="Only recipients with inference permission in this model's cluster are listed. Grants never add cluster access.">
                            {subjectType === 'group' ? 'Group' : 'User'}
                        </Label>
                        <Select id="model-access-subject" value={subjectId} required disabled={pending || loading || Boolean(error)}
                            onChange={(event) => setSubjectId(event.target.value)}>
                            <option value="">Select a {subjectType}</option>
                            {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.username || subject.name}</option>)}
                        </Select>
                    </div>
                    <Button type="submit" variant="primary" isLoading={pending}
                        disabled={loading || Boolean(error) || !subjects.some((subject) => subject.id === subjectId)}>
                        Grant inference access
                    </Button>
                </form>
                {loading ? <p role="status" className="text-sm text-theme-muted">Loading model access...</p>
                    : grants.length === 0 ? <EmptyState title="No consumer grants" message="Consumers cannot call this model until access is granted." />
                        : <ul className="flex flex-col gap-2">
                            {grants.map((entry) => (
                                <li key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border border-theme-border p-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm text-theme-text">{entry.subjectName || entry.subjectId}</p>
                                        <p className="text-xs text-theme-muted">{entry.subjectType === 'group' ? 'Group' : 'User'} · Inference only</p>
                                    </div>
                                    <Button variant="dangerOutline" size="sm" disabled={pending} onClick={() => revoke(entry.id)}
                                        aria-label={`Revoke access for ${entry.subjectName || entry.subjectId}`}>Revoke</Button>
                                </li>
                            ))}
                        </ul>}
            </div>
        </Modal>
    );
}

export function AddModelForm({ form, onChange, clusters, deployments, models = [], selectedDeployment, existingModel, pending, error }) {
    return (
        <div className="flex flex-col gap-5">
            <FormError message={error} />
            <div>
                <Label htmlFor="add-model-cluster"
                    help="The cluster hosting the deployment you want to publish. Changing the cluster clears the selected provider.">
                    Cluster
                </Label>
                <Select id="add-model-cluster" value={form.clusterId} disabled={pending}
                    onChange={(event) => onChange({ ...form, clusterId: event.target.value, executionId: '' })}>
                    <option value="">Select a cluster</option>
                    {clusters.map((cluster) => (
                        <option key={cluster.id} value={cluster.id}>{cluster.name || cluster.id}</option>
                    ))}
                </Select>
            </div>
            <div>
                <Label htmlFor="add-model-provider"
                    help="The deployment that provides inference for this model. Only ready llm-d deployments with a deployment-owned InferencePool and EPP in the selected cluster that have not already been added to a model are listed; plain vLLM deployments cannot back a Model Service.">
                    Provider
                </Label>
                <Select id="add-model-provider" value={selectedDeployment?.executionId || ''}
                    disabled={pending || !form.clusterId || deployments.length === 0}
                    onChange={(event) => onChange({ ...form, executionId: event.target.value })}>
                    <option value="">Select a ready deployment</option>
                    {deployments.map((deployment) => (
                        <option key={deployment.executionId} value={deployment.executionId}>
                            {deployment.name || deployment.displayName || deployment.executionId}
                        </option>
                    ))}
                </Select>
                {form.clusterId && deployments.length === 0 && (
                    <p role="status" className="mt-1 text-xs text-theme-muted">
                        No available ready llm-d deployments in this cluster. Plain vLLM deployments and deployments already added to a model are excluded.
                    </p>
                )}
            </div>
            <Panel title="Model name mapping" padding="sm" className="shadow-none dark:shadow-lg">
                <div>
                    <Label htmlFor="add-model-provider-name"
                        help="The model name reported by the selected provider. It is filled automatically and cannot be changed here.">
                        Provider model name
                    </Label>
                    <Input id="add-model-provider-name" value={selectedDeployment?.model || ''} readOnly
                        placeholder="Select a provider to see its model name" />
                    {selectedDeployment && !selectedDeployment.model && (
                        <FormError message="This deployment has no model name and cannot be added." />
                    )}
                </div>
                <div className="flex items-center gap-2 py-4 text-xs text-theme-muted">
                    <ArrowDown size={18} aria-hidden="true" />
                    <span>Exposed to users as</span>
                </div>
                <div>
                    <Label htmlFor="add-model-name"
                        help="The public name users put in the model field of Chat Completions API requests. Select an existing name from this cluster or type a name. An existing name adds the deployment to that model; a new name creates a model. Providers of the same model must use the same provider model name.">
                        Public model name
                    </Label>
                    <Input id="add-model-name" list="add-model-name-options" value={form.name} maxLength={100} disabled={pending}
                        autoComplete="off" placeholder="Select an existing model or enter a new name"
                        onChange={(event) => onChange({ ...form, name: event.target.value })} />
                    <datalist id="add-model-name-options">
                        {models.filter((model) => model.clusterId === form.clusterId).map((model) => (
                            <option key={model.id} value={model.name} />
                        ))}
                    </datalist>
                    {existingModel && (
                        <p role="status" className="mt-2 text-xs text-theme-muted">
                            This model already exists in the selected cluster. The deployment will be added to it,
                            sharing its HTTPRoute. Adjust its weight in Traffic distribution after adding.
                        </p>
                    )}
                </div>
            </Panel>
        </div>
    );
}

export function TrafficDistributionForm({ draft, onChange, deployments, members = [], pending, error }) {
    const total = trafficTotal(draft.rows);
    const published = new Set(members.map((member) => member.executionId));
    const available = deployments.filter((deployment) => (
        deployment.clusterId === draft.clusterId && deployment.status === 'ready'
        && deployment.endpointKind === 'llm-d-epp' && deployment.model === draft.providerModel
        && !published.has(deployment.executionId)
        && !draft.rows.some((row) => row.executionId === deployment.executionId)
    ));
    return (
        <div className="space-y-5">
            <FormError message={error} />
            <p className="text-xs text-theme-muted">
                Public model: <strong className="text-theme-text">{draft.name}</strong><br />
                Cluster: <strong className="text-theme-text">{draft.clusterName}</strong>
            </p>
            <Label help="Gateway API relative request weights are integers from 0 to 1000000. A weight of 0 sends no traffic but does not stop the deployment. Shares are statistical request proportions, not token or compute quotas.">
                Weight and configured traffic share
            </Label>
            {draft.rows.map((row, index) => (
                <Panel key={row.executionId} padding="sm" className="shadow-none dark:shadow-lg">
                    <div className="mb-3 flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <p className="min-w-0 break-words text-sm font-semibold text-theme-text">{row.name}</p>
                            <StatusChip variant="compact"
                                status={row.isNew ? 'pending' : row.status === 'disabled' ? 'inactive' : row.status}
                                label={row.isNew ? 'New provider (not saved)' : row.status} />
                        </div>
                        {row.isNew && <Button variant="ghost" size="xs" disabled={pending}
                            onClick={() => onChange({ ...draft, rows: draft.rows.filter((item) => item.executionId !== row.executionId) })}>Remove</Button>}
                    </div>
                    <div className="flex items-center gap-3">
                        <Label className="mb-0 shrink-0" htmlFor={`traffic-weight-${index}`}>Weight</Label>
                        <Input className="min-w-0 flex-1" id={`traffic-weight-${index}`} type="number" min={0} max={MAX_TRAFFIC_WEIGHT} step={1}
                            value={row.weight} disabled={pending || row.status === 'disabled'}
                            onChange={(event) => onChange({
                                ...draft,
                                rows: draft.rows.map((item, position) => position === index ? { ...item, weight: event.target.value } : item),
                            })} />
                        <output className="w-16 shrink-0 text-right text-sm font-semibold text-theme-text"
                            aria-label={`${row.name} configured traffic share`}>{trafficShare(row, total)}</output>
                    </div>
                    {row.status !== 'disabled' && Number(row.weight) > 0 && !memberIsRoutable(row) && (
                        <p className="mt-2 text-[11px] leading-5 text-rose-600 dark:text-rose-300">
                            Unavailable: excluded from routing as 0% effective until it recovers. Its configured weight is retained.
                        </p>
                    )}
                </Panel>
            ))}
            <div>
                <Label htmlFor="traffic-add-deployment"
                    help="Only ready llm-d deployments in this cluster with the same provider model name that are not already attached to a public model can be added. New providers start at weight 1 and are saved with the entire allocation.">
                    Add deployment
                </Label>
                <Select id="traffic-add-deployment" value="" disabled={pending || draft.rows.length >= 16 || !available.length}
                    onChange={(event) => {
                        const deployment = available.find((item) => item.executionId === event.target.value);
                        if (deployment) onChange({
                            ...draft,
                            rows: [...draft.rows, {
                                executionId: deployment.executionId,
                                name: deployment.name || deployment.executionId,
                                status: 'active', weight: '1', isNew: true,
                            }],
                        });
                    }}>
                    <option value="">Select a ready deployment</option>
                    {available.map((deployment) => <option key={deployment.executionId} value={deployment.executionId}>
                        {deployment.name || deployment.executionId}
                    </option>)}
                </Select>
                {!available.length && <p className="mt-1 text-xs text-theme-muted">No additional compatible, unpublished ready deployments.</p>}
            </div>
            <p className="text-xs text-theme-muted">
                Changes take effect only after saving and Gateway reconciliation. Weights do not rewrite the request model name.
                {' '}<a className="underline" href="https://github.com/kubernetes-sigs/gateway-api/blob/main/apis/v1/shared_types.go"
                    target="_blank" rel="noopener noreferrer">Gateway API weight specification</a>
            </p>
        </div>
    );
}
