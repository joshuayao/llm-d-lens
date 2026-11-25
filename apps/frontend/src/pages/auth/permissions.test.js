import assert from 'node:assert/strict';
import test from 'node:test';

import { canAccessView, hasPermission, permissionMatches, VIEW_PERMISSIONS } from './permissions.js';
import { NAVIGATION_GROUPS } from '../../app/routes/views.js';

test('permissionMatches supports segment wildcards', () => {
    assert.equal(permissionMatches('deployment:run:read', 'deployment:run:read'), true);
    assert.equal(permissionMatches('deployment:*:*', 'deployment:run:create'), true);
    assert.equal(permissionMatches('*:*:read', 'cluster:cluster:read'), true);
    assert.equal(permissionMatches('deployment:run:read', 'deployment:run:create'), false);
    assert.equal(permissionMatches('deployment:run', 'deployment:run:create'), false);
});

test('hasPermission returns true when any grant matches', () => {
    const permissions = ['deployment:run:read', 'cluster:*:*'];
    assert.equal(hasPermission(permissions, 'cluster:cluster:delete'), true);
    assert.equal(hasPermission(permissions, 'storage:volume:delete'), false);
    assert.equal(hasPermission(permissions, ''), true);
});

test('hasPermission supports any-of arrays including VIEW_PERMISSIONS', () => {
    const clusterMonitoring = VIEW_PERMISSIONS['cluster-monitoring-stack'];
    assert.equal(hasPermission(['monitoring:cluster-stack:read'], clusterMonitoring), true);
    assert.equal(hasPermission(['monitoring:accelerator:read'], clusterMonitoring), true);
    assert.equal(hasPermission(['cluster:cluster:read'], clusterMonitoring), false);

    assert.equal(hasPermission([], []), true);
    assert.equal(hasPermission(['deployment:run:read'], ['evaluate:run:read', 'deployment:run:read']), true);
    assert.equal(hasPermission(['deployment:run:read'], ['evaluate:run:read', 'storage:volume:read']), false);
    assert.equal(hasPermission(['monitoring:*:read'], ['cluster:cluster:read', 'monitoring:accelerator:read']), true);
});

test('permissionMatches and hasPermission fail closed on non-string and non-array inputs', () => {
    for (const invalid of [null, undefined, 123, {}, ['a:b:c']]) {
        assert.equal(permissionMatches(invalid, 'cluster:cluster:read'), false);
        assert.equal(permissionMatches('cluster:cluster:read', invalid), false);
    }
    for (const invalidRequired of [123, 0, false, NaN, {}, { code: 'cluster:cluster:read' }]) {
        assert.equal(hasPermission(['*:*:*'], invalidRequired), false);
    }
    for (const falsyOrNested of [
        ['admin:secret:read', ''],
        ['admin:secret:read', null],
        ['admin:secret:read', undefined],
        [[]],
        ['admin:secret:read', []],
        [['cluster:cluster:read']],
        ['', null, undefined, [], false, 0],
    ]) {
        assert.equal(hasPermission([], falsyOrNested), false);
        assert.equal(hasPermission(null, falsyOrNested), false);
    }
    assert.equal(hasPermission(['*:*:*'], ['', null, undefined, [], false, 0]), false);
    assert.equal(hasPermission(['*:*:*'], [['cluster:cluster:read']]), false);
    for (const invalidPermissions of [null, 'cluster:cluster:read', {}]) {
        assert.equal(hasPermission(invalidPermissions, 'cluster:cluster:read'), false);
        assert.equal(hasPermission(invalidPermissions, ['cluster:cluster:read']), false);
        assert.equal(hasPermission(invalidPermissions, ''), true);
        assert.equal(hasPermission(invalidPermissions, []), true);
    }
});

test('canAccessView enforces the route catalog', () => {
    assert.equal(canAccessView(['deployment:run:read'], 'model-market'), true);
    assert.equal(canAccessView(['cluster:cluster:read'], 'welcome'), true);
    assert.equal(canAccessView(['cluster:cluster:read'], 'welcome/issues'), true);
    assert.equal(canAccessView(['deployment:run:read'], 'admin/users'), false);
    assert.equal(canAccessView(['user:user:read'], 'admin/users'), true);
    assert.equal(canAccessView([], 'unknown-view'), true);
});

// Every sidebar entry in LeftNavigation must be permission-mapped (an unmapped
// view id would be visible to everyone because canAccessView allows unknowns).
const NAV_VIEWS = NAVIGATION_GROUPS.flatMap(group => group.items.map(item => item.view));

test('every sidebar view has a permission mapping', () => {
    for (const view of NAV_VIEWS) {
        assert.equal(canAccessView([], view), false, `${view} is not permission-mapped`);
    }
});

test('a model-service consumer only sees their usage, API keys and services', () => {
    const consumer = ['model-service:token:manage', 'model-service:inference:use', 'model-service:usage:read'];
    for (const view of NAV_VIEWS) {
        const expected = ['model-service', 'usage', 'api-keys'].includes(view);
        assert.equal(canAccessView(consumer, view), expected, `${view} visibility for a model-service consumer`);
    }
});
