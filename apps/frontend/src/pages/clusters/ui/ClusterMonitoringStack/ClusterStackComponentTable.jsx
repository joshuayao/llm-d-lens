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

import React from 'react';
import { Badge, EmptyState, Panel } from '../../../../shared/ui';
import { cn } from '../../../../shared/lib/cn';

const STATUS_DOT_CLASSES = {
    ready: 'bg-emerald-400',
    external: 'bg-sky-400',
    progressing: 'bg-cyan-400',
    degraded: 'bg-amber-400',
    missing: 'bg-red-400',
};

function statusDotClass(status) {
    return STATUS_DOT_CLASSES[status] || 'bg-slate-500';
}

function label(value) {
    return String(value || 'unknown').replace(/_/g, ' ');
}

const KIND_LABELS = {
    workload: { label: 'Pod', tone: 'info' },
    configmap: { label: 'ConfigMap', tone: 'violet' },
    crd: { label: 'CRD', tone: 'warning' },
};

function diagnosticToneClass(severity) {
    if (severity === 'error') return 'text-red-600 dark:text-red-300';
    if (severity === 'warning') return 'text-amber-700 dark:text-amber-300';
    return 'text-theme-muted';
}

export function ClusterStackComponentTable({ components = [], actions }) {
    return (
        <Panel
            title={<span className="text-[11px] font-extrabold uppercase tracking-widest text-sky-600 dark:text-sky-400/90">Stack components</span>}
            actions={actions}
            padding="none"
            className="overflow-hidden border-theme-border shadow-xl dark:border-slate-800/80 dark:bg-gradient-to-br dark:from-slate-900 dark:to-slate-950"
        >
            {!components.length ? (
                <EmptyState title="No components discovered" message="Component details will appear after a successful status query." />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                        <thead className="border-y border-theme-border bg-theme-bg/60 text-theme-muted text-[10px] uppercase tracking-wider dark:border-slate-800/70 dark:bg-slate-950/70 dark:text-slate-500">
                            <tr>
                                <th className="px-4 py-3 font-semibold">Component</th>
                                <th className="px-4 py-3 font-semibold">Type</th>
                                <th className="px-4 py-3 font-semibold">Ready / desired</th>
                                <th className="px-4 py-3 font-semibold">Source</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-theme-border dark:divide-slate-800/60">
                            {components.map((component) => {
                                const diagnostics = Array.isArray(component.diagnostics) ? component.diagnostics : [];
                                return (
                                    <React.Fragment key={component.name}>
                                        <tr className="transition-colors hover:bg-theme-bg/40 dark:hover:bg-slate-800/20">
                                            <td className="px-4 py-3 font-medium text-theme-text dark:text-slate-200">
                                                <span className="inline-flex items-center gap-2">
                                                    <span
                                                        className={cn(
                                                            'h-1.5 w-1.5 shrink-0 rounded-full motion-safe:animate-pulse [animation-duration:2.4s]',
                                                            statusDotClass(component.status),
                                                        )}
                                                        title={label(component.status)}
                                                        aria-label={label(component.status)}
                                                    />
                                                    {label(component.name)}
                                                </span>
                                                {diagnostics.length > 0 && (
                                                    <ul className="mt-1 space-y-0.5 pl-3.5">
                                                        {diagnostics.map((diag, idx) => (
                                                            <li
                                                                key={`${diag.code || 'diag'}-${idx}`}
                                                                className={cn('text-[11px] font-normal leading-snug', diagnosticToneClass(diag.severity))}
                                                            >
                                                                {diag.message}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </td>
                                            <td className="px-4 py-3">
                                                <Badge
                                                    tone={(KIND_LABELS[component.kind] || { tone: 'neutral' }).tone}
                                                    className={cn('component-type-tag', `component-type-${component.kind || 'unknown'}`)}
                                                >
                                                    {(KIND_LABELS[component.kind] || { label: label(component.kind) }).label}
                                                </Badge>
                                            </td>
                                            <td className="px-4 py-3">
                                                <div className="flex min-w-28 items-center gap-2">
                                                    <span className="w-10 font-mono text-xs text-theme-muted dark:text-slate-400">
                                                        {component.ready ?? '—'} / {component.desired ?? '—'}
                                                    </span>
                                                    {component.desired > 0 && (
                                                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                            <span
                                                                className="block h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400"
                                                                style={{ width: `${Math.min(100, ((component.ready || 0) / component.desired) * 100)}%` }}
                                                            />
                                                        </span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3"><Badge tone="neutral">{label(component.source)}</Badge></td>
                                        </tr>
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </Panel>
    );
}
