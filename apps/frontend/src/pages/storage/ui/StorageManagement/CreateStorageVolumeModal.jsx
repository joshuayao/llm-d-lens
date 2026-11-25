import { useSubmission } from '../../../../shared/lib/useSubmission';
import { useClipboard } from '../../../../shared/lib/useClipboard';
import { downloadBlob } from '../../../../shared/lib/download';
import { cn } from '../../../../shared/lib/cn';
import { FormError } from '../../../../shared/ui/FormError';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, ClipboardCopy, Download, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge } from '../../../../shared/ui/Badge';
import { Modal } from '../../../../shared/ui/Modal';
import { Button } from '../../../../shared/ui/Button';
import { Checkbox, Input, Label, Select } from '../../../../shared/ui/FormControls';
import {
    listStorageClasses,
    listStorageNodes,
    preflightStorageVolumeCreate,
    verifyStorageVolumeCreate,
} from './storageManagementBackend';
import { PURPOSE_OPTIONS, formatMissingPermissionRule, purposeLabel } from './storagePresentation';

const CAPACITY_PATTERN = /^\d+(Gi|Mi|Ti)$/;
const DNS1123_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const STORAGE_NAMESPACE_PREFIX = 'lens-storage';
const NAME_LIMIT = 63;

function generateDefaultStorageNamespace() {
    const fromCrypto = globalThis.crypto?.randomUUID?.()?.slice(0, 8)?.toLowerCase();
    const shortId = fromCrypto && /^[a-f0-9]{8}$/.test(fromCrypto)
        ? fromCrypto
        : Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    return `${STORAGE_NAMESPACE_PREFIX}-${shortId}`;
}

function applyResolvedNamespace(payload, resolvedNamespace) {
    const targetNamespace = String(resolvedNamespace || '').trim();
    if (!targetNamespace) return payload;
    if (payload.localDisk) {
        return { ...payload, localDisk: { ...payload.localDisk, namespace: targetNamespace } };
    }
    if (payload.nfs) {
        return { ...payload, nfs: { ...payload.nfs, namespace: targetNamespace } };
    }
    if (payload.dynamicPvc) {
        return { ...payload, dynamicPvc: { ...payload.dynamicPvc, namespace: targetNamespace } };
    }
    return payload;
}

const KINDS = [
    { value: 'local-disk', label: 'hostPath' },
    { value: 'nfs', label: 'NFS' },
    { value: 'dynamic-pvc', label: 'Dynamic PVC' },
];

export function CreateStorageVolumeModal({
    clusters = [],
    defaultClusterId = '',
    defaultPurpose = '',
    onCancel,
    onCreate,
    onCreatedFromHandoff,
}) {
    const [step, setStep] = useState('form');
    const [clusterId, setClusterId] = useState(defaultClusterId);
    const [kind, setKind] = useState('local-disk');
    const [name, setName] = useState('');
    const [capacity, setCapacity] = useState('100Gi');
    const [readOnly, setReadOnly] = useState(defaultPurpose !== 'model-cache');
    const [purposes, setPurposes] = useState(() => (PURPOSE_OPTIONS.includes(defaultPurpose) ? [defaultPurpose] : []));
    const [hostPath, setHostPath] = useState('');
    const [nfsServer, setNfsServer] = useState('');
    const [nfsPath, setNfsPath] = useState('');
    const [storageClass, setStorageClass] = useState('');
    const defaultNamespaceRef = useRef(null);
    if (!defaultNamespaceRef.current) {
        defaultNamespaceRef.current = generateDefaultStorageNamespace();
    }
    const defaultNamespace = defaultNamespaceRef.current;
    const [namespace, setNamespace] = useState(defaultNamespace);
    const [accessMode, setAccessMode] = useState('ReadWriteOnce');
    const [nodes, setNodes] = useState([]);
    const [storageClasses, setStorageClasses] = useState([]);
    const [submittedPayload, setSubmittedPayload] = useState(null);
    const [preflight, setPreflight] = useState(null);
    const [verifyResult, setVerifyResult] = useState(null);
    const [manualConfirmed, setManualConfirmed] = useState(false);
    const { copied, copy } = useClipboard();
    const { pending: creating, error, setError, run } = useSubmission('Failed to create storage volume');
    const firstFieldRef = useRef(null);

    useEffect(() => {
        firstFieldRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!clusterId) {
            setNodes([]);
            setStorageClasses([]);
            return undefined;
        }
        const controller = new AbortController();
        (async () => {
            try {
                if (kind === 'local-disk') {
                    const items = await listStorageNodes({ clusterId, signal: controller.signal });
                    // Control-plane-only nodes (tainted, not also acting as a
                    // worker) never actually run Pods -- Model Cache download
                    // Jobs and Deploy workloads both skip them (see
                    // model_cache/jobs.py::_target_nodes). Don't ask the user
                    // to replicate the hostPath onto a node nothing will ever
                    // be scheduled onto; a single-node dev cluster whose sole
                    // node is both control-plane and worker still shows up
                    // (schedulable stays true once its taint is removed).
                    setNodes(items.filter((node) => node.schedulable !== false));
                } else if (kind === 'dynamic-pvc') {
                    const items = await listStorageClasses({ clusterId, signal: controller.signal });
                    setStorageClasses(items);
                    if (!storageClass && items.length) {
                        setStorageClass(items.find((item) => item.isDefault)?.name || items[0].name);
                    }
                }
            } catch {
                // Non-fatal: fields fall back to free text entry.
            }
        })();
        return () => controller.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clusterId, kind]);

    const capacityValid = CAPACITY_PATTERN.test(capacity.trim());
    const nameValid = !name.trim() || name.trim().length <= NAME_LIMIT;
    const trimmedNamespace = namespace.trim();
    const namespaceValid = !trimmedNamespace || (trimmedNamespace.length <= NAME_LIMIT && DNS1123_LABEL_PATTERN.test(trimmedNamespace));
    const modelCacheSelected = purposes.includes('model-cache');
    const modelCacheDynamicPvcInvalid = modelCacheSelected && kind === 'dynamic-pvc';

    const kindSpecValid = useMemo(() => {
        if (kind === 'local-disk') return hostPath.trim().startsWith('/') && namespaceValid;
        if (kind === 'nfs') return Boolean(nfsServer.trim() && nfsPath.trim().startsWith('/')) && namespaceValid;
        if (kind === 'dynamic-pvc') return Boolean(storageClass.trim() && trimmedNamespace && namespaceValid);
        return false;
    }, [kind, hostPath, nfsServer, nfsPath, storageClass, trimmedNamespace, namespaceValid]);

    const invalid = !clusterId || !capacityValid || !nameValid || !kindSpecValid || modelCacheDynamicPvcInvalid;

    const setPurpose = (purpose) => {
        const next = purpose ? [purpose] : [];
        // Model Cache downloads models onto the volume, so a volume tagged
        // for that purpose must be writable -- read-only would make every
        // download Job fail with a permission error at mount time.
        if (purpose === 'model-cache') {
            setReadOnly(false);
        }
        setPurposes(next);
    };

    const submit = async (event) => {
        event.preventDefault();
        if (modelCacheDynamicPvcInvalid) {
            setError('Model Cache storage cannot use the Dynamic PVC type. Choose hostPath or NFS.');
            return;
        }
        if (invalid || creating) return;
        await run(async () => {
            const payload = {
                clusterId,
                name: name.trim(),
                kind,
                capacity: capacity.trim(),
                readOnly,
                purposes,
                ...(kind === 'local-disk' ? { localDisk: { hostPath: hostPath.trim(), namespace: trimmedNamespace || defaultNamespace } } : {}),
                ...(kind === 'nfs' ? { nfs: { server: nfsServer.trim(), path: nfsPath.trim(), namespace: trimmedNamespace || defaultNamespace } } : {}),
                ...(kind === 'dynamic-pvc'
                    ? { dynamicPvc: { storageClass: storageClass.trim(), namespace: trimmedNamespace, accessMode } }
                    : {}),
            };
            if (typeof onCreatedFromHandoff === 'function') {
                const result = await preflightStorageVolumeCreate(payload);
                const syncedPayload = applyResolvedNamespace(payload, result.namespace);
                if (result.namespace && result.namespace !== namespace) {
                    setNamespace(result.namespace);
                }
                if (result.allowed) {
                    await onCreate({
                        ...syncedPayload,
                        volumeId: result.volumeId,
                        name: result.name || syncedPayload.name,
                    });
                    return;
                }
                setSubmittedPayload({
                    ...syncedPayload,
                    volumeId: result.volumeId,
                    name: result.name || syncedPayload.name,
                });
                setPreflight(result);
                setVerifyResult(null);
                setManualConfirmed(false);
                setStep('handoff');
                return;
            }
            await onCreate(payload);
        });
    };

    const handleVerify = async (forceRegister = false) => {
        if (creating || !submittedPayload || !preflight) return;
        await run(async () => {
            const result = await verifyStorageVolumeCreate({
                ...submittedPayload,
                volumeId: preflight.volumeId,
                name: preflight.name || submittedPayload.name,
                forceRegister,
            });
            setVerifyResult(result);
            if (result.verified) {
                await onCreatedFromHandoff?.(result.volume || null);
            }
        });
    };

    const handleCopyScript = async () => {
        if (!preflight?.script) return;
        const ok = await copy(preflight.script);
        if (!ok) {
            setError('Could not copy the Orchestration administrator setup script. Download it instead.');
        }
    };

    const handleDownloadScript = () => {
        if (!preflight?.script) return;
        try {
            downloadBlob(
                new Blob([preflight.script], { type: 'text/x-shellscript' }),
                preflight.scriptFilename || 'lens-storage-setup.sh',
            );
        } catch {
            setError('Could not download the Orchestration administrator setup script. Copy it instead.');
        }
    };

    const backToForm = () => {
        setStep('form');
        setVerifyResult(null);
        setManualConfirmed(false);
        setError('');
    };

    if (step === 'handoff' && preflight) {
        const missingPermissions = Array.isArray(preflight.missingPermissions) ? preflight.missingPermissions : [];
        const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
        const verifyPhaseNote = [
            verifyResult?.pvcPhase ? `PVC: ${verifyResult.pvcPhase}` : '',
            verifyResult?.pvPhase ? `PV: ${verifyResult.pvPhase}` : '',
        ].filter(Boolean).join(', ');
        return (
            <Modal
                isOpen
                onClose={creating ? undefined : onCancel}
                title="New storage volume"
                subtitle="Orchestration administrator setup required before Lens can register this volume."
                size="lg"
                closeOnBackdrop={!creating}
                closeOnEscape={!creating}
                footer={
                    <>
                        <Button variant="secondary" onClick={backToForm} disabled={creating}>Back</Button>
                        <Button variant="secondary" onClick={onCancel} disabled={creating}>Cancel</Button>
                        <Button variant="sky" onClick={() => handleVerify(false)} isLoading={creating}>
                            {!creating && <RefreshCw size={13} aria-hidden="true" />}
                            Re-check
                        </Button>
                        {verifyResult?.canConfirmManually && (
                            <Button
                                variant="primary"
                                onClick={() => handleVerify(true)}
                                isLoading={creating}
                                disabled={!manualConfirmed}
                            >
                                Confirm &amp; Register
                            </Button>
                        )}
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                        <div className="flex min-w-0 items-start gap-2.5">
                            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                            <div className="min-w-0">
                                <p className="font-semibold">Orchestration administrator setup required</p>
                                <p className="mt-1 text-amber-800 dark:text-amber-200/90">
                                    Your Kubernetes credentials cannot create all required storage resources directly.
                                    Share the Orchestration administrator setup script below with an Orchestration administrator, then click <span className="font-semibold">Re-check</span>.
                                </p>
                            </div>
                        </div>
                        <Badge tone="warning" size="xs">Awaiting setup</Badge>
                    </div>

                    <dl className="grid grid-cols-1 gap-2 rounded-lg border border-theme-border bg-theme-bg/40 px-3.5 py-2.5 text-xs sm:grid-cols-2">
                        <div>
                            <dt className="text-[10px] font-bold uppercase tracking-wider text-theme-muted">Volume</dt>
                            <dd className="mt-0.5 truncate font-mono text-theme-text">{preflight.name || preflight.volumeId}</dd>
                        </div>
                        <div>
                            <dt className="text-[10px] font-bold uppercase tracking-wider text-theme-muted">Namespace</dt>
                            <dd className="mt-0.5 truncate font-mono text-theme-text">{preflight.namespace}</dd>
                        </div>
                        <div>
                            <dt className="text-[10px] font-bold uppercase tracking-wider text-theme-muted">PVC</dt>
                            <dd className="mt-0.5 truncate font-mono text-theme-text">{preflight.pvcName}</dd>
                        </div>
                        {preflight.pvName && (
                            <div>
                                <dt className="text-[10px] font-bold uppercase tracking-wider text-theme-muted">PV</dt>
                                <dd className="mt-0.5 truncate font-mono text-theme-text">{preflight.pvName}</dd>
                            </div>
                        )}
                    </dl>

                    {missingPermissions.length > 0 && (
                        <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-3.5 py-2.5">
                            <p className="text-xs font-semibold text-theme-text">Missing Kubernetes permissions</p>
                            <ul className="mt-1.5 space-y-1">
                                {missingPermissions.map((rule, index) => (
                                    <li key={`${rule.resource || 'perm'}-${index}`} className="font-mono text-[11px] text-theme-muted">
                                        {formatMissingPermissionRule(rule)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {warnings.map((warning, index) => (
                        <div
                            key={`${index}-${warning}`}
                            className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                        >
                            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                            <span>{warning}</span>
                        </div>
                    ))}

                    {preflight.script && (
                        <div className="space-y-2.5 rounded-lg border border-theme-border bg-theme-bg/40 px-3.5 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-semibold text-theme-text">Orchestration administrator setup script</p>
                                {preflight.scriptFilename && (
                                    <span className="font-mono text-[11px] text-theme-muted">{preflight.scriptFilename}</span>
                                )}
                            </div>
                            <p className="text-xs leading-relaxed text-theme-muted">
                                {preflight.instructions || 'Ask an Orchestration administrator to run this idempotent script once against the cluster, then click Re-check (contains no kubeconfig or user secret).'}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" onClick={handleCopyScript} disabled={creating}>
                                    {copied
                                        ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                        : <ClipboardCopy size={13} aria-hidden="true" />}
                                    {copied ? 'Copied' : 'Copy'}
                                </Button>
                                <Button variant="outline" size="sm" onClick={handleDownloadScript} disabled={creating}>
                                    <Download size={13} aria-hidden="true" /> Download
                                </Button>
                            </div>
                            <details className="group border-t border-theme-border pt-2">
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-theme-muted hover:text-theme-text [&::-webkit-details-marker]:hidden">
                                    <ChevronRight size={13} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                                    Preview script
                                </summary>
                                <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-theme-border bg-theme-bg p-3 font-mono text-[11px] leading-relaxed text-theme-text">
                                    <code>{preflight.script}</code>
                                </pre>
                            </details>
                        </div>
                    )}

                    {verifyResult && !verifyResult.verified && (
                        <div
                            role="status"
                            className={cn(
                                'rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed',
                                verifyResult.status === 'pending'
                                    ? 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200'
                                    : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200',
                            )}
                        >
                            <p>{verifyResult.message}</p>
                            {verifyPhaseNote && (
                                <p className="mt-1 font-mono text-[11px] opacity-85">{verifyPhaseNote}</p>
                            )}
                        </div>
                    )}

                    {verifyResult?.canConfirmManually && (
                        <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-3.5 py-3">
                            <Checkbox
                                id="storage-create-manual-confirm"
                                checked={manualConfirmed}
                                onChange={(event) => setManualConfirmed(event.target.checked)}
                                disabled={creating}
                                label="I confirm an Orchestration administrator has run the Orchestration administrator setup script and want to register this storage volume in Lens."
                            />
                        </div>
                    )}

                    <FormError message={error} />
                </div>
            </Modal>
        );
    }

    return (
        <Modal
            isOpen
            onClose={creating ? undefined : onCancel}
            title="New storage volume"
            subtitle="Register a reusable volume that Deployments can mount as a model cache."
            size="lg"
            closeOnBackdrop={!creating}
            closeOnEscape={!creating}
            footer={
                <>
                    <Button variant="secondary" onClick={onCancel} disabled={creating}>Cancel</Button>
                    <Button variant="sky" type="submit" form="create-storage-volume-form" isLoading={creating} disabled={invalid}>
                        {creating ? 'Creating' : 'Create storage volume'}
                    </Button>
                </>
            }
        >
            <form id="create-storage-volume-form" onSubmit={submit} className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                        <Label htmlFor="storage-cluster">Cluster</Label>
                        <Select
                            id="storage-cluster"
                            ref={firstFieldRef}
                            value={clusterId}
                            onChange={(event) => setClusterId(event.target.value)}
                            disabled={creating}
                        >
                            <option value="">Select a cluster</option>
                            {clusters.map((cluster) => (
                                <option key={cluster.id} value={cluster.id}>{cluster.name || cluster.id}</option>
                            ))}
                        </Select>
                    </div>
                    <div>
                        <Label htmlFor="storage-kind">Type</Label>
                        <Select id="storage-kind" value={kind} onChange={(event) => setKind(event.target.value)} disabled={creating}>
                            {KINDS.map((option) => (
                                <option key={option.value} value={option.value} disabled={modelCacheSelected && option.value === 'dynamic-pvc'}>{option.label}</option>
                            ))}
                        </Select>
                        {modelCacheSelected && (
                            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300">
                                Model Cache storage supports hostPath or NFS only.
                            </p>
                        )}
                    </div>
                </div>

                {kind === 'local-disk' && (
                    <div className="flex flex-col gap-3">
                        <div>
                            <Label htmlFor="storage-host-path">Host path</Label>
                            <Input id="storage-host-path" value={hostPath} placeholder="/data/models" onChange={(event) => setHostPath(event.target.value.trim())} disabled={creating} />
                            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                                This directory must exist with the same content on <strong>every node</strong> in the
                                cluster (e.g. a pre-populated or synced model cache). Prism does not pin the volume to
                                a single node — Deployments using it may be scheduled onto any node below.
                            </p>
                        </div>
                        {nodes.length > 0 && (
                            <div className="rounded-lg border border-slate-800/60 bg-slate-900/40 px-3 py-2.5">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Cluster nodes</div>
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {nodes.map((node) => (
                                        <span
                                            key={node.name}
                                            className={`rounded-full border px-2 py-0.5 text-[11px] ${node.ready ? 'border-slate-700 text-slate-300' : 'border-amber-500/30 text-amber-300'}`}
                                            title={node.ready ? 'Ready' : 'Not ready'}
                                        >
                                            {node.name}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {kind === 'nfs' && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <div>
                            <Label htmlFor="storage-nfs-server">Server</Label>
                            <Input id="storage-nfs-server" value={nfsServer} placeholder="nfs.example.com" onChange={(event) => setNfsServer(event.target.value.trim())} disabled={creating} />
                        </div>
                        <div>
                            <Label htmlFor="storage-nfs-path">Export path</Label>
                            <Input id="storage-nfs-path" value={nfsPath} placeholder="/export/models" onChange={(event) => setNfsPath(event.target.value.trim())} disabled={creating} />
                        </div>
                    </div>
                )}

                {kind === 'dynamic-pvc' && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <div>
                            <Label htmlFor="storage-class">StorageClass</Label>
                            {storageClasses.length ? (
                                <Select id="storage-class" value={storageClass} onChange={(event) => setStorageClass(event.target.value)} disabled={creating}>
                                    <option value="">Select a StorageClass</option>
                                    {storageClasses.map((item) => (
                                        <option key={item.name} value={item.name}>{item.name}{item.isDefault ? ' (default)' : ''}</option>
                                    ))}
                                </Select>
                            ) : (
                                <Input id="storage-class" value={storageClass} placeholder="standard" onChange={(event) => setStorageClass(event.target.value.trim())} disabled={creating} />
                            )}
                        </div>
                        <div>
                            <Label htmlFor="storage-namespace">Namespace</Label>
                            <Input
                                id="storage-namespace"
                                value={namespace}
                                placeholder={defaultNamespace}
                                error={Boolean(trimmedNamespace) && !namespaceValid}
                                onChange={(event) => setNamespace(event.target.value.trim())}
                                disabled={creating}
                            />
                        </div>
                        <div>
                            <Label htmlFor="storage-access-mode">Access mode</Label>
                            <Select id="storage-access-mode" value={accessMode} onChange={(event) => setAccessMode(event.target.value)} disabled={creating}>
                                <option value="ReadWriteOnce">ReadWriteOnce</option>
                                <option value="ReadWriteMany">ReadWriteMany</option>
                                <option value="ReadOnlyMany">ReadOnlyMany</option>
                            </Select>
                        </div>
                    </div>
                )}

                {(kind === 'local-disk' || kind === 'nfs') && (
                    <div>
                        <Label htmlFor="storage-pvc-namespace">PVC namespace</Label>
                        <Input
                            id="storage-pvc-namespace"
                            value={namespace}
                            placeholder={defaultNamespace}
                            error={!namespaceValid}
                            onChange={(event) => setNamespace(event.target.value)}
                            disabled={creating}
                        />
                        {!namespaceValid ? (
                            <p className="mt-1 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">
                                Namespace must be a valid DNS-1123 label (lowercase letters, numbers, and hyphens, max 63 characters).
                            </p>
                        ) : (
                            <p className="mt-1 text-[11px] leading-relaxed text-theme-muted">
                                Namespace where the PVC and Model Cache scan, download, and delete Jobs run.
                            </p>
                        )}
                    </div>
                )}

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                        <Label htmlFor="storage-name">Name (optional)</Label>
                        <Input
                            id="storage-name"
                            value={name}
                            placeholder="qwen-cache-node1"
                            maxLength={NAME_LIMIT}
                            error={!nameValid}
                            onChange={(event) => setName(event.target.value)}
                            disabled={creating}
                        />
                    </div>
                    <div>
                        <Label htmlFor="storage-capacity">Capacity</Label>
                        <Input
                            id="storage-capacity"
                            value={capacity}
                            placeholder="100Gi"
                            error={!capacityValid}
                            onChange={(event) => setCapacity(event.target.value.trim())}
                            disabled={creating}
                        />
                        {kind === 'nfs' && (
                            <p className="mt-1 text-[10px] text-slate-500">Declared value only, not an enforced quota.</p>
                        )}
                    </div>
                </div>

                <div className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2.5">
                    <Checkbox
                        id="storage-read-only"
                        checked={readOnly}
                        onChange={(event) => setReadOnly(event.target.checked)}
                        disabled={creating || modelCacheSelected}
                        label="Read-only when mounted"
                    />
                    <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-slate-400">
                        {modelCacheSelected
                            ? 'Disabled because Model Cache needs to write downloaded model files onto this volume.'
                            : 'Recommended for shared model caches so multiple Deployments can mount the same volume safely.'}
                    </p>
                </div>

                <div className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2.5">
                    <Label>Purpose (optional)</Label>
                    <div className="mt-1.5 space-y-1.5">
                        <label className="flex items-center gap-2 text-sm text-slate-200">
                            <input
                                type="radio"
                                name="storage-purpose"
                                checked={!purposes[0]}
                                onChange={() => setPurpose('')}
                                disabled={creating}
                            />
                            General
                        </label>
                        {PURPOSE_OPTIONS.map((purpose) => (
                            <label key={purpose} className="flex items-center gap-2 text-sm text-slate-200">
                                <input
                                    type="radio"
                                    name="storage-purpose"
                                    checked={purposes[0] === purpose}
                                    onChange={() => setPurpose(purpose)}
                                    disabled={creating || (purpose === 'model-cache' && kind === 'dynamic-pvc')}
                                />
                                {purposeLabel(purpose)}
                            </label>
                        ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                        Tag this volume so it appears as a candidate in matching workflows, e.g. Model Cache.
                    </p>
                    {kind === 'dynamic-pvc' && (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-300">
                            Dynamic PVC cannot be used for Model Cache purpose.
                        </p>
                    )}
                </div>

                <FormError message={error} />
            </form>
        </Modal>
    );
}

export default CreateStorageVolumeModal;
