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
import { Activity, Boxes } from 'lucide-react';
import { SectionLabel } from '../../../../shared/ui';
import { cn } from '../../../../shared/lib/cn';
import { isOptionalAbsentComponent, summarizeMonitoringComponents } from './preflightPresentation';
import { normalizeMonitoringNamespace } from './monitoringLinks';

const STATUS_DOT_CLASSES = {
    ready: 'bg-emerald-400',
    external: 'bg-sky-400',
    installing: 'bg-amber-400',
    progressing: 'bg-amber-400',
    pending: 'bg-amber-400',
    absent: 'bg-amber-400',
    degraded: 'bg-red-400',
    unreachable: 'bg-red-400',
    failed: 'bg-red-400',
    inactive: 'bg-slate-500',
    neutral: 'bg-slate-500',
};

function statusDotClass(status) {
    return STATUS_DOT_CLASSES[status] || 'bg-slate-500';
}

function StackStatusLabel({ status, label }) {
    return (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[10px] font-bold uppercase tracking-wider text-theme-muted">
            <span
                className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full motion-safe:animate-pulse [animation-duration:2.4s]',
                    statusDotClass(status),
                )}
                aria-hidden="true"
            />
            {label}
        </span>
    );
}

function StackMetricCard({ icon, title, value, unit, status, detail }) {
    return (
        <div className="flex h-full flex-col gap-2 rounded-lg border border-theme-border bg-theme-card p-3 text-left dark:border-slate-700/60 dark:bg-slate-800/60">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-theme-muted">
                    <span className="shrink-0 text-theme-muted">{icon}</span>
                    <span className="truncate">{title}</span>
                </div>
                {status && <StackStatusLabel status={status.status} label={status.label} />}
            </div>
            <h3 className="truncate text-2xl font-bold leading-none text-theme-text">
                {value}
                {unit && <span className="ml-1 align-baseline text-sm font-semibold text-theme-muted">{unit}</span>}
            </h3>
            {detail && <p className="truncate text-[10px] text-theme-muted" title={detail}>{detail}</p>}
        </div>
    );
}

function NonAdminSummary({ snapshot, components, effectiveNamespace }) {
    const { ready: readyComponents, desired: desiredComponents } = summarizeMonitoringComponents(components);
    const promComp = components.find((component) => component.name === 'prometheus');
    const grafComp = components.find((component) => component.name === 'grafana');
    const promReady = Boolean(promComp && ['ready', 'external'].includes(promComp.status));
    const grafReady = Boolean(grafComp && ['ready', 'external'].includes(grafComp.status));
    const grafOptional = isOptionalAbsentComponent(grafComp);
    const endpointTotal = grafOptional ? 1 : 2;
    const endpointReady = (promReady ? 1 : 0) + (!grafOptional && grafReady ? 1 : 0);

    const endpointStatus = promReady && (grafReady || grafOptional)
        ? { status: 'ready', label: 'reachable' }
        : promReady || grafReady
            ? { status: 'progressing', label: 'partial' }
            : { status: snapshot?.status === 'absent' ? 'absent' : 'degraded', label: 'unavailable' };

    const probedStatus = snapshot?.status === 'ready'
        ? { status: 'ready', label: 'ready' }
        : snapshot?.status === 'unreachable'
            ? { status: 'unreachable', label: 'unreachable' }
            : readyComponents > 0
                ? { status: 'progressing', label: 'partial' }
                : { status: snapshot?.status === 'absent' ? 'absent' : 'degraded', label: snapshot?.status || 'absent' };

    const accessLabel = snapshot?.access_mode === 'non_admin' ? 'non-admin' : 'admin';
    const modeLabel = snapshot?.monitoring_mode === 'existing' ? 'existing' : 'managed';

    return (
        <div className="grid gap-3 sm:grid-cols-2">
            <StackMetricCard
                icon={<Boxes size={13} />}
                title="Probed components"
                value={readyComponents}
                unit={`/ ${desiredComponents}`}
                status={probedStatus}
                detail={`Discovered via Prometheus HTTP probes (${accessLabel}, ${modeLabel} mode${effectiveNamespace ? `, ${effectiveNamespace}` : ''})`}
            />
            <StackMetricCard
                icon={<Activity size={13} />}
                title="Prometheus & Grafana"
                value={endpointReady}
                unit={`/ ${endpointTotal}`}
                status={endpointStatus}
                detail={`Prometheus: ${promReady ? 'reachable' : (promComp?.status || 'unconfigured')} · Grafana: ${grafReady ? 'reachable' : grafOptional ? 'optional' : (grafComp?.status || 'unconfigured')}`}
            />
        </div>
    );
}

export function ClusterStackSummary({ snapshot, namespace }) {
    const components = snapshot?.components || [];
    const effectiveNamespace = normalizeMonitoringNamespace(namespace || snapshot?.namespace, '');
    const isNonAdmin = snapshot?.access_mode === 'non_admin';
    const isExistingMode = snapshot?.monitoring_mode === 'existing';
    const usesHttpSummary = isNonAdmin || isExistingMode;
    const managed = components.filter((component) => component.source === 'llmd');
    const external = components.filter((component) => component.source === 'cluster');
    const managedReady = managed.filter((component) => component.status === 'ready').length;
    const externalReady = external.filter((component) => ['ready', 'external'].includes(component.status)).length;

    return (
        <section>
            <SectionLabel tone="sky">Live state</SectionLabel>
            {usesHttpSummary ? (
                <NonAdminSummary snapshot={snapshot} components={components} effectiveNamespace={effectiveNamespace} />
            ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                    <StackMetricCard
                        icon={<Boxes size={13} />}
                        title="Managed components"
                        value={managedReady}
                        unit={`/ ${managed.length}`}
                        status={{
                            status: managed.length > 0 && managedReady === managed.length ? 'ready' : 'progressing',
                            label: managed.length > 0 && managedReady === managed.length ? 'ready' : 'partial',
                        }}
                        detail={effectiveNamespace
                            ? `Installed by the llm-d observability stack in ${effectiveNamespace}`
                            : 'Installed by the llm-d observability stack'}
                    />
                    <StackMetricCard
                        icon={<Boxes size={13} />}
                        title="External components"
                        value={externalReady}
                        unit={`/ ${external.length}`}
                        status={{
                            status: external.length > 0 && externalReady === external.length ? 'external' : 'progressing',
                            label: external.length > 0 && externalReady === external.length ? 'external' : 'partial',
                        }}
                        detail="Reused from shared cluster-scoped resources"
                    />
                </div>
            )}
        </section>
    );
}
