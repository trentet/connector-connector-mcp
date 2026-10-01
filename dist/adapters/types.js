/** Placeholder until the real adapter lands in P3; keeps the runner/CLI/tests honest meanwhile. */
export function notImplementedAdapter(platform) {
    const ni = async () => ({ status: "not-implemented", detail: `${platform} adapter lands in P3` });
    return { platform, list: async () => ({ names: [] }), add: ni, remove: ni, update: ni, verify: ni, probe: ni };
}
//# sourceMappingURL=types.js.map