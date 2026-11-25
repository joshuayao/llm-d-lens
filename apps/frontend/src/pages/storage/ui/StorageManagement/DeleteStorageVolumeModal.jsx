import { useSubmission } from '../../../../shared/lib/useSubmission';
import { useClipboard } from '../../../../shared/lib/useClipboard';
import { downloadBlob } from '../../../../shared/lib/download';
import { cn } from '../../../../shared/lib/cn';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, ClipboardCopy, Download, RefreshCw, ShieldAlert } from 'lucide-react';
import { Badge } from '../../../../shared/ui/Badge';
import { DeleteConfirmation } from '../../../../shared/ui/DeleteConfirmation';
import { Button } from '../../../../shared/ui/Button';
import { Checkbox } from '../../../../shared/ui/FormControls';
import {
    preflightStorageVolumeDelete,
    verifyStorageVolumeDelete,
} from './storageManagementBackend';
import { formatMissingPermissionRule, volumeLocation, volumeNamespace, volumeTitle } from './storagePresentation';

// Two-step flow: (1) confirm deleting the volume also removes its Model
// Cache entries (skipped if there are none), then (2) choose whether the
// actual model files on NFS/hostPath should be kept or really deleted.
export function DeleteStorageVolumeModal({ volume, onCancel, onDelete, onDeletedFromHandoff }) {
    const [step, setStep] = useState('confirm');
    const [selectedKeepModelFiles, setSelectedKeepModelFiles] = useState(false);
    const [preflight, setPreflight] = useState(null);
    const [verifyResult, setVerifyResult] = useState(null);
    const [manualConfirmed, setManualConfirmed] = useState(false);
    const { copied, copy } = useClipboard();
    const { pending: deleting, error, setError, run } = useSubmission('Failed to delete storage volume');
    const confirmRef = useRef(null);
    const lastVolumeIdRef = useRef(volume?.id);

    const modelCacheCount = volume?.modelCacheCount || 0;
    const hasModelCaches = modelCacheCount > 0;

    // Reset to step 1 whenever a different volume is targeted (e.g. the
    // modal is reused for a second delete after the first closes). Derived
    // during render rather than an effect so it can't cause an extra render.
    if (volume?.id !== lastVolumeIdRef.current) {
        lastVolumeIdRef.current = volume?.id;
        if (step !== 'confirm') setStep('confirm');
        if (selectedKeepModelFiles) setSelectedKeepModelFiles(false);
        if (preflight !== null) setPreflight(null);
        if (verifyResult !== null) setVerifyResult(null);
        if (manualConfirmed) setManualConfirmed(false);
        if (error) setError('');
    }

    useEffect(() => {
        confirmRef.current?.focus();
    }, [step]);

    if (!volume) return null;

    const runDelete = async (keepModelFiles) => {
        if (deleting) return;
        await run(async () => {
            if (typeof onDeletedFromHandoff === 'function') {
                const result = await preflightStorageVolumeDelete(volume.id, { keepModelFiles });
                if (result.allowed) {
                    await onDelete(keepModelFiles);
                    return;
                }
                setSelectedKeepModelFiles(keepModelFiles);
                setPreflight(result);
                setVerifyResult(null);
                setManualConfirmed(false);
                setStep('handoff');
                return;
            }
            await onDelete(keepModelFiles);
        });
    };

    const handleVerifyDelete = async (confirmCleanup = false) => {
        if (deleting) return;
        await run(async () => {
            const result = await verifyStorageVolumeDelete(volume.id, {
                keepModelFiles: selectedKeepModelFiles,
                confirmCleanup,
            });
            setVerifyResult(result);
            if (result.verified && result.deleted) {
                await onDeletedFromHandoff?.(volume.id);
            }
        });
    };

    const handleCopyScript = async () => {
        if (!preflight?.script) return;
        const ok = await copy(preflight.script);
        if (!ok) {
            setError('Could not copy the Orchestration administrator cleanup script. Download it instead.');
        }
    };

    const handleDownloadScript = () => {
        if (!preflight?.script) return;
        try {
            downloadBlob(
                new Blob([preflight.script], { type: 'text/x-shellscript' }),
                preflight.scriptFilename || 'lens-storage-cleanup.sh',
            );
        } catch {
            setError('Could not download the Orchestration administrator cleanup script. Copy it instead.');
        }
    };

    const backFromHandoff = () => {
        setStep(hasModelCaches ? 'keep-files' : 'confirm');
        setVerifyResult(null);
        setManualConfirmed(false);
        setError('');
    };

    const submitConfirm = (event) => {
        event.preventDefault();
        if (hasModelCaches) {
            setStep('keep-files');
            return;
        }
        runDelete(false);
    };

    if (step === 'handoff' && preflight) {
        const missingPermissions = Array.isArray(preflight.missingPermissions) ? preflight.missingPermissions : [];
        const warnings = Array.isArray(preflight.warnings) ? preflight.warnings : [];
        return (
            <DeleteConfirmation
                onCancel={onCancel}
                pending={deleting}
                error={error}
                size="lg"
                title="Delete storage volume"
                subtitle={volumeTitle(volume)}
                footer={
                    <>
                        <Button variant="secondary" onClick={backFromHandoff} disabled={deleting}>Back</Button>
                        <Button variant="secondary" onClick={onCancel} disabled={deleting}>Cancel</Button>
                        <Button variant="sky" onClick={() => handleVerifyDelete(false)} isLoading={deleting}>
                            {!deleting && <RefreshCw size={13} aria-hidden="true" />}
                            Re-check &amp; Delete
                        </Button>
                        {verifyResult?.canConfirmManually && (
                            <Button
                                variant="danger"
                                onClick={() => handleVerifyDelete(true)}
                                isLoading={deleting}
                                disabled={!manualConfirmed}
                            >
                                Confirm &amp; Delete Record
                            </Button>
                        )}
                    </>
                }
            >
                <div className="flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                    <div className="flex min-w-0 items-start gap-2.5">
                        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                        <div className="min-w-0">
                            <p className="font-semibold">Orchestration administrator cleanup required</p>
                            <p className="mt-1 text-amber-800 dark:text-amber-200/90">
                                Your Kubernetes credentials cannot delete all Kubernetes storage resources directly.
                                Share the Orchestration administrator cleanup script below with an Orchestration administrator, then click <span className="font-semibold">Re-check &amp; Delete</span>.
                            </p>
                        </div>
                    </div>
                    <Badge tone="warning" size="xs">Awaiting cleanup</Badge>
                </div>

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
                            <p className="text-xs font-semibold text-theme-text">Orchestration administrator cleanup script</p>
                            {preflight.scriptFilename && (
                                <span className="font-mono text-[11px] text-theme-muted">{preflight.scriptFilename}</span>
                            )}
                        </div>
                        <p className="text-xs leading-relaxed text-theme-muted">
                            {preflight.instructions || 'Ask an Orchestration administrator to run this idempotent cleanup script once against the cluster, then click Re-check & Delete.'}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" onClick={handleCopyScript} disabled={deleting}>
                                {copied
                                    ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    : <ClipboardCopy size={13} aria-hidden="true" />}
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleDownloadScript} disabled={deleting}>
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

                {verifyResult && !verifyResult.deleted && (
                    <div
                        role="status"
                        className={cn(
                            'rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed',
                            verifyResult.status === 'still_present'
                                ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                                : 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200',
                        )}
                    >
                        <p>{verifyResult.message}</p>
                    </div>
                )}

                {verifyResult?.canConfirmManually && (
                    <div className="rounded-lg border border-theme-border bg-theme-bg/40 px-3.5 py-3">
                        <Checkbox
                            id="storage-delete-manual-confirm"
                            checked={manualConfirmed}
                            onChange={(event) => setManualConfirmed(event.target.checked)}
                            disabled={deleting}
                            label="I confirm an Orchestration administrator has run the Orchestration administrator cleanup script (or accept leaving Kubernetes PVC/PV resources behind) and want to delete the Lens storage record."
                        />
                    </div>
                )}
            </DeleteConfirmation>
        );
    }

    if (step === 'keep-files') {
        return (
            <DeleteConfirmation
                onCancel={onCancel}
                pending={deleting}
                error={error}
                title="Delete storage volume"
                subtitle={volumeTitle(volume)}
                footer={
                    <>
                        <Button variant="secondary" onClick={() => setStep('confirm')} disabled={deleting}>Back</Button>
                        <Button ref={confirmRef} variant="danger" onClick={() => runDelete(false)} disabled={deleting} isLoading={deleting}>
                            Delete model files
                        </Button>
                        <Button variant="primary" onClick={() => runDelete(true)} disabled={deleting} isLoading={deleting}>
                            Keep model files
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col gap-4">
                    <p className="text-sm text-slate-300">
                        Do you want to keep the model files already downloaded onto this storage, or delete them too?
                    </p>
                    <ul className="flex flex-col gap-2 text-xs text-slate-300">
                        <li className="rounded-lg border border-slate-700/60 bg-slate-800/60 px-3 py-2">
                            <strong className="text-slate-100">Keep model files</strong> — only removes the {modelCacheCount}{' '}
                            model cache record{modelCacheCount === 1 ? '' : 's'} and the storage volume. Files already on
                            NFS/hostPath are left untouched.
                        </li>
                        <li className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-100">
                            <strong>Delete model files</strong> — actually removes the downloaded model files from
                            NFS/hostPath for each model cache entry before deleting the storage volume.
                        </li>
                    </ul>
                </div>
            </DeleteConfirmation>
        );
    }

    return (
        <DeleteConfirmation
            onCancel={onCancel}
            pending={deleting}
            error={error}
            title="Delete storage volume"
            subtitle={volumeTitle(volume)}
            formId="delete-storage-volume-form"
            onSubmit={submitConfirm}
            confirmLabel={hasModelCaches ? 'Continue' : (deleting ? 'Deleting' : 'Delete storage volume')}
            confirmRef={confirmRef}
        >
            {hasModelCaches && (
                <div className="flex gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" aria-hidden="true" />
                    <p className="text-xs leading-relaxed text-rose-100">
                        This storage volume has <strong>{modelCacheCount}</strong> model cache
                        {modelCacheCount === 1 ? ' entry' : ' entries'}. Deleting the volume will also remove{' '}
                        {modelCacheCount === 1 ? 'it' : 'all of them'}. You'll choose next whether to keep the
                        downloaded model files.
                    </p>
                </div>
            )}

            <div className="flex gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-rose-100">
                    This deletes the PersistentVolumeClaim{volume.pvcName ? ` "${volume.pvcName}"` : ''}
                    {volume.pvName ? ` and PersistentVolume "${volume.pvName}"` : ''} from Kubernetes.
                    Data on the underlying disk/NFS export is <strong>not</strong> deleted automatically
                    (reclaim policy: Retain) — clean it up manually if needed.
                </p>
            </div>

            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div>
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Type</dt>
                    <dd className="mt-0.5 text-slate-300">{volume.kind}</dd>
                </div>
                <div>
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-theme-muted">Namespace</dt>
                    <dd className="mt-0.5 break-all font-mono text-[11px] text-theme-text">{volumeNamespace(volume)}</dd>
                </div>
                <div className="sm:col-span-2">
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Location</dt>
                    <dd className="mt-0.5 break-all font-mono text-[11px] text-slate-300">{volumeLocation(volume)}</dd>
                </div>
            </dl>
        </DeleteConfirmation>
    );
}

export default DeleteStorageVolumeModal;
