// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAcceleratorStatus } from './acceleratorObservabilityBackend';

const RETRY_DELAYS = [5000, 10000, 20000, 30000];

export function useAcceleratorObservability(
    accelerator,
    namespace,
    accessMode,
    clusterId,
    { monitoringNamespace, enabled = true } = {},
) {
    const canQuery = Boolean(enabled && clusterId && accelerator && namespace);
    const queryKey = canQuery
        ? `${clusterId}::${accelerator}::${namespace}::${accessMode || ''}::${monitoringNamespace || ''}`
        : '';
    const [state, setState] = useState({
        key: '',
        data: null,
        error: null,
        loading: false,
        stale: false,
        lastUpdated: null,
    });
    const controllerRef = useRef(null);
    const failureCountRef = useRef(0);
    const hasDataKeyRef = useRef('');

    const refresh = useCallback(async () => {
        if (!canQuery) return null;
        const targetKey = queryKey;
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        if (hasDataKeyRef.current !== targetKey) {
            setState((current) => (
                current.key === targetKey
                    ? { ...current, loading: true }
                    : {
                        key: targetKey,
                        data: null,
                        error: null,
                        loading: true,
                        stale: false,
                        lastUpdated: null,
                    }
            ));
        }

        try {
            const snapshot = await getAcceleratorStatus(accelerator, {
                namespace,
                accessMode,
                monitoringNamespace,
                signal: controller.signal,
                clusterId,
            });
            if (controller.signal.aborted) return null;
            failureCountRef.current = 0;
            hasDataKeyRef.current = targetKey;
            setState({
                key: targetKey,
                data: snapshot,
                error: null,
                loading: false,
                stale: Boolean(snapshot?.stale),
                lastUpdated: new Date(),
            });
            return snapshot;
        } catch (requestError) {
            if (requestError.name === 'AbortError') return null;
            failureCountRef.current += 1;
            setState((current) => ({
                key: targetKey,
                data: current.key === targetKey ? current.data : null,
                error: requestError,
                loading: false,
                stale: true,
                lastUpdated: current.key === targetKey ? current.lastUpdated : null,
            }));
            return null;
        }
    }, [accelerator, namespace, accessMode, monitoringNamespace, clusterId, canQuery, queryKey]);

    useEffect(() => {
        failureCountRef.current = 0;
        if (!canQuery) {
            hasDataKeyRef.current = '';
        }
    }, [canQuery, queryKey]);

    useEffect(() => {
        if (!canQuery) return undefined;

        let cancelled = false;
        let timer = null;

        const schedule = () => {
            if (cancelled || document.hidden) return;
            const failures = failureCountRef.current;
            const delay = failures
                ? RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)]
                : RETRY_DELAYS[0];
            timer = window.setTimeout(run, delay);
        };

        const run = async () => {
            await refresh();
            schedule();
        };

        const onVisibilityChange = () => {
            window.clearTimeout(timer);
            if (!document.hidden) run();
            else controllerRef.current?.abort();
        };

        if (!document.hidden) run();
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            controllerRef.current?.abort();
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    }, [refresh, canQuery]);

    const matchesKey = Boolean(queryKey) && state.key === queryKey;
    return {
        data: matchesKey ? state.data : null,
        error: matchesKey ? state.error : null,
        loading: canQuery ? (!matchesKey || state.loading) : false,
        stale: matchesKey ? state.stale : false,
        lastUpdated: matchesKey ? state.lastUpdated : null,
        refresh,
    };
}
