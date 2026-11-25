// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0

import React, { useEffect, useRef, useState } from 'react';
import {
    AlertTriangle,
    Check,
    ChevronRight,
    ClipboardCopy,
    Clock3,
    Download,
    RefreshCw,
    ShieldAlert,
    Terminal,
    X,
} from 'lucide-react';
import { Badge, Button, Panel, Spinner, StatusChip } from '../../../../shared/ui';
import { FormError } from '../../../../shared/ui/FormError';
import { copyText } from '../../../../shared/lib/clipboard';
import { downloadBlob } from '../../../../shared/lib/download';

function duration(startedAt, finishedAt, now) {
    if (!startedAt) return '—';
    const end = finishedAt ? new Date(finishedAt).getTime() : now;
    const seconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function ClusterStackOperationProgress({ operation, error, onRetryPreflight }) {
    const [now, setNow] = useState(0);
    const logsRef = useRef(null);
    const logs = operation?.logs || [];
    const latestLogMessage = logs.at(-1)?.message;

    useEffect(() => {
        if (!operation || ['succeeded', 'failed'].includes(operation.status)) return undefined;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [operation]);

    useEffect(() => {
        const container = logsRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
    }, [logs.length, latestLogMessage]);

    if (!operation && !error) return null;
    const operationError = operation?.error;
    const chipStatus = operation?.status === 'succeeded'
        ? 'verified'
        : operation?.status === 'queued'
            ? 'pending'
            : operation?.status;

    return (
        <Panel
            title={<span className="text-[11px] font-extrabold uppercase tracking-widest text-violet-400/90">Installation operation</span>}
            className="overflow-hidden border-slate-800/80 bg-gradient-to-br from-slate-900 to-slate-950 shadow-xl"
            actions={operation?.status === 'failed' && onRetryPreflight
                ? <Button variant="outline" onClick={onRetryPreflight}>Retry preflight</Button>
                : null}
        >
            {operation && (
                <>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Status</div>
                            <div className="mt-1">
                                <StatusChip
                                    status={chipStatus}
                                    label={operation.status}
                                    pulse={['queued', 'running'].includes(operation.status)}
                                />
                            </div>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Phase</div>
                            <div className="mt-1 text-sm font-semibold text-slate-200">{String(operation.phase || 'queued').replace(/_/g, ' ')}</div>
                        </div>
                        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Duration</div>
                            <div className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                                <Clock3 className="h-4 w-4 text-theme-muted" />
                                {duration(operation.started_at, operation.finished_at, now)}
                            </div>
                        </div>
                    </div>
                    {(operationError || error) && (
                        <div className="mt-4 rounded-lg border border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
                            <strong>{operationError?.code || error?.code || 'OPERATION_FAILED'}:</strong>{' '}
                            {operationError?.message || error?.message || String(operationError)}
                        </div>
                    )}
                    <div className="mt-5">
                        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-theme-muted">
                            <Terminal className="h-4 w-4" /> Recent logs
                        </div>
                        <div
                            ref={logsRef}
                            className="max-h-72 overflow-y-auto scroll-smooth rounded-lg border border-slate-800 bg-black/40 p-3 font-mono text-xs shadow-inner"
                        >
                            {logs.length ? logs.map((log) => (
                                <div key={log.sequence ?? `${log.timestamp}-${log.message}`} className="mb-1 grid grid-cols-[auto_auto_1fr] gap-2 text-theme-muted">
                                    <span>{log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '—'}</span>
                                    <span className="uppercase">{log.level || 'info'}</span>
                                    <span className="text-theme-text whitespace-pre-wrap break-words">{log.message}</span>
                                </div>
                            )) : <span className="text-theme-muted">Waiting for operation logs…</span>}
                        </div>
                    </div>
                </>
            )}
            {!operation && error && (
                <div className="text-sm text-red-700 dark:text-red-300">{error.message}</div>
            )}
        </Panel>
    );
}

export function MonitoringAdminScriptPanel({
    title = 'Orchestration administrator setup script',
    description,
    script = '',
    filename = 'lens-monitoring-admin.sh',
    instructions,
    warnings,
    loading = false,
    rechecking = false,
    error,
    notice = '',
    embedded = false,
    onGenerate,
    onRecheck,
    onDismiss,
    generateLabel = 'Generate Orchestration administrator script',
    recheckLabel = 'Re-check',
}) {
    const [copied, setCopied] = useState(false);
    const [localError, setLocalError] = useState('');
    const copyTimerRef = useRef(null);

    useEffect(() => () => {
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    }, []);

    useEffect(() => {
        setCopied(false);
        setLocalError('');
    }, [script, filename]);

    const hasScript = Boolean(typeof script === 'string' && script.trim());
    const shouldExpandDetails = hasScript;
    const [detailsOpen, setDetailsOpen] = useState(shouldExpandDetails);
    useEffect(() => {
        setDetailsOpen(shouldExpandDetails);
    }, [shouldExpandDetails, script]);
    const handleDetailsToggle = (event) => {
        if (event.target !== event.currentTarget) return;
        setDetailsOpen(event.currentTarget.open);
    };
    const warningList = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    const errorMessage = typeof error === 'string' ? error : error?.message || '';
    const noticeMessage = typeof notice === 'string' ? notice.trim() : '';
    const busy = Boolean(loading || rechecking);

    const handleDownload = () => {
        if (!hasScript) return;
        try {
            setLocalError('');
            downloadBlob(
                new Blob([script], { type: 'text/x-shellscript' }),
                filename || 'lens-monitoring-admin.sh',
            );
        } catch {
            setLocalError('Could not download the script. Copy it instead.');
        }
    };

    const handleCopy = async () => {
        if (!hasScript) return;
        setLocalError('');
        try {
            await copyText(script);
            setCopied(true);
            if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
            copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
        } catch {
            setLocalError('Could not copy the script. Download it instead.');
        }
    };

    const body = (
        <div className="space-y-3" role="region" aria-label={title}>
            {description && (
                <p className="max-w-[72ch] text-xs leading-relaxed text-theme-muted">
                    {description}
                </p>
            )}

            {warningList.map((item, index) => (
                <p
                    key={`${index}-${item}`}
                    className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{item}</span>
                </p>
            ))}

            <div className="space-y-2 rounded-lg border border-theme-border bg-theme-bg/40 px-3 py-2.5">
                <p className="text-xs font-semibold text-theme-text">Orchestration administrator script</p>
                <p className="max-w-[72ch] text-xs leading-relaxed text-theme-muted">
                    {instructions || 'Ask an Orchestration administrator to run this idempotent script once, then click Re-check (contains no kubeconfig or user secret).'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    {hasScript ? (
                        <>
                            <Button variant="outline" size="sm" onClick={handleDownload} disabled={busy}>
                                <Download size={13} aria-hidden="true" /> Download .sh
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleCopy} disabled={busy}>
                                {copied
                                    ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    : <ClipboardCopy size={13} aria-hidden="true" />}
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                            {onGenerate && (
                                <Button variant="ghost" size="sm" onClick={onGenerate} disabled={busy}>
                                    {loading ? <Spinner size="xs" /> : <RefreshCw size={13} aria-hidden="true" />}
                                    Regenerate
                                </Button>
                            )}
                        </>
                    ) : loading ? (
                        <span className="inline-flex items-center gap-2 text-xs text-theme-muted" role="status">
                            <Spinner size="xs" />
                            Generating Orchestration administrator script…
                        </span>
                    ) : onGenerate ? (
                        <Button variant="sky" size="sm" onClick={onGenerate} disabled={busy}>
                            <Download size={13} aria-hidden="true" />
                            {generateLabel}
                        </Button>
                    ) : null}

                    {onRecheck && (
                        <Button
                            variant={hasScript ? 'sky' : 'secondary'}
                            size="sm"
                            onClick={onRecheck}
                            disabled={busy}
                        >
                            {rechecking ? <Spinner size="xs" /> : <RefreshCw size={13} aria-hidden="true" />}
                            {recheckLabel}
                        </Button>
                    )}
                </div>
            </div>

            {noticeMessage && (
                <p
                    role="status"
                    className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{noticeMessage}</span>
                </p>
            )}

            <FormError message={errorMessage || localError} />

            {hasScript && (
                <details
                    className="group/script border-t border-theme-border pt-3"
                    open={detailsOpen}
                    onToggle={handleDetailsToggle}
                >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-medium text-theme-muted hover:text-theme-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 [&::-webkit-details-marker]:hidden">
                        <span className="flex items-center gap-1.5">
                            <ChevronRight
                                size={13}
                                aria-hidden="true"
                                className="shrink-0 transition-transform motion-reduce:transition-none group-open/script:rotate-90"
                            />
                            View operation details &amp; script preview
                        </span>
                        {filename && <span className="font-mono text-[11px]">{filename}</span>}
                    </summary>
                    <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-theme-border bg-theme-bg/80 p-3 font-mono text-[11px] leading-relaxed text-theme-text whitespace-pre-wrap break-words">
                        {script}
                    </pre>
                </details>
            )}
        </div>
    );

    if (embedded) {
        return body;
    }

    return (
        <Panel
            padding="sm"
            tone="soft"
            className="border-l-4 border-l-amber-500 shadow-none"
            title={(
                <span className="flex items-center gap-2">
                    <ShieldAlert size={15} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                    <span>{title}</span>
                </span>
            )}
            actions={(
                <div className="flex items-center gap-2">
                    <Badge tone="warning" size="xs">Orchestration administrator handoff</Badge>
                    {onDismiss && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onDismiss}
                            disabled={busy}
                            aria-label="Dismiss Orchestration administrator script"
                            title="Dismiss"
                        >
                            <X size={14} aria-hidden="true" />
                        </Button>
                    )}
                </div>
            )}
        >
            {body}
        </Panel>
    );
}
