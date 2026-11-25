import { requestJson, requestJsonWithMeta } from './httpClient.js';

function tagProtocol(error) {
    if (error.status && !error.code) error.code = `HTTP_${error.status}`;
    return error;
}

export async function requestMonitoringJson(path, options = {}) {
    try {
        return await requestJson(path, options, { fallback: null });
    } catch (error) {
        throw tagProtocol(error);
    }
}

/** Monitoring JSON request that also returns the response for header reads. */
export async function requestMonitoringJsonWithMeta(path, options = {}) {
    try {
        return await requestJsonWithMeta(path, options, { fallback: null });
    } catch (error) {
        throw tagProtocol(error);
    }
}
