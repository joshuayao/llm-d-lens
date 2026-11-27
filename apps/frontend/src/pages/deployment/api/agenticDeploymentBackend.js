import { streamSseRequest } from '../../../shared/api/sse.js';
import { postJson, requestJson } from '../../../shared/api/httpClient.js';

export function listDeploymentVerifications(executionId, signal) {
    return requestJson(`/api/v1/deployments/executions/${encodeURIComponent(executionId)}/verifications`, { signal });
}

export function startDeploymentVerification(executionId, checks, requests) {
    return postJson(`/api/v1/deployments/executions/${encodeURIComponent(executionId)}/verifications`, { checks, requests });
}

export const DEFAULT_REQUIREMENTS = {
    objective: 'balanced', maxAccelerators: '', ttftMs: '', tpotMs: '', providerRef: '', plannerPrompt: '',
    inputTokens: '', outputTokens: '', concurrency: '', requestRate: '',
    prefixReuse: 'unknown', useCase: 'unknown', requiredFeatures: [], forbiddenFeatures: [],
    maxCandidates: '3', maxDuration: '60', allowTrial: false,
};

export function defaultRequirements() {
    return { ...DEFAULT_REQUIREMENTS, requiredFeatures: [], forbiddenFeatures: [] };
}

// The plan owns these; setting them as free-form arguments would conflict with its topology and runtime fields.
const MANAGED_ARGUMENTS = new Set(['model', 'served-model-name', 'host', 'port', 'tensor-parallel-size', 'pipeline-parallel-size',
    'data-parallel-size', 'max-model-len', 'max-num-seqs', 'max-num-batched-tokens', 'gpu-memory-utilization']);

export function servingArguments({ toolCalling = false, toolParser = '', reasoningParser = '', chatTemplate = '', dtype = '', extra = '' }, catalogArguments = []) {
    const values = new Map(catalogArguments.map(item => [item.name, item.value]));
    values.set('enable-auto-tool-choice', toolCalling ? 'true' : 'false');
    if (toolParser) values.set('tool-call-parser', toolParser.trim());
    for (const [name, value] of [['reasoning-parser', reasoningParser], ['chat-template', chatTemplate], ['dtype', dtype]]) {
        if (value) values.set(name, value);
    }
    for (const line of extra.split('\n').map(item => item.trim()).filter(Boolean)) {
        const match = /^(?:--)?([a-z0-9][a-z0-9-]*)(?:=|\s+)(\S.*)$/.exec(line);
        if (!match) throw new Error(`"${line}" must be written as name=value.`);
        if (MANAGED_ARGUMENTS.has(match[1]) || match[1] === 'revision') throw new Error(`--${match[1]} is managed by the plan or model revision.`);
        values.set(match[1], match[2].trim());
    }
    if (values.has('no-enable-auto-tool-choice')) {
        const disabled = values.get('no-enable-auto-tool-choice');
        if (!['true', 'false'].includes(disabled)) throw new Error('Tool calling must be true or false.');
        values.set('enable-auto-tool-choice', disabled === 'true' ? 'false' : 'true');
        values.delete('no-enable-auto-tool-choice');
    }
    const enabled = values.get('enable-auto-tool-choice');
    if (!['true', 'false'].includes(enabled)) throw new Error('Tool calling must be true or false.');
    if (enabled === 'true' && !/^[a-z0-9_]+$/.test(values.get('tool-call-parser') || '')) throw new Error('Tool calling requires a valid tool call parser, for example hermes.');
    if (enabled === 'false') values.delete('tool-call-parser');
    return [...values].map(([name, value]) => ({ name, value }));
}

export const OPTIMIZATION_CONTROLS = [
    ['prefix_routing', 'Prefix-aware routing'],
    ['prefix_cache', 'Engine prefix cache'],
    ['chunked_prefill', 'Chunked prefill'],
    ['external_kv_cache', 'KV cache offload'],
    ['pd_disaggregation', 'Prefill / Decode separation'],
];

export function candidateLabel(candidate) {
    if (!candidate) return 'Deployment plan';
    const parts = [candidate.prefill_replicas ? 'Separate prefill and decode' : 'Combined serving'];
    if (candidate.prefix_routing || candidate.provider_ref === 'precise-prefix-cache-routing') parts.push('prefix-aware routing');
    if (candidate.native_cpu_cache_gib || candidate.provider_ref === 'tiered-prefix-cache') parts.push('CPU KV cache');
    return parts.join(' + ');
}

export function requirementsFromRun(run) {
    const request = run?.request || {};
    const requirements = request.requirements;
    if (!requirements) {
        return {
            ...defaultRequirements(),
            plannerPrompt: request.planner_prompt?.replace(/^(?:balanced|throughput|latency|cost|reliability) priority\.(?: Compare at most \d+ candidates\.)?\s*/, '') || '',
            maxCandidates: String(request.planning_facts?.max_candidates ?? DEFAULT_REQUIREMENTS.maxCandidates),
            maxDuration: String(request.execution_policy?.max_total_duration_minutes ?? DEFAULT_REQUIREMENTS.maxDuration),
            allowTrial: Boolean(request.execution_policy?.allow_trials),
        };
    }
    const workload = requirements.workload || {};
    const text = value => String(value ?? '');
    return {
        objective: requirements.objective,
        maxAccelerators: text(requirements.hard_constraints?.maxAccelerators),
        ttftMs: text(requirements.performance_targets?.ttftMs),
        tpotMs: text(requirements.performance_targets?.tpotMs),
        providerRef: text(requirements.hard_constraints?.providerRef),
        plannerPrompt: request.planner_prompt?.replace(/^(?:balanced|throughput|latency|cost|reliability) priority\.(?: Compare at most \d+ candidates\.)?\s*/, '') || '',
        inputTokens: text(workload.inputTokens), outputTokens: text(workload.outputTokens),
        concurrency: text(workload.concurrency), requestRate: text(workload.requestRate),
        prefixReuse: workload.prefixReuse == null ? DEFAULT_REQUIREMENTS.prefixReuse : workload.prefixReuse ? 'yes' : 'no',
        useCase: workload.prefillHeavy == null ? DEFAULT_REQUIREMENTS.useCase : request.planning_facts?.use_case || DEFAULT_REQUIREMENTS.useCase,
        requiredFeatures: [...(requirements.required_features || [])],
        forbiddenFeatures: [...(requirements.forbidden_features || [])],
        maxCandidates: text(request.planning_facts?.max_candidates || DEFAULT_REQUIREMENTS.maxCandidates),
        maxDuration: text(request.execution_policy?.max_total_duration_minutes || DEFAULT_REQUIREMENTS.maxDuration),
        allowTrial: Boolean(request.execution_policy?.allow_trials),
    };
}

export function deploymentPlanningRequest(draft, values, clusterSessionId, mode, aiProviderId = '') {
    const number = (key, integer = false) => {
        const value = values[key];
        if (value === '' || value == null) return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) {
            throw new Error(`${key} must be a positive ${integer ? 'whole ' : ''}number.`);
        }
        return parsed;
    };
    if (!draft?.model || !draft?.clusterId || !draft?.deploymentName || !clusterSessionId) {
        throw new Error('Choose a model, cluster and deployment name before planning.');
    }
    if (!draft.storageVolumeId) throw new Error('Choose a ready model cache before planning.');
    const concurrency = number('concurrency', true), requestRate = number('requestRate');
    if (concurrency && requestRate) throw new Error('Choose concurrency or request rate, not both.');
    const maxCandidates = number('maxCandidates', true) ?? 3;
    const maxDuration = number('maxDuration', true) ?? 60;
    if (maxCandidates > 10 || maxDuration > 180) throw new Error('Search is limited to 10 candidates and 180 minutes.');
    const budget = number('maxAccelerators', true);
    const inputTokens = number('inputTokens', true), outputTokens = number('outputTokens', true);
    const ttft = number('ttftMs', true), tpot = number('tpotMs', true);
    const plannerPrompt = mode === 'agentic' ? (values.plannerPrompt || '').trim() : '';
    if (plannerPrompt.length > 1800) throw new Error('Deployment preference must be at most 1800 characters.');
    if (plannerPrompt && !aiProviderId) throw new Error('Select an AI provider to interpret your goal, or use the structured traffic and limits.');
    if (mode === 'agentic' && !aiProviderId) throw new Error('Agentic planning requires an AI provider. Add one under AI Providers, or use Manual.');
    const prefillHeavy = ['long-inputs', 'summarization'].includes(values.useCase);
    const prefixReuse = values.prefixReuse === 'unknown' ? null : values.prefixReuse === 'yes';
    // Unspecified prefill-heaviness is derived from mean input/output tokens on the server.
    const workload = { inputTokens, outputTokens, concurrency, requestRate, prefixReuse, prefillHeavy: values.useCase === 'unknown' ? null : prefillHeavy };
    return {
        model: draft.model, deployment_name: draft.deploymentName, description: draft.description || '',
        cluster_session_id: clusterSessionId, storage_type: 'model-cache', storage_volume_id: draft.storageVolumeId,
        replicas: 1, tensor_parallel_size: 1,
        placement_replicas: draft.placementReplicas || 'prefer-same-node',
        placement_node_label: draft.placementNodeLabel || null,
        max_model_len: draft.contextLength, gpu_memory_utilization: draft.gpuMemoryUtilization,
        max_num_seqs: draft.maxNumSeqs, max_num_batched_tokens: draft.maxNumBatchedTokens,
        vllm_arguments: draft.servingOverrides ? [] : draft.vllmArguments || [],
        model_catalog_id: draft.modelCatalogId || null,
        model_catalog_version: draft.modelCatalogVersion || null,
        serving_overrides: draft.servingOverrides || null,
        planning_mode: mode, ai_provider_id: mode === 'agentic' ? aiProviderId || null : null,
        planner_prompt: plannerPrompt || null,
        execution_policy: { mode: 'approval_required', max_total_duration_minutes: maxDuration, allow_trials: mode === 'agentic' && Boolean(values.allowTrial) },
        planning_facts: {
            model_weight_gib: draft.modelWeightGiB, vram_per_gpu_gib: 1, free_gpu_count: 0,
            hardware_capacity_mode: 'free', context_length: draft.contextLength,
            operator_preference: values.objective, max_candidates: mode === 'manual' ? 10 : maxCandidates,
            ttft_slo_ms: ttft, tpot_slo_ms: tpot,
            use_case: values.useCase === 'unknown' ? 'general-chat' : values.useCase,
            workload_profile: {
                mean_input_tokens: inputTokens,
                mean_output_tokens: outputTokens, concurrency, request_rate: requestRate,
                shared_prefix_ratio: prefixReuse === null ? null : prefixReuse ? 1 : 0,
            },
        },
        requirements: {
            model: draft.model, cluster_id: draft.clusterId, objective: values.objective,
            hard_constraints: { maxAccelerators: budget, ...(values.providerRef ? { providerRef: values.providerRef } : {}) },
            workload, performance_targets: { ttftMs: ttft, tpotMs: tpot },
            required_features: values.requiredFeatures || [], forbidden_features: values.forbiddenFeatures || [],
            unknowns: Object.keys(workload).filter(key => workload[key] == null),
        },
    };
}

export function candidateEvidence(run) {
    const id = run.selected_candidate?.id;
    const optimization = run.optimization;
    const measured = optimization?.ranking?.find(item => item.candidate_id === id);
    if (measured && optimization.best_candidate_id === id && optimization.status === 'completed') {
        return 'Best verified candidate within the tested workload and budget';
    }
    if (measured) return 'Measured candidate; not the verified winner';
    const selected = run.candidates?.find(item => item.id === id);
    if (selected?.performance_estimate_source === 'aic_estimate') return 'Predicted performance; not measured here';
    return 'Recommendation; performance not verified';
}

export function streamAgenticRecommendation(payload, onEvent, signal) {
    return streamSseRequest('/api/agentic-deployments/stream', payload, onEvent, signal);
}

export function streamAgenticRefinement(runId, payload, onEvent, signal) {
    return streamSseRequest(`/api/agentic-deployments/${encodeURIComponent(runId)}/refine/stream`, payload, onEvent, signal);
}

/** Checked state and planning intent of the user-selectable optimizations; no cluster access. */
export function previewOptimizations({ model, objective = 'balanced', maxAccelerators, inputTokens, outputTokens, prefixReuse, forbiddenFeatures = [], availableAccelerators }) {
    const positive = value => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
    return postJson('/api/agentic-deployments/optimizations/preview', {
        requirements: {
            model, objective,
            hard_constraints: { maxAccelerators: positive(maxAccelerators) },
            workload: { inputTokens: positive(inputTokens), outputTokens: positive(outputTokens), prefixReuse: prefixReuse == null || prefixReuse === 'unknown' ? null : prefixReuse === 'yes' },
            forbidden_features: forbiddenFeatures,
        },
        available_accelerators: availableAccelerators ?? null,
    });
}

function normalizePermissionTarget(target = {}, targetNamespaces = null, { includeBootstrapDigest = false } = {}) {
    const key = target.key || target.deployment_group_id || target.deploymentGroupId || '';
    const namespace = target.namespace || (key && targetNamespaces?.[key]) || null;
    const deploymentName = target.deployment_name ?? target.deploymentName ?? null;
    const providerRef = target.provider_ref ?? target.providerRef ?? null;
    const preparedPlanId = target.prepared_plan_id ?? target.preparedPlanId ?? null;
    const preparedRequestId = target.prepared_request_id ?? target.preparedRequestId ?? null;
    const storageVolumeId = target.storage_volume_id ?? target.storageVolumeId ?? null;
    const usesStorage = target.uses_storage ?? target.usesStorage ?? Boolean(storageVolumeId);
    const usesLws = target.uses_lws !== undefined ? target.uses_lws : target.usesLws;
    const usesRouter = target.uses_router !== undefined ? target.uses_router : target.usesRouter;
    const eppServiceAccounts = Array.isArray(target.epp_service_accounts)
        ? target.epp_service_accounts
        : (Array.isArray(target.eppServiceAccounts) ? target.eppServiceAccounts : null);
    const namespaceLabels = target.namespace_labels ?? target.namespaceLabels ?? null;
    const hasLabels = namespaceLabels && typeof namespaceLabels === 'object' && Object.keys(namespaceLabels).length > 0;
    const expectedDigest = target.alreadySufficient
        ? null
        : (
            target.expected_digest
            ?? target.expectedDigest
            ?? (includeBootstrapDigest ? target.bootstrapDigest : null)
            ?? null
        );
    return {
        ...(key ? { key } : {}),
        ...(namespace ? { namespace } : {}),
        ...(deploymentName ? { deployment_name: deploymentName } : {}),
        ...(providerRef ? { provider_ref: providerRef } : {}),
        ...(preparedPlanId ? { prepared_plan_id: preparedPlanId } : {}),
        ...(preparedRequestId ? { prepared_request_id: preparedRequestId } : {}),
        ...(storageVolumeId ? { storage_volume_id: storageVolumeId } : {}),
        uses_storage: Boolean(usesStorage || storageVolumeId),
        ...(usesLws !== undefined ? { uses_lws: Boolean(usesLws) } : {}),
        ...(usesRouter !== undefined ? { uses_router: Boolean(usesRouter) } : {}),
        ...(eppServiceAccounts && eppServiceAccounts.length ? { epp_service_accounts: eppServiceAccounts } : {}),
        ...(target.manifest ? { manifest: target.manifest } : {}),
        ...(hasLabels ? { namespace_labels: namespaceLabels } : {}),
        ...(expectedDigest ? { expected_digest: expectedDigest } : {}),
    };
}

export function deploymentPermissionPayload({
    clusterId,
    namespace = null,
    manifest = '',
    namespaceLabels = null,
    agenticDeploymentRunId = null,
    preparedPlanId = null,
    deploymentName = null,
    providerRef = null,
    storageVolumeId = null,
    usesStorage = false,
    usesLws,
    usesRouter,
    eppServiceAccounts,
    subjectOverride = null,
    expectedDigest = null,
    targets = null,
    targetNamespaces = null,
    target_namespaces = null,
} = {}) {
    const hasLabels = namespaceLabels && typeof namespaceLabels === 'object' && Object.keys(namespaceLabels).length > 0;
    const resolvedTargetNamespaces = targetNamespaces ?? target_namespaces ?? null;
    const hasTargetNamespaces = resolvedTargetNamespaces
        && typeof resolvedTargetNamespaces === 'object'
        && Object.keys(resolvedTargetNamespaces).length > 0;
    const hasTargets = Array.isArray(targets) && targets.length > 0;
    const isMultiTarget = hasTargets && targets.length > 1;
    return {
        cluster_id: clusterId,
        ...(namespace ? { namespace } : {}),
        ...(manifest ? { manifest } : {}),
        ...(hasLabels ? { namespace_labels: namespaceLabels } : {}),
        ...(agenticDeploymentRunId ? { agentic_deployment_run_id: agenticDeploymentRunId } : {}),
        ...(preparedPlanId ? { prepared_plan_id: preparedPlanId } : {}),
        ...(deploymentName ? { deployment_name: deploymentName } : {}),
        ...(providerRef ? { provider_ref: providerRef } : {}),
        ...(storageVolumeId ? { storage_volume_id: storageVolumeId } : {}),
        uses_storage: Boolean(usesStorage || storageVolumeId),
        ...(usesLws !== undefined ? { uses_lws: Boolean(usesLws) } : {}),
        ...(usesRouter !== undefined ? { uses_router: Boolean(usesRouter) } : {}),
        ...(Array.isArray(eppServiceAccounts) && eppServiceAccounts.length ? { epp_service_accounts: eppServiceAccounts } : {}),
        ...(subjectOverride ? { subject_override: subjectOverride } : {}),
        ...(expectedDigest && !isMultiTarget ? { expected_digest: expectedDigest } : {}),
        ...(hasTargets ? { targets: targets.map((target) => normalizePermissionTarget(target, resolvedTargetNamespaces)) } : {}),
        ...(hasTargetNamespaces && !hasTargets ? { target_namespaces: resolvedTargetNamespaces } : {}),
    };
}

export function checkDeploymentPermissions(payload) {
    return postJson('/api/v1/deployments/permission-check', payload);
}

export function generateDeploymentBootstrapScript(payload) {
    if (Array.isArray(payload?.targets) && payload.targets.length > 0) {
        return postJson('/api/v1/deployments/permission-remediation', {
            ...payload,
            targets: payload.targets.map((target) => normalizePermissionTarget(target)),
        });
    }
    return postJson('/api/v1/deployments/permission-remediation', payload);
}

export function verifyDeploymentBootstrap(payload) {
    if (Array.isArray(payload?.targets) && payload.targets.length > 0) {
        const isMultiTarget = payload.targets.length > 1;
        const { expected_digest: topLevelDigest, ...rest } = payload;
        return postJson('/api/v1/deployments/admin-handoff/verify', {
            ...rest,
            ...(!isMultiTarget && topLevelDigest ? { expected_digest: topLevelDigest } : {}),
            targets: payload.targets.map((target) => normalizePermissionTarget(target, null, { includeBootstrapDigest: true })),
        });
    }
    return postJson('/api/v1/deployments/admin-handoff/verify', payload);
}

export function verifyDeploymentCleanup(executionId, payload = {}) {
    return postJson(`/api/v1/deployments/executions/${encodeURIComponent(executionId)}/cleanup-verify`, payload);
}

export function isDeploymentAdminSetupError(error) {
    const code = error?.code || error?.body?.code || error?.body?.detail?.code || '';
    return (error?.status === 403 || error?.status === 409) && code === 'deployment_admin_setup_required';
}

export function parseDeploymentAdminSetupError(error) {
    if (!isDeploymentAdminSetupError(error)) return null;
    const rawBody = error?.body && typeof error.body === 'object' ? error.body : {};
    const body = rawBody.detail && typeof rawBody.detail === 'object' && !Array.isArray(rawBody.detail)
        ? { ...rawBody.detail, ...rawBody }
        : rawBody;
    const targets = Array.isArray(body.targets) ? body.targets : [];
    const namespaces = Array.isArray(body.namespaces) && body.namespaces.length
        ? body.namespaces.filter(Boolean)
        : (targets.length
            ? targets.map((item) => item?.namespace).filter(Boolean)
            : (body.namespace ? [body.namespace] : []));
    const targetNamespaces = {};
    if (body.target_namespaces && typeof body.target_namespaces === 'object') {
        Object.assign(targetNamespaces, body.target_namespaces);
    } else if (body.targetNamespaces && typeof body.targetNamespaces === 'object') {
        Object.assign(targetNamespaces, body.targetNamespaces);
    } else {
        for (const target of targets) {
            if (target?.key && target?.namespace) {
                targetNamespaces[target.key] = target.namespace;
            }
        }
    }
    return {
        code: 'deployment_admin_setup_required',
        detail: (typeof body.detail === 'string' && body.detail) || error?.message || '',
        clusterId: body.clusterId ?? body.cluster_id ?? null,
        namespace: body.namespace || namespaces[0] || '',
        namespaces,
        targets,
        targetNamespaces,
        identity: body.identity || null,
        adminOperations: Array.isArray(body.adminOperations) ? body.adminOperations : [],
        userOperations: Array.isArray(body.userOperations) ? body.userOperations : [],
        missing: Array.isArray(body.missing) ? body.missing : [],
        warnings: Array.isArray(body.warnings) ? body.warnings : [],
        marker: body.marker && typeof body.marker === 'object' ? body.marker : null,
        script: typeof body.script === 'string' ? body.script : '',
        scriptFilename: body.scriptFilename || body.filename || 'lens-deployment-bootstrap.sh',
        instructions: body.instructions || '',
        bootstrapDigest: body.bootstrapDigest || body.digest || null,
        report: body,
    };
}

export function formatHandoffNamespace(adminHandoff) {
    const namespaces = Array.isArray(adminHandoff?.namespaces)
        ? adminHandoff.namespaces.filter(Boolean)
        : (Array.isArray(adminHandoff?.targets)
            ? adminHandoff.targets.map((target) => target?.namespace).filter(Boolean)
            : []);
    if (namespaces.length > 1) {
        return `${namespaces[0]} (+${namespaces.length - 1} more)`;
    }
    return namespaces[0] || adminHandoff?.namespace || '';
}

export function mergeBootstrapRemediationTargets(existingTargets = [], remediationTargets = []) {
    if (!Array.isArray(remediationTargets) || !remediationTargets.length) {
        return Array.isArray(existingTargets) ? existingTargets : [];
    }
    if (!Array.isArray(existingTargets) || !existingTargets.length) {
        return remediationTargets;
    }
    return existingTargets.map((target) => {
        const match = remediationTargets.find((candidate) => (
            (target.key && candidate.key === target.key)
            || (target.namespace && candidate.namespace === target.namespace)
        ));
        if (!match) return target;
        const nextDigest = match.alreadySufficient
            ? null
            : (match.bootstrapDigest !== undefined ? match.bootstrapDigest : target.bootstrapDigest);
        const merged = {
            ...target,
            ...match,
            ...(nextDigest !== undefined ? { bootstrapDigest: nextDigest } : {}),
        };
        if (match.alreadySufficient) {
            delete merged.expected_digest;
            delete merged.expectedDigest;
        }
        return merged;
    });
}

export function verifiedTargetNamespacesMap(verifyResult, fallbackTargets = []) {
    const sourceTargets = Array.isArray(verifyResult?.targets) && verifyResult.targets.length
        ? verifyResult.targets
        : (Array.isArray(fallbackTargets) ? fallbackTargets : []);
    const entries = sourceTargets
        .filter((target) => target?.key && target?.namespace)
        .map((target) => [target.key, target.namespace]);
    return entries.length ? Object.fromEntries(entries) : null;
}

export function isDeploymentCleanupHandoffError(error) {
    const code = error?.code || error?.body?.code || '';
    return error?.status === 409 && code === 'deployment_cleanup_permission_denied';
}

export function parseDeploymentCleanupHandoff(error) {
    if (!isDeploymentCleanupHandoffError(error)) return null;
    const body = error?.body && typeof error.body === 'object' ? error.body : {};
    const cleanup = body.adminCleanup && typeof body.adminCleanup === 'object' ? body.adminCleanup : body;
    const canVerifyMarker = Boolean(cleanup.canVerifyMarker ?? body.canVerifyMarker);
    return {
        code: 'deployment_cleanup_permission_denied',
        executionId: body.executionId ?? cleanup.executionId ?? null,
        clusterId: body.clusterId ?? cleanup.clusterId ?? null,
        namespace: body.namespace ?? cleanup.namespace ?? null,
        phase1Completed: Boolean(body.phase1Completed ?? cleanup.phase1Completed ?? true),
        deletedInNamespace: Array.isArray(body.deletedInNamespace) ? body.deletedInNamespace : [],
        detail: (typeof body.detail === 'string' && body.detail) || cleanup.detail || error?.message || '',
        cleanupDigest: cleanup.cleanupDigest ?? body.cleanupDigest ?? null,
        operations: Array.isArray(cleanup.operations) ? cleanup.operations : [],
        completedOperations: Array.isArray(cleanup.completedOperations)
            ? cleanup.completedOperations
            : (Array.isArray(body.deletedInNamespace) ? body.deletedInNamespace : []),
        script: typeof (cleanup.script ?? body.script) === 'string' ? (cleanup.script ?? body.script) : '',
        scriptFilename: cleanup.scriptFilename || cleanup.filename || body.scriptFilename || 'lens-deployment-cleanup.sh',
        instructions: cleanup.instructions || body.instructions || '',
        marker: cleanup.marker && typeof cleanup.marker === 'object' ? cleanup.marker : null,
        canVerifyMarker,
        confirmRequired: Boolean(cleanup.confirmRequired ?? body.confirmRequired ?? !canVerifyMarker),
        unreachable: Boolean(cleanup.unreachable ?? body.unreachable),
        warnings: Array.isArray(cleanup.warnings) ? cleanup.warnings : [],
        status: (typeof cleanup.status === 'string' && cleanup.status)
            || (typeof body.status === 'string' && body.status)
            || 'pending_admin_cleanup',
    };
}
