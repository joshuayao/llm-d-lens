// Hardware identity and defaults shared by Node planning and browser consumers.
export function profileForKey(profiles, key) {
    return profiles.find(profile => [profile.id, profile.vendor, profile.benchmark_profile, profile.upstream_variant, ...(profile.accelerator_keys || [])].includes(key)) || null;
}

export function profileForHardware(profiles, hardware) {
    const identities = (hardware?.accelerators || []).map(item => item?.id || item);
    const matches = profiles.filter(profile => identities.some(key => profileForKey([profile], key)));
    return matches.length === 1 ? matches[0] : null;
}

export function aicSystemForHardware(profiles, hardware) {
    const profile = profileForHardware(profiles, hardware);
    if (!profile) return null;
    const accelerators = hardware?.accelerators || [];
    const identities = accelerators.flatMap(item => (
        typeof item === 'string' ? [item] : [item?.model, item?.name, item?.id, ...(item?.models || [])]
    )).filter(Boolean);
    for (const mapping of profile.planning?.aic_system_models || []) {
        try {
            if (identities.some(identity => new RegExp(mapping.pattern, 'i').test(String(identity)))) return mapping.system;
        } catch {
            // Invalid plugin patterns are ignored like other optional profile matchers.
        }
    }
    return null;
}

export function profileForResource(profiles, resource) {
    return profiles.find(profile => !(profile.monitor_resource_suffixes || []).some(suffix => resource.endsWith(suffix))
        && (profile.resource_prefixes || []).some(prefix => resource.startsWith(prefix))) || null;
}

// A profile's canonical plugin-mode extended-resource name(s) -- the exact
// keys Lens requests when scheduling workloads (falls back to a single
// deployment.resource_name when modes.plugin.resource_names is unset).
export function acceleratorResourceNames(profile) {
    const pluginNames = profile?.deployment?.modes?.plugin?.resource_names;
    if (Array.isArray(pluginNames) && pluginNames.length) return pluginNames;
    return profile?.deployment?.resource_name ? [profile.deployment.resource_name] : [];
}

// Sum extended-resource accelerator counts (node allocatable, container
// resources, ...) without double counting a profile's derived/oversubscribed
// resource names. NVIDIA GPU time-slicing, for example, adds
// `nvidia.com/gpu.shared` (the replica pool) alongside the unchanged
// `nvidia.com/gpu` (the physical cards) -- both match the `nvidia.com/gpu`
// prefix, so naively summing every matching key read 7 physical cards as 77.
// When a profile's canonical resource name is present, only that exact key is
// counted and the profile's other matching keys are skipped; the broader
// prefix match remains a fallback for nodes exposing only a derived/renamed
// resource (no canonical key at all), so those still count instead of
// reading zero.
export function acceleratorTotal(profiles, resources) {
    const data = resources || {};
    const counted = new Set();
    let total = 0;
    for (const profile of profiles) {
        const canonical = acceleratorResourceNames(profile).filter(name => Object.prototype.hasOwnProperty.call(data, name));
        if (!canonical.length) continue;
        for (const name of canonical) {
            total += Number(data[name]) || 0;
            counted.add(name);
        }
        for (const key of Object.keys(data)) {
            if (!counted.has(key) && profileForResource([profile], key)) counted.add(key);
        }
    }
    for (const [name, value] of Object.entries(data)) {
        if (counted.has(name)) continue;
        if (profileForResource(profiles, name)) total += Number(value) || 0;
    }
    return total;
}

export function imageRepository(image) {
    const value = String(image || '').split('@')[0];
    return value.slice(value.lastIndexOf('/') + 1).includes(':') ? value.slice(0, value.lastIndexOf(':')) : value;
}

export function managedImageProfile(profiles, image) {
    const repository = imageRepository(image);
    return profiles.find(profile => [profile.deployment?.runtime_image, ...(profile.deployment?.managed_image_repositories || [])].some(value => value && imageRepository(value) === repository)) || null;
}

export function overlayRoot(profile, guide, modelServer) {
    const template = profile?.deployment?.overlay_root;
    if (!template) throw new Error('Hardware profile has no deployment overlay root');
    return template.replaceAll('{guide}', guide).replaceAll('{variant}', profile.upstream_variant).replaceAll('{model_server}', modelServer).replace(/\/$/, '');
}

export function matchOverlayPath(profile, sourcePath) {
    const template = profile?.deployment?.overlay_root;
    if (!template) return null;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = template.split(/(\{guide\}|\{variant\}|\{model_server\})/);
    const pattern = parts.map(part => part === '{guide}' ? '(?<guide>[^/]+)' : part === '{model_server}' ? '(?<modelServer>[^/]+)' : part === '{variant}' ? escape(profile.upstream_variant || '') : escape(part)).join('');
    const match = sourcePath.match(new RegExp(`^${pattern}/(?<relative>.+)$`));
    return match?.groups ? { guide: match.groups.guide, modelServer: match.groups.modelServer || template.split('/').at(-1), relative: match.groups.relative } : null;
}
