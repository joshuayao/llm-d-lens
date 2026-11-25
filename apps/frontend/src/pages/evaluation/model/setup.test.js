import fs from 'node:fs';
import { DEFAULT_RUNTIME_IMAGES, runtimeImageRepository, setHardwareProfiles } from '../ui/benchmark-results/acceleratorDisplay.js';
setHardwareProfiles(['intel_xpu', 'nvidia'].map(name => JSON.parse(fs.readFileSync(new URL(`../../../../../backend/src/llm_d_lens/hardware/profiles/${name}.json`, import.meta.url), 'utf8'))));
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesEvaluationSetup, retainCompatibleConfigurations } from './setup.js';

const setup = {
    cluster: { id: 'cluster-a' }, model: 'Qwen/Qwen3-0.6B', modelServer: 'vllm',
    image: 'example/runtime:v1', imageMode: 'use-upstream-image', buildSourceUrl: '',
    modelSource: 'auto-cache', storageVolumeId: 'cache-a', modelPath: '/models',
};
const artifact = (id, overrides = {}) => ({
    artifact_id: id,
    deployable_configuration: {
        provenance: { cluster_ref: { id: 'cluster-a' } },
        content: { model: { name: setup.model }, runtime: {
            modelServer: 'vLLM', image: setup.image, modelSource: setup.modelSource,
            storageVolumeId: setup.storageVolumeId, ...overrides,
        } },
    },
});

test('back/continue retains all selected variants, without adding other saved artifacts', () => {
    const artifacts = [artifact('a'), artifact('b'), artifact('unselected')];
    assert.deepEqual(retainCompatibleConfigurations(artifacts, ['b', 'a'], setup), ['b', 'a']);
    assert.deepEqual(retainCompatibleConfigurations(artifacts, [], setup), []);
    assert.equal(matchesEvaluationSetup(artifacts[0], setup), true);
});

test('changed model, cluster, runtime, image, or cache invalidates an immutable saved configuration', () => {
    for (const change of [
        { model: 'Qwen/Qwen3-8B' }, { cluster: { id: 'cluster-b' } },
        { modelServer: 'vllm-rdma' }, { image: 'example/runtime:v2' },
        { storageVolumeId: 'cache-b' }, { modelSource: 'huggingface' },
        { imageMode: 'build-from-source', buildSourceUrl: 'https://example.org/runtime' },
    ]) {
        assert.equal(matchesEvaluationSetup(artifact('a'), { ...setup, ...change }), false, JSON.stringify(change));
    }
});

test('shared paths and image build sources must match while irrelevant cache fields are ignored', () => {
    const shared = { ...setup, modelSource: 'shared-path', imageMode: 'build-from-source', buildSourceUrl: 'https://example.org/runtime' };
    const saved = artifact('a', { modelSource: 'shared-path', mountPath: '/models', imageMode: shared.imageMode, buildSourceUrl: shared.buildSourceUrl });
    assert.equal(matchesEvaluationSetup(saved, shared), true);
    assert.equal(matchesEvaluationSetup(saved, { ...shared, storageVolumeId: 'unused' }), true);
    assert.equal(matchesEvaluationSetup(saved, { ...shared, modelPath: '/other' }), false);
    assert.equal(matchesEvaluationSetup(saved, { ...shared, buildSourceUrl: 'https://example.org/other' }), false);
});

test('sameRuntimeImage requires exact match when both carry tags/digests and falls back to repo only when repo-only', () => {
    const profileImage = Object.values(DEFAULT_RUNTIME_IMAGES)[0];
    const profileRepo = runtimeImageRepository(profileImage);
    const customTag = `${profileRepo}:custom-tag`;
    const digestImage = `${profileRepo}@sha256:${'a'.repeat(64)}`;

    assert.equal(matchesEvaluationSetup(artifact('a', { image: profileImage }), { ...setup, image: profileImage }), true);
    assert.equal(matchesEvaluationSetup(artifact('a', { image: profileImage }), { ...setup, image: customTag }), false);
    assert.equal(matchesEvaluationSetup(artifact('a', { image: profileImage }), { ...setup, image: digestImage }), false);
    assert.equal(matchesEvaluationSetup(artifact('a', { image: profileImage }), { ...setup, image: profileRepo }), true);
    assert.equal(matchesEvaluationSetup(artifact('a', { image: profileRepo }), { ...setup, image: customTag }), true);
    assert.equal(matchesEvaluationSetup(artifact('a', { image: 'registry.corp/vllm:v1' }), { ...setup, image: 'registry.corp/vllm' }), false);
});
