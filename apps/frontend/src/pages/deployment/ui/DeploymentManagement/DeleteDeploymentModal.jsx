import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../../../../shared/ui/Button';
import { DeleteConfirmation } from '../../../../shared/ui/DeleteConfirmation';
import { Checkbox, Input, Label } from '../../../../shared/ui/FormControls';
import { Modal } from '../../../../shared/ui/Modal';
import { errorMessage } from '../../../../shared/lib/errorMessage';
import {
    isDeploymentCleanupHandoffError,
    parseDeploymentCleanupHandoff,
    verifyDeploymentCleanup,
} from '../../api/agenticDeploymentBackend';
import { DeploymentPermissionHandoff } from '../DeploymentPlanReview';
import {
    deleteConfirmationPhrase,
    deploymentTitle,
    isDeletionInProgressStatus,
} from './deploymentPresentation';

export async function executeDeploymentDeleteAction({
    onDelete,
    deleteNamespace,
    onCleanupHandoff,
    onError,
}) {
    try {
        await onDelete({ deleteNamespace });
        return { status: 'deleted' };
    } catch (failure) {
        if (isDeploymentCleanupHandoffError(failure)) {
            onCleanupHandoff?.(parseDeploymentCleanupHandoff(failure));
            return { status: 'handoff' };
        }
        onError?.(errorMessage(failure, 'Failed to delete deployment'));
        return { status: 'error' };
    }
}

export function DeleteDeploymentModal({
    deployment,
    clusterNameById = {},
    onCancel,
    onDelete,
    onCleanupComplete,
    onVerifyCleanup = verifyDeploymentCleanup,
    initialCleanupHandoff = null,
    inline = false,
}) {
    const [confirmation, setConfirmation] = useState('');
    const [deleteNamespace, setDeleteNamespace] = useState(true);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState('');
    const [cleanupHandoff, setCleanupHandoff] = useState(initialCleanupHandoff);
    const [cleanupBusy, setCleanupBusy] = useState(false);
    const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
    const [cleanupError, setCleanupError] = useState('');
    const inputRef = useRef(null);
    const submittingRef = useRef(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        setCleanupHandoff(initialCleanupHandoff);
        setCleanupConfirmed(false);
        setCleanupError('');
        setError('');
    }, [deployment?.execution_id, initialCleanupHandoff]);

    if (!deployment) return null;

    const phrase = deleteConfirmationPhrase(deployment);
    const inProgress = isDeletionInProgressStatus(deployment);
    const confirmed = confirmation.trim() === phrase;

    const submit = async (event) => {
        event.preventDefault();
        if (!confirmed || deleting || submittingRef.current) return;
        submittingRef.current = true;
        setDeleting(true);
        setError('');
        let succeeded = false;
        try {
            const outcome = await executeDeploymentDeleteAction({
                onDelete,
                deleteNamespace,
                onCleanupHandoff: (handoff) => {
                    if (!mountedRef.current) return;
                    setError('');
                    setCleanupError('');
                    setCleanupConfirmed(false);
                    setCleanupHandoff(handoff);
                },
                onError: (message) => {
                    if (mountedRef.current) setError(message);
                },
            });
            succeeded = outcome.status === 'deleted';
        } finally {
            if (!succeeded && mountedRef.current) {
                submittingRef.current = false;
                setDeleting(false);
            }
        }
    };

    const runCleanupVerify = async ({ forceDeleteRecord = false } = {}) => {
        if (!cleanupHandoff || cleanupBusy) return;
        setCleanupBusy(true);
        setCleanupError('');
        try {
            const result = await onVerifyCleanup(deployment.execution_id, {
                cleanupDigest: cleanupHandoff.cleanupDigest,
                deleteRecordOnVerify: true,
                forceDeleteRecord,
            });
            if (!mountedRef.current) return;
            if (result?.deleted) {
                onCleanupComplete?.(result);
                return;
            }
            setCleanupHandoff((prev) => {
                if (!prev) return prev;
                const nextCanVerify = result?.canVerifyMarker ?? prev.canVerifyMarker;
                const nextRemaining = Array.isArray(result?.remainingOperations)
                    ? result.remainingOperations
                    : prev.remainingOperations;
                return {
                    ...prev,
                    status: result?.status || prev.status,
                    marker: result?.marker || prev.marker,
                    canVerifyMarker: nextCanVerify,
                    confirmRequired: nextCanVerify ? Boolean(result?.unreachable) : true,
                    operations: prev.operations?.length ? prev.operations : (nextRemaining || []),
                    remainingOperations: nextRemaining,
                    warnings: Array.isArray(result?.warnings) ? result.warnings : prev.warnings,
                    verified: Boolean(result?.verified),
                };
            });
            setCleanupError(result?.message || 'Orchestration administrator cleanup is not yet complete. Run the script and try again.');
        } catch (failure) {
            if (!mountedRef.current) return;
            setCleanupError(errorMessage(failure, 'Failed to verify Orchestration administrator cleanup'));
        } finally {
            if (mountedRef.current) setCleanupBusy(false);
        }
    };

    if (cleanupHandoff) {
        return (
            <Modal
                isOpen
                inline={inline}
                onClose={cleanupBusy ? undefined : onCancel}
                title="Orchestration administrator namespace cleanup"
                subtitle={deploymentTitle(deployment)}
                size="lg"
                closeOnBackdrop={!cleanupBusy}
                closeOnEscape={!cleanupBusy}
                footer={(
                    <Button variant="secondary" onClick={onCancel} disabled={cleanupBusy}>
                        Close
                    </Button>
                )}
            >
                <DeploymentPermissionHandoff
                    mode="cleanup"
                    handoff={cleanupHandoff}
                    namespace={cleanupHandoff.namespace || deployment.namespace || ''}
                    script={cleanupHandoff.script}
                    filename={cleanupHandoff.scriptFilename}
                    instructions={cleanupHandoff.instructions}
                    warnings={cleanupHandoff.warnings}
                    error={cleanupError}
                    verifying={cleanupBusy}
                    onPrimaryAction={() => runCleanupVerify({ forceDeleteRecord: false })}
                    primaryActionLabel="Re-check & Delete"
                    confirmed={cleanupConfirmed}
                    onConfirmChange={setCleanupConfirmed}
                    onConfirmDelete={() => runCleanupVerify({ forceDeleteRecord: true })}
                />
            </Modal>
        );
    }

    return (
        <DeleteConfirmation
            onCancel={onCancel}
            pending={deleting}
            error={error}
            title="Delete deployment"
            subtitle={deploymentTitle(deployment)}
            formId="delete-deployment-form"
            onSubmit={submit}
            confirmLabel={deleting ? 'Deleting' : 'Delete deployment'}
            confirmDisabled={!confirmed}
        >
            <div className="flex gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-rose-300" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-rose-100">
                    Lens uninstalls deployment monitoring and permanently removes this deployment record.
                    This action cannot be undone.
                </p>
            </div>

            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div>
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Execution ID</dt>
                    <dd className="mt-0.5 break-all font-mono text-[11px] text-slate-300">{deployment.execution_id}</dd>
                </div>
                <div>
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Cluster</dt>
                    <dd className="mt-0.5 break-all text-slate-300">{clusterNameById[deployment.cluster_id] || deployment.cluster_id || '—'}</dd>
                </div>
                <div className="sm:col-span-2">
                    <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Namespace</dt>
                    <dd className="mt-0.5 break-all font-mono text-[11px] text-slate-300">{deployment.namespace || '—'}</dd>
                </div>
            </dl>

            {inProgress && (
                <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    This deployment is still being created or rolled back. Deleting it now cancels the
                    in-flight operation and cleans up any resources it already created.
                </p>
            )}

            <div className="rounded-lg border border-slate-700/70 bg-slate-800/40 px-3 py-2.5">
                <Checkbox
                    id="delete-namespace"
                    checked={deleteNamespace}
                    onChange={(event) => setDeleteNamespace(event.target.checked)}
                    disabled={deleting}
                    label="Also delete the Kubernetes namespace"
                />
                <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-slate-400">
                    When checked, Lens also deletes namespace{' '}
                    <span className="font-mono text-slate-300">{deployment.namespace || '—'}</span> and all
                    resources in it. Leave unchecked to remove only this record and keep the namespace intact.
                </p>
            </div>

            <div>
                <Label htmlFor="delete-confirmation">
                    Type <span className="font-mono text-slate-300">{phrase}</span> to confirm
                </Label>
                <Input
                    id="delete-confirmation"
                    ref={inputRef}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    disabled={deleting}
                />
            </div>
        </DeleteConfirmation>
    );
}

export default DeleteDeploymentModal;
