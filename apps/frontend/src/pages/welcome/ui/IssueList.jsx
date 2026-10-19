import React from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Info, ShieldAlert } from 'lucide-react';
import { Badge } from '../../../shared/ui/Badge';
import { Button } from '../../../shared/ui/Button';
import { EmptyState } from '../../../shared/ui/EmptyState';
import { useAuth } from '../../auth';
import {
    actionLabel,
    evidenceRows,
    formatAge,
    severityTone,
} from '../model/welcomePresentation';

const SEVERITY_ICON = {
    critical: ShieldAlert,
    warning: AlertTriangle,
    info: Info,
};

function canUseAction(action, canView, can) {
    if (!action?.view) return false;
    if (!canView(action.view)) return false;
    return !action.permission || can(action.permission);
}

function IssueActions({ issue, onNavigate, canView, can }) {
    const actions = [issue.primaryAction, issue.secondaryAction]
        .filter((action) => canUseAction(action, canView, can));
    if (!actions.length) return null;
    return (
        <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
                <Button
                    key={`${action.view}:${action.intent}`}
                    variant={action === issue.primaryAction ? 'secondary' : 'ghost'}
                    size="xs"
                    onClick={() => onNavigate?.(action.view, {
                        ...(issue.clusterId ? { clusterId: issue.clusterId } : {}),
                        ...action.params,
                    })}
                >
                    {actionLabel(action.intent)}
                </Button>
            ))}
        </div>
    );
}

export function IssueRow({ issue, onNavigate, expandable = false, expanded = false, onToggle }) {
    const { canView, can } = useAuth();
    const Icon = SEVERITY_ICON[issue.severity] || Info;
    const rows = evidenceRows(issue, expandable && expanded ? 8 : 2);
    const scope = issue.code === 'cluster.none_available'
        ? 'No clusters'
        : issue.code === 'ai-provider.none_configured'
            ? 'Global'
            : issue.clusterName || issue.clusterId || 'All clusters';
    const scopeLabel = issue.clusterId || issue.clusterName ? 'Cluster' : 'Scope';
    return (
        <article className="rounded-lg border border-sky-500/10 bg-white/60 px-3 py-2.5 dark:border-sky-500/15 dark:bg-slate-900/40">
            <div className="flex items-start gap-2.5">
                <Badge tone={severityTone(issue.severity)} size="xs" className="mt-0.5 shrink-0 gap-1">
                    <Icon size={11} aria-hidden="true" />
                    {issue.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                        <h4 className="truncate text-[13px] font-semibold leading-snug text-theme-text" title={issue.title}>
                            {issue.title}
                        </h4>
                        {(issue.firstSeenAt || issue.observedAt) && (
                            <span className="shrink-0 text-[10px] text-theme-muted">
                                First seen{' '}
                                <span className="font-semibold text-theme-text">
                                    {formatAge(issue.firstSeenAt || issue.observedAt)}
                                </span>
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-theme-muted">{issue.message}</p>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[10px] text-theme-muted sm:flex-nowrap sm:overflow-hidden">
                            <span
                                className="inline-flex min-w-0 items-baseline gap-1"
                                title={`${scopeLabel}: ${scope}`}
                            >
                                <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide">
                                    {scopeLabel}
                                </span>
                                <span className="truncate text-theme-text">{scope}</span>
                            </span>
                            {issue.stale && (
                                <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">Stale</span>
                            )}
                            {issue.coverage?.expected ? (
                                <span className="shrink-0">
                                    Coverage{' '}
                                    <span className="font-semibold text-theme-text">
                                        {issue.coverage.observed ?? 0}/{issue.coverage.expected} {issue.coverage.unit}
                                    </span>
                                </span>
                            ) : null}
                            {rows.map((row) => (
                                <span
                                    key={row.key}
                                    className="inline-flex min-w-0 items-baseline gap-1"
                                    title={`${row.label}: ${row.value}`}
                                >
                                    <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide">
                                        {row.label}
                                    </span>
                                    <span className="truncate font-mono text-[10px] font-semibold text-theme-text">
                                        {row.value}
                                    </span>
                                </span>
                            ))}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <IssueActions issue={issue} onNavigate={onNavigate} canView={canView} can={can} />
                            {expandable && (
                                <Button variant="ghost" size="xs" onClick={() => onToggle?.(issue.id)}>
                                    {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                    {expanded ? 'Hide evidence' : 'Evidence'}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </article>
    );
}

export function IssueList({
    issues,
    onNavigate,
    emptyTitle = 'No detected issues',
    emptyMessage = 'No issues were found in the available data.',
    expandable = false,
    expandedIds = new Set(),
    onToggle,
    limit,
}) {
    const visible = limit ? issues.slice(0, limit) : issues;
    if (!visible.length) {
        return <EmptyState icon={<Info size={22} />} title={emptyTitle} message={emptyMessage} />;
    }
    return (
        <div className="space-y-2">
            {visible.map((issue) => (
                <IssueRow
                    key={issue.id}
                    issue={issue}
                    onNavigate={onNavigate}
                    expandable={expandable}
                    expanded={expandedIds.has(issue.id)}
                    onToggle={onToggle}
                />
            ))}
        </div>
    );
}
