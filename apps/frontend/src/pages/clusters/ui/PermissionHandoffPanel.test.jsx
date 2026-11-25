import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CleanupHandoffPanel, PermissionHandoffPanel } from './PermissionHandoffPanel.jsx';
import { MonitoringAdminScriptPanel } from './ClusterMonitoringStack/ClusterStackOperationProgress.jsx';

const RECHECK_BUTTON_RE = /<button\b[^>]*>(?:(?!<\/button>).)*Re-check<\/button>/g;

const REPORT = {
    status: 'admin_required',
    sufficient: false,
    planHash: 'plan-hash',
    userOperations: [{ id: 'storage.pvc', title: 'Create the storage claim' }],
    adminOperations: [
        { id: 'gateway.namespace', title: 'Create the gateway namespace' },
        { id: 'gateway.manifests', title: 'Apply the shared inference Gateway' },
    ],
    lensOperations: [{ id: 'gateway.exposure', title: 'Expose the gateway' }],
    blockedOperations: [],
    missing: [{ operationId: 'gateway.manifests', verb: 'create', resource: 'gateways' }],
    marker: { namespace: 'lens-edit', name: 'lens-admin-handoff-plan', status: 'missing', verified: false, operations: [] },
};

test('handoff panel renders admin operations, script, marker and verify actions', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{ status: 'partial', adminOperations: ['gateway.namespace', 'gateway.manifests'], remainingOperations: ['gateway.manifests'], marker: { ...REPORT.marker, status: 'partial', operations: ['gateway.namespace'] } }}
            script={'#!/usr/bin/env bash\nkubectl apply -f -'}
            filename="lens-admin-operations.sh"
            instructions="Send this to your Orchestration administrator."
            onLoadScript={() => {}}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Orchestration administrator operations/);
    assert.match(html, /Create the gateway namespace/);
    assert.match(html, /Apply the shared inference Gateway/);
    assert.match(html, /Remaining/);
    assert.match(html, /aria-label="Done"/);
    assert.match(html, /aria-label="Remaining"/);
    assert.match(html, /Download/);
    assert.match(html, /Copy/);
    assert.doesNotMatch(html, /Verify completion/);
    assert.equal((html.match(RECHECK_BUTTON_RE) || []).length, 1);
    assert.doesNotMatch(html, /Completion marker/);
    assert.doesNotMatch(html, /lens-admin-handoff-plan/);
    assert.doesNotMatch(html, /Upload kubeconfig/);
    // The panel announces its state and reports errors to assistive technology.
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
});

test('blocked operations stay user-fixable and never show an admin script', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [],
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret' }],
            }}
            script="SHOULD NOT RENDER"
            onLoadScript={() => {}}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Your access needs attention/);
    assert.match(html, /Write the HF token Secret/);
    assert.doesNotMatch(html, /create gateways/);
    assert.doesNotMatch(html, /SHOULD NOT RENDER/);
    assert.doesNotMatch(html, /Verify completion/);
    assert.equal((html.match(RECHECK_BUTTON_RE) || []).length, 1);
    assert.doesNotMatch(html, />Orchestration administrator script</);
});

test('admin operations are unknown until the handoff status loads', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel report={REPORT} script="script" onLoadScript={() => {}} onRecheck={() => {}} />,
    );
    assert.match(html, /Not verified/);
    assert.doesNotMatch(html, />Done</);
});

test('a complete marker without a session token asks the user to verify', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{ ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            handoff={{ status: 'complete', adminOperations: ['gateway.namespace', 'gateway.manifests'], remainingOperations: [], marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            hasToken={false}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /execution token/);
    assert.match(html, /Waiting for verification/);
});

test('the panel can generate a script before one is loaded', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel report={REPORT} onLoadScript={() => {}} onRecheck={() => {}} />,
    );
    assert.match(html, /Generate script/);
    assert.doesNotMatch(html, /Download/);
});

test('errors render once as an alert', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel report={REPORT} error="Could not verify the completion marker" onRecheck={() => {}} />,
    );
    assert.match(html, /Could not verify the completion marker/);
    assert.equal((html.match(/role="alert"/g) || []).length, 1);
});

test('blocked reports with admin operations still show the script and verify action', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret', namespace: 'team-a' }],
                adminOperations: [{ id: 'gateway.namespace', title: 'Create the gateway namespace' }],
                missing: [{ operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets', namespace: 'team-a' }],
            }}
            script="#!/usr/bin/env bash\nkubectl apply -f -"
            onLoadScript={() => {}}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Your access needs attention/);
    assert.match(html, /Create the gateway namespace/);
    assert.match(html, /Orchestration administrator script/);
    assert.match(html, /Download/);
    assert.doesNotMatch(html, /Verify completion/);
    assert.equal((html.match(RECHECK_BUTTON_RE) || []).length, 1);
    assert.match(html, /cache\.hf-secret.*edit identity/s);
    assert.match(html, /team-a/);
    assert.match(html, /never included in the Orchestration administrator script/);
});

test('blocked HF access explains the edit ServiceAccount without offering a token script', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [],
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret', namespace: 'team-b' }],
                missing: [{ operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets', namespace: 'team-b' }],
            }}
            script="SHOULD NOT RENDER"
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Lens executes this with your edit identity/);
    assert.match(html, /team-b/);
    assert.doesNotMatch(html, /SHOULD NOT RENDER/);
    assert.doesNotMatch(html, />Orchestration administrator script</);
});


test('admin section comes first, script precedes admin rows, and user section follows', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{ status: 'partial', adminOperations: ['gateway.namespace', 'gateway.manifests'], remainingOperations: ['gateway.manifests'], marker: { ...REPORT.marker, status: 'partial' } }}
            script="script"
            hasToken={false}
            onRecheck={() => {}}
        />,
    );
    assert.ok(html.indexOf('Orchestration administrator operations') < html.indexOf('Your operations'));
    assert.ok(html.indexOf('Orchestration administrator script') < html.indexOf('Apply the shared inference Gateway'));
    assert.match(html, /Wait for the Orchestration administrator marker/);
    assert.match(html, /Waiting for Orchestration administrator/);
});

test('remaining and done rows default closed, and both expose status icons', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [
                    { id: 'gateway.namespace', title: 'Create the gateway namespace' },
                    { id: 'gateway.manifests', title: 'Apply the shared inference Gateway' },
                ],
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret', namespace: 'team-a' }],
                userOperations: [{ id: 'storage.pvc', title: 'Create the storage claim' }],
            }}
            handoff={{ status: 'partial', adminOperations: ['gateway.namespace', 'gateway.manifests'], remainingOperations: ['gateway.manifests'], marker: { ...REPORT.marker, status: 'partial' } }}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /aria-label="Remaining"/);
    assert.match(html, /aria-label="Done"/);
    assert.match(html, /aria-label="Blocked"/);
    assert.match(html, /aria-label="Ready"/);
    assert.match(html, /Blocked/);
    assert.match(html, /Ready/);
    assert.match(html, /<details class="group\/details[^"]*" open="">/);
    assert.doesNotMatch(html, /<details class="group"[^>]*open/);
    assert.match(html, /<details class="group">/);
    assert.match(html, /Expand for details/);
    assert.match(html, /Create the storage claim/);
});

test('verified admin plus token opens the user gate without a wait message', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{ ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            handoff={{ status: 'complete', adminOperations: ['gateway.namespace', 'gateway.manifests'], remainingOperations: [], marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.doesNotMatch(html, /Wait for the Orchestration administrator marker/);
    assert.match(html, />Ready</);
});

test('an empty report renders one short empty state, not empty cards', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel report={{ status: 'ready', adminOperations: [], userOperations: [], blockedOperations: [] }} />,
    );
    assert.match(html, /No operations required/);
    assert.doesNotMatch(html, />Orchestration administrator script</);
    assert.doesNotMatch(html, /Your operations/);
});


test('marker.verified and a token do not bypass remaining admin operations', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{ ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            handoff={{
                status: 'partial',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.manifests'],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.doesNotMatch(html, /Your operations<\/h3><span[^>]*>Ready/);
    assert.match(html, /Waiting for Orchestration administrator/);
    assert.match(html, /Wait for the Orchestration administrator marker/);
});

test('progressive disclosure outer details auto-expands when not passed with isolated group and summary counts', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'partial',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.manifests'],
                marker: { ...REPORT.marker, status: 'partial', operations: ['gateway.namespace'] },
            }}
            script="script"
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /<details class="group\/details[^"]*" open="">/);
    assert.doesNotMatch(html, /<details class="group"[^>]*open/);
    assert.match(html, /<details class="group\/details /);
    assert.match(html, /group-open\/details:rotate-90/);
    assert.match(html, /<details class="group">/);
    assert.match(html, /View operation details/);
    assert.match(html, /1\/2 Orchestration administrator done · 1 user/);
});

test('unconfirmed marker renders amber Unconfirmed state and 403 Forbidden namespace guidance', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'unconfirmed',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.namespace', 'gateway.manifests'],
                marker: { namespace: 'default', name: 'lens-admin-handoff-abc', status: 'unconfirmed', verified: false, operations: [] },
            }}
            script="script"
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Unconfirmed/);
    assert.match(html, /aria-label="Unconfirmed"/);
    assert.doesNotMatch(html, /aria-label="Remaining"/);
    assert.match(html, /403 Forbidden/);
    assert.match(html, /lens-admin-handoff-abc/);
    assert.match(html, /default/);
    assert.match(html, /2 unconfirmed · 1 user/);
    assert.doesNotMatch(html, /Completion marker/);
});

test('blocked report with verified admin operations shows verified admin summary, Done admin rows, and Change secret namespace', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret', namespace: 'llm-d-bench-storage-123' }],
                missing: [{ operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets', namespace: 'llm-d-bench-storage-123' }],
            }}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { namespace: 'lens-edit', name: 'lens-admin-handoff-plan', status: 'complete', verified: true, operations: ['gateway.namespace', 'gateway.manifests'] },
            }}
            hasToken
            script="SHOULD BE HIDDEN ONCE VERIFIED"
            onEditSecretNamespace={() => {}}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /Your access needs attention/);
    assert.match(html, /Orchestration administrator operations verified \(2\/2 done\)/);
    assert.match(html, /Change secret namespace/);
    assert.match(html, /aria-label="Done"/);
    assert.match(html, /aria-label="Blocked"/);
    assert.match(html, /2\/2 Orchestration administrator done · 1 blocked · 1 ready/);
    assert.doesNotMatch(html, />Orchestration administrator script</);
    assert.doesNotMatch(html, /Verify completion/);
    assert.equal((html.match(RECHECK_BUTTON_RE) || []).length, 1);
});

test('stale marker renders danger Stale badge and calm stale guidance inside status', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'stale',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.namespace', 'gateway.manifests'],
                marker: { ...REPORT.marker, status: 'stale', verified: false },
            }}
            script="script"
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /bg-red-500\/10[^>]*>Stale<\/span>/);
    assert.match(html, /role="status"[^>]*>.*The completion marker belongs to an older plan\. Send the updated Orchestration administrator script below, then click .*Re-check/);
    assert.doesNotMatch(html, /role="alert"/);
});

test('partial handoff renders calm progress guidance inside status without alert', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'partial',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.manifests'],
                marker: { ...REPORT.marker, status: 'partial', operations: ['gateway.namespace'] },
            }}
            script="script"
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /role="status"[^>]*>.*Orchestration administrator handoff is partial \(1\/2 done\)\. Re-run the Orchestration administrator script for the remaining operation\(s\), then click .*Re-check/);
    assert.doesNotMatch(html, /role="alert"/);
});

test('complete marker with remaining operations uses warning tone, not verified', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{ ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: ['gateway.manifests'],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /bg-amber-500\/10[^>]*>Awaiting Orchestration administrator<\/span>/);
    assert.doesNotMatch(html, /bg-emerald-500\/10[^>]*>Verified<\/span>/);
    assert.doesNotMatch(html, /Orchestration administrator marker verified/);
});

test('verified state with token keeps a single ghost Re-check button', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{ ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } }}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    const buttons = html.match(RECHECK_BUTTON_RE) || [];
    assert.equal(buttons.length, 1);
    assert.match(buttons[0], /bg-transparent/);
    assert.doesNotMatch(buttons[0], /bg-sky-500/);
});

test('busy state disables Re-check, renders Working…, and avoids animate-spin on Re-check', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            script="script"
            busy
            onRecheck={() => {}}
        />,
    );
    const buttons = html.match(RECHECK_BUTTON_RE) || [];
    assert.equal(buttons.length, 1);
    assert.match(buttons[0], /disabled=""/);
    assert.doesNotMatch(buttons[0], /animate-spin/);
    assert.match(html, /Working…/);
});

test('blockedHfNamespace uses cache.hf-secret missing rule namespace instead of earlier gateway secrets rule', () => {
    const missing = [
        { operationId: 'gateway.provider.0', verb: 'create', resource: 'secrets', namespace: 'istio-system' },
        { operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets', namespace: 'llm-d-bench-storage-3eaa4a9c' },
    ];
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [{ id: 'gateway.provider.0', title: 'Install gateway provider' }],
                blockedOperations: [
                    {
                        id: 'cache.hf-secret',
                        title: 'Write the HF token Secret',
                        missing: [missing[1]],
                    },
                ],
                missing,
            }}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /secrets<\/span> access in <span[^>]*>llm-d-bench-storage-3eaa4a9c<\/span>/);
    assert.doesNotMatch(html, /secrets<\/span> access in <span[^>]*>istio-system<\/span>/);
});

test('blockedHfNamespace resolves synthetic operation_blocked reports by cache.hf-secret operationId', () => {
    const missing = [
        { operationId: 'gateway.provider.0', verb: 'create', resource: 'secrets', namespace: 'istio-system' },
        { operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets', namespace: 'llm-d-bench-storage-3eaa4a9c' },
    ];
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [{ id: 'gateway.provider.0', title: 'Install gateway provider' }],
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret' }],
                missing,
            }}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /secrets<\/span> access in <span[^>]*>llm-d-bench-storage-3eaa4a9c<\/span>/);
    assert.doesNotMatch(html, /secrets<\/span> access in <span[^>]*>istio-system<\/span>/);
});

test('blockedHfNamespace falls back to the target namespace when cache.hf-secret has no namespace rule', () => {
    const html = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [{ id: 'gateway.provider.0', title: 'Install gateway provider' }],
                blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret' }],
                missing: [
                    { operationId: 'gateway.provider.0', verb: 'create', resource: 'secrets', namespace: 'istio-system' },
                    { operationId: 'cache.hf-secret', verb: 'create', resource: 'secrets' },
                ],
            }}
            onRecheck={() => {}}
        />,
    );
    assert.match(html, /secrets<\/span> access in <span[^>]*>the target namespace<\/span>/);
    assert.doesNotMatch(html, /secrets<\/span> access in <span[^>]*>istio-system<\/span>/);
});

test('canExecute controls the Click Execute below to continue banner guidance and verified state omits Completion marker', () => {
    const verifiedReport = {
        ...REPORT,
        status: 'admin_required',
        marker: { ...REPORT.marker, status: 'complete', verified: true },
    };
    const verifiedHandoff = {
        status: 'complete',
        adminOperations: ['gateway.namespace', 'gateway.manifests'],
        remainingOperations: [],
        marker: { ...REPORT.marker, status: 'complete', verified: true },
    };

    const defaultHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={verifiedReport}
            handoff={verifiedHandoff}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(defaultHtml, /Orchestration administrator marker verified \(2\/2 done\) and execution token ready\./);
    assert.match(defaultHtml, /Click <span[^>]*>Execute<\/span> below to continue\./);
    assert.doesNotMatch(defaultHtml, /Completion marker/);
    assert.doesNotMatch(defaultHtml, /lens-admin-handoff-plan/);

    const allowedHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={verifiedReport}
            handoff={verifiedHandoff}
            hasToken
            canExecute
            onRecheck={() => {}}
        />,
    );
    assert.match(allowedHtml, /Orchestration administrator marker verified \(2\/2 done\) and execution token ready\./);
    assert.match(allowedHtml, /Click <span[^>]*>Execute<\/span> below to continue\./);
    assert.doesNotMatch(allowedHtml, /Completion marker/);
    assert.doesNotMatch(allowedHtml, /lens-admin-handoff-plan/);

    const blockedExecuteHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={verifiedReport}
            handoff={verifiedHandoff}
            hasToken
            canExecute={false}
            onRecheck={() => {}}
        />,
    );
    assert.match(blockedExecuteHtml, /Orchestration administrator marker verified \(2\/2 done\) and execution token ready\./);
    assert.doesNotMatch(blockedExecuteHtml, /Click .*Execute.* below to continue/);
    assert.doesNotMatch(blockedExecuteHtml, /Completion marker/);
    assert.doesNotMatch(blockedExecuteHtml, /lens-admin-handoff-plan/);
});

const CLEANUP_HANDOFF = {
    code: 'cluster_admin_cleanup_required',
    clusterId: '1234abcd',
    detail: 'Edit kubeconfig lacks permission to delete namespace lens-gateway-1234abcd.',
    cleanupDigest: 'digest-1234',
    operations: [
        { id: 'gateway.namespace', title: 'Delete gateway namespace', kind: 'namespace', name: 'lens-gateway-1234abcd', namespace: null, required: true },
    ],
    completedOperations: [
        { id: 'hf-secret.secret', title: 'Delete HF token secret', kind: 'secret', name: 'hf-token-1234abcd', namespace: 'lens-edit', required: true },
    ],
    script: '#!/usr/bin/env bash\nkubectl delete ns lens-gateway-1234abcd --ignore-not-found=true',
    scriptFilename: 'lens-admin-cleanup-1234abcd.sh',
    instructions: 'Ask an Orchestration administrator to run this cleanup script once, then click Re-check & Delete.',
    marker: { namespace: 'lens-edit', name: 'lens-admin-cleanup-1234abcd', status: 'missing', verified: false, operations: [] },
    canVerifyMarker: true,
    confirmRequired: false,
    unreachable: false,
    warnings: ['Shared namespace preserved.'],
};

test('CleanupHandoffPanel renders awaiting-admin script, expanded details, Step A completed ops, and hides force-confirm', () => {
    const html = renderToStaticMarkup(
        <CleanupHandoffPanel handoff={CLEANUP_HANDOFF} />,
    );
    assert.match(html, /Orchestration administrator cleanup required/);
    assert.match(html, />Awaiting Orchestration administrator</);
    assert.match(html, /Shared namespace preserved\./);
    assert.match(html, /Download/);
    assert.match(html, /Copy/);
    assert.match(html, /<details class="group\/details[^"]*" open="">/);
    assert.doesNotMatch(html, /<details class="group"[^>]*open/);
    assert.match(html, /<details class="group">/);
    assert.match(html, /View cleanup operations &amp; script/);
    assert.match(html, /1 remaining · 1 cleaned/);
    assert.match(html, /Delete gateway namespace/);
    assert.match(html, /Delete HF token secret/);
    assert.match(html, /aria-label="Done"/);
    assert.match(html, /Cleaned/);
    assert.match(html, /lens-admin-cleanup-1234abcd/);
    assert.match(html, /<pre[^>]*>.*kubectl delete ns lens-gateway-1234abcd/s);
    assert.doesNotMatch(html, /Confirm &amp; Delete Record/);
    assert.doesNotMatch(html, /type="checkbox"/);
});

test('CleanupHandoffPanel renders stale, partial, and still_present states with matching badges', () => {
    const staleHtml = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                marker: { ...CLEANUP_HANDOFF.marker, status: 'stale' },
            }}
        />,
    );
    assert.match(staleHtml, /bg-red-500\/10[^>]*>Stale<\/span>/);
    assert.match(staleHtml, /outdated cleanup inventory/);
    assert.doesNotMatch(staleHtml, /Confirm &amp; Delete Record/);

    const partialHtml = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                marker: { ...CLEANUP_HANDOFF.marker, status: 'partial' },
            }}
        />,
    );
    assert.match(partialHtml, /bg-amber-500\/10[^>]*>Partial<\/span>/);
    assert.match(partialHtml, /Orchestration administrator cleanup is partial/);
    assert.doesNotMatch(partialHtml, /Confirm &amp; Delete Record/);

    const stillPresentHtml = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                marker: { ...CLEANUP_HANDOFF.marker, status: 'still_present' },
            }}
        />,
    );
    assert.match(stillPresentHtml, /bg-amber-500\/10[^>]*>Still present<\/span>/);
    assert.match(stillPresentHtml, /Target cluster resources are still present/);
    assert.doesNotMatch(stillPresentHtml, /Confirm &amp; Delete Record/);
});

test('CleanupHandoffPanel renders explicit confirmation checkbox and gated danger CTA for unconfirmed and unreachable', () => {
    const unconfirmedDisabled = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                canVerifyMarker: false,
                confirmRequired: true,
                marker: { namespace: 'default', name: 'lens-admin-cleanup-1234abcd', status: 'unconfirmed', verified: false, operations: [] },
            }}
            confirmed={false}
        />,
    );
    assert.match(unconfirmedDisabled, />Unconfirmed</);
    assert.match(unconfirmedDisabled, /403 Forbidden/);
    assert.match(unconfirmedDisabled, /type="checkbox"/);
    assert.match(unconfirmedDisabled, /<button[^>]*disabled=""[^>]*>Confirm &amp; Delete Record<\/button>/);

    const unreachableEnabled = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                code: 'cluster_gateway_cleanup_failed',
                canVerifyMarker: false,
                confirmRequired: true,
                unreachable: true,
                marker: null,
            }}
            confirmed
            error="Cluster still unreachable"
        />,
    );
    assert.match(unreachableEnabled, /Cluster unreachable during cleanup/);
    assert.match(unreachableEnabled, /bg-red-500\/10[^>]*>Unreachable<\/span>/);
    assert.match(unreachableEnabled, /type="checkbox"[^>]*checked=""/);
    assert.doesNotMatch(unreachableEnabled, /<button[^>]*disabled=""[^>]*>Confirm &amp; Delete Record<\/button>/);
    assert.match(unreachableEnabled, /Confirm &amp; Delete Record/);
    assert.equal((unreachableEnabled.match(/role="alert"/g) || []).length, 1);
    assert.match(unreachableEnabled, /Cluster still unreachable/);

    const unreachableBusy = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                code: 'cluster_gateway_cleanup_failed',
                confirmRequired: true,
                unreachable: true,
            }}
            confirmed
            busy
        />,
    );
    assert.match(unreachableBusy, /<button[^>]*disabled=""[^>]*>Confirm &amp; Delete Record<\/button>/);

    const nullMarkerUnconfirmed = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                canVerifyMarker: false,
                confirmRequired: true,
                marker: null,
            }}
        />,
    );
    assert.match(nullMarkerUnconfirmed, />Unconfirmed</);
    assert.doesNotMatch(nullMarkerUnconfirmed, />Awaiting Orchestration administrator</);
    assert.doesNotMatch(nullMarkerUnconfirmed, /403 Forbidden/);
    assert.doesNotMatch(nullMarkerUnconfirmed, /in namespace <span[^>]*>default<\/span>/);
    assert.match(nullMarkerUnconfirmed, /type="checkbox"/);
    assert.match(nullMarkerUnconfirmed, /Confirm &amp; Delete Record/);

    const nullNsMarkerUnconfirmed = renderToStaticMarkup(
        <CleanupHandoffPanel
            handoff={{
                ...CLEANUP_HANDOFF,
                canVerifyMarker: false,
                confirmRequired: true,
                marker: { namespace: null, name: null, status: 'unconfirmed', verified: false, operations: [] },
            }}
        />,
    );
    assert.match(nullNsMarkerUnconfirmed, />Unconfirmed</);
    assert.doesNotMatch(nullNsMarkerUnconfirmed, /403 Forbidden/);
    assert.doesNotMatch(nullNsMarkerUnconfirmed, /in namespace <span[^>]*>default<\/span>/);
    assert.match(nullNsMarkerUnconfirmed, /confirm deletion below once cleanup is complete/);
});

test('blocked Lens operations show Lens Complete guidance instead of user-owned secret copy', () => {
    const standaloneHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                adminOperations: [],
                blockedOperations: [
                    { id: 'gateway.exposure', title: 'Expose the gateway', executor: 'lens', namespace: 'lens-gateway' },
                ],
                missing: [
                    { operationId: 'gateway.exposure', verb: 'create', resource: 'pods/portforward', namespace: 'lens-gateway' },
                ],
            }}
            script="SHOULD NOT RENDER"
            onRecheck={() => {}}
        />,
    );
    assert.match(standaloneHtml, /Fix the blocked access \(1 operation\(s\)\) or adjust the plan, then click/);
    assert.match(standaloneHtml, /These operations cannot be run in the Orchestration administrator script\./);
    assert.match(standaloneHtml, /Lens runs this operation with your kubeconfig during Complete\. Grant the required access \(or adjust the plan\), then re-check\. It cannot be run in the Orchestration administrator script\./);
    assert.doesNotMatch(standaloneHtml, /user-owned access/);
    assert.doesNotMatch(standaloneHtml, /Do not send secret operations to an Orchestration administrator/);
    assert.doesNotMatch(standaloneHtml, /SHOULD NOT RENDER/);

    const combinedAdminReadyHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={{
                ...REPORT,
                status: 'blocked',
                blockedOperations: [
                    { id: 'gateway.exposure', title: 'Expose the gateway', executor: 'lens', namespace: 'lens-gateway' },
                ],
                missing: [
                    { operationId: 'gateway.exposure', verb: 'create', resource: 'pods/portforward', namespace: 'lens-gateway' },
                ],
            }}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { namespace: 'lens-edit', name: 'lens-admin-handoff-plan', status: 'complete', verified: true, operations: ['gateway.namespace', 'gateway.manifests'] },
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(combinedAdminReadyHtml, /Orchestration administrator operations verified \(2\/2 done\); blocked access below still needs attention\./);
    assert.doesNotMatch(combinedAdminReadyHtml, /user-owned secret access below still needs attention/);
    assert.match(combinedAdminReadyHtml, /Lens runs this operation with your kubeconfig during Complete\. Grant the required access \(or adjust the plan\), then re-check\. It cannot be run in the Orchestration administrator script\./);
});

test('PermissionHandoffPanel renders monitoring endpoints badge, URLs, and handoff warnings', () => {
    const healthyHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
                monitoring: {
                    prometheusUrl: 'http://10.0.0.5:30900',
                    grafanaUrl: 'http://10.0.0.5:30300',
                    prometheusNodePort: 30900,
                    grafanaNodePort: 30300,
                    host: '10.0.0.5',
                    checked: true,
                    healthy: true,
                },
                warnings: [],
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(healthyHtml, /Monitoring endpoints/);
    assert.match(healthyHtml, />Healthy</);
    assert.match(healthyHtml, /http:\/\/10\.0\.0\.5:30900/);
    assert.match(healthyHtml, /http:\/\/10\.0\.0\.5:30300/);

    const unreachableHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
                monitoring: {
                    prometheusUrl: 'http://10.0.0.5:30900',
                    grafanaUrl: null,
                    prometheusNodePort: 30900,
                    grafanaNodePort: null,
                    host: '10.0.0.5',
                    checked: true,
                    healthy: false,
                },
                warnings: [
                    'Prometheus at http://10.0.0.5:30900 is not reachable yet; verify NodePort/firewall connectivity and click Re-check before Complete.',
                ],
            }}
            warning="Duplicate warning check"
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(unreachableHtml, /Monitoring endpoints/);
    assert.match(unreachableHtml, />Unreachable</);
    assert.match(unreachableHtml, /http:\/\/10\.0\.0\.5:30900/);
    assert.match(unreachableHtml, /Not reported/);
    assert.match(unreachableHtml, /Prometheus at http:\/\/10\.0\.0\.5:30900 is not reachable yet/);

    const discoveredOnlyHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
                monitoring: {
                    prometheusNodePort: 31900,
                    grafanaNodePort: 31300,
                    host: '10.0.0.8',
                    checked: false,
                    healthy: null,
                },
            }}
            onRecheck={() => {}}
        />,
    );
    assert.match(discoveredOnlyHtml, />Discovered</);
    assert.match(discoveredOnlyHtml, /NodePort 31900/);
    assert.match(discoveredOnlyHtml, /NodePort 31300/);
    assert.match(discoveredOnlyHtml, /10\.0\.0\.8/);

    const uncheckedUnhealthyHtml = renderToStaticMarkup(
        <PermissionHandoffPanel
            report={REPORT}
            handoff={{
                status: 'complete',
                adminOperations: ['gateway.namespace', 'gateway.manifests'],
                remainingOperations: [],
                marker: { ...REPORT.marker, status: 'complete', verified: true },
                monitoring: {
                    checked: false,
                    healthy: false,
                },
                warnings: [
                    'No Prometheus NodePort was reported in the completion marker; verify Prometheus exposure or configure monitoring endpoints.',
                ],
            }}
            hasToken
            onRecheck={() => {}}
        />,
    );
    assert.match(uncheckedUnhealthyHtml, /Monitoring endpoints/);
    assert.match(uncheckedUnhealthyHtml, />Unreachable</);
    assert.match(uncheckedUnhealthyHtml, /Not reported/);
    assert.match(uncheckedUnhealthyHtml, /No Prometheus NodePort was reported/);

    for (const nonCompleteStatus of ['missing', 'partial']) {
        const suppressedWarningsHtml = renderToStaticMarkup(
            <PermissionHandoffPanel
                report={REPORT}
                handoff={{
                    status: nonCompleteStatus,
                    adminOperations: ['gateway.namespace', 'gateway.manifests'],
                    remainingOperations: ['gateway.manifests'],
                    marker: { ...REPORT.marker, status: nonCompleteStatus, verified: false },
                    warnings: ['Should not render while handoff is incomplete'],
                }}
                warning="Active panel warning"
                onRecheck={() => {}}
            />,
        );
        assert.doesNotMatch(suppressedWarningsHtml, /Should not render while handoff is incomplete/);
        assert.match(suppressedWarningsHtml, /Active panel warning/);
    }
});

test('PermissionHandoffPanel auto-expands outer details for all not-passed states and collapses for passed states', () => {
    const notPassedCases = [
        {
            name: 'blocked only',
            props: {
                report: {
                    ...REPORT,
                    status: 'blocked',
                    adminOperations: [],
                    blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret' }],
                },
            },
        },
        {
            name: 'blocked with verified admin and token',
            props: {
                report: {
                    ...REPORT,
                    status: 'blocked',
                    blockedOperations: [{ id: 'cache.hf-secret', title: 'Write the HF token Secret' }],
                },
                handoff: {
                    status: 'complete',
                    adminOperations: ['gateway.namespace', 'gateway.manifests'],
                    remainingOperations: [],
                    marker: { ...REPORT.marker, status: 'complete', verified: true },
                },
                hasToken: true,
            },
        },
        {
            name: 'awaiting admin without handoff',
            props: {
                report: REPORT,
            },
        },
        {
            name: 'unconfirmed marker',
            props: {
                report: REPORT,
                handoff: {
                    status: 'unconfirmed',
                    adminOperations: ['gateway.namespace', 'gateway.manifests'],
                    remainingOperations: ['gateway.namespace', 'gateway.manifests'],
                    marker: { ...REPORT.marker, status: 'unconfirmed', verified: false },
                },
            },
        },
        {
            name: 'stale marker',
            props: {
                report: REPORT,
                handoff: {
                    status: 'stale',
                    adminOperations: ['gateway.namespace', 'gateway.manifests'],
                    remainingOperations: ['gateway.namespace', 'gateway.manifests'],
                    marker: { ...REPORT.marker, status: 'stale', verified: false },
                },
            },
        },
        {
            name: 'adminReady without token',
            props: {
                report: REPORT,
                handoff: {
                    status: 'complete',
                    adminOperations: ['gateway.namespace', 'gateway.manifests'],
                    remainingOperations: [],
                    marker: { ...REPORT.marker, status: 'complete', verified: true },
                },
                hasToken: false,
            },
        },
    ];

    for (const { name, props } of notPassedCases) {
        const html = renderToStaticMarkup(
            <PermissionHandoffPanel {...props} onRecheck={() => {}} />,
        );
        assert.match(html, /<details class="group\/details[^"]*" open="">/, `${name}: expected outer details open`);
        assert.doesNotMatch(html, /<details class="group"[^>]*open/, `${name}: expected inner rows closed`);
        assert.match(html, /<details class="group">/, `${name}: expected inner OperationRow details`);
    }

    const verifiedHandoff = {
        status: 'complete',
        adminOperations: ['gateway.namespace', 'gateway.manifests'],
        remainingOperations: [],
        marker: { ...REPORT.marker, status: 'complete', verified: true },
    };

    const passedCases = [
        {
            name: 'verified with token and default canExecute',
            props: {
                report: { ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } },
                handoff: verifiedHandoff,
                hasToken: true,
            },
        },
        {
            name: 'verified with token and canExecute=false',
            props: {
                report: { ...REPORT, status: 'admin_required', marker: { ...REPORT.marker, status: 'complete', verified: true } },
                handoff: verifiedHandoff,
                hasToken: true,
                canExecute: false,
            },
        },
        {
            name: 'user-ops-only ready report',
            props: {
                report: {
                    status: 'ready',
                    sufficient: true,
                    adminOperations: [],
                    userOperations: [{ id: 'storage.pvc', title: 'Create the storage claim' }],
                    blockedOperations: [],
                },
            },
        },
    ];

    for (const { name, props } of passedCases) {
        const html = renderToStaticMarkup(
            <PermissionHandoffPanel {...props} onRecheck={() => {}} />,
        );
        assert.match(html, /<details class="group\/details /, `${name}: expected outer details rendered`);
        assert.doesNotMatch(html, /<details[^>]*open/, `${name}: expected outer details collapsed`);
    }
});

test('MonitoringAdminScriptPanel auto-expands operation details when script is present and omits details when empty', () => {
    const withScriptHtml = renderToStaticMarkup(
        <MonitoringAdminScriptPanel
            script={'#!/usr/bin/env bash\necho ok'}
            filename="lens-monitoring-admin.sh"
            onRecheck={() => {}}
        />,
    );
    assert.match(withScriptHtml, /<details class="group\/script[^"]*" open="">/);
    assert.match(withScriptHtml, /View operation details &amp; script preview/);

    const emptyScriptHtml = renderToStaticMarkup(
        <MonitoringAdminScriptPanel
            script=""
            onGenerate={() => {}}
            onRecheck={() => {}}
        />,
    );
    assert.doesNotMatch(emptyScriptHtml, /<details/);
});
