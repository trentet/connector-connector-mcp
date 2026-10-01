import fs from "node:fs";
import { PLATFORMS } from "./types.js";
const SOURCE_TYPES = ["literal", "env", "envFile", "fileRegex", "vault", "template"];
function checkSource(s, where, errs) {
    const o = s;
    if (!o || typeof o !== "object" || !SOURCE_TYPES.includes(o.type ?? "")) {
        errs.push(`${where}: invalid source type`);
        return;
    }
    if (o.type === "template")
        for (const [k, v] of Object.entries(o.variables ?? {}))
            checkSource(v, `${where}.variables.${k}`, errs);
}
export function validateRegistry(r) {
    const errors = [];
    const reg = r;
    if (!reg || reg.version !== 1 || !Array.isArray(reg.connectors))
        return { errors: ["registry must be {version:1, connectors:[]}"] };
    const seen = new Set();
    reg.connectors.forEach((c, i) => {
        const w = `connectors[${i}]${c?.id ? `(${c.id})` : ""}`;
        if (!c.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id))
            errors.push(`${w}: id must be kebab-case`);
        if (seen.has(c.id))
            errors.push(`${w}: duplicate id`);
        seen.add(c.id);
        if (!c.name)
            errors.push(`${w}: name required`);
        if (!c.platforms?.length || c.platforms.some((p) => !PLATFORMS.includes(p)))
            errors.push(`${w}: platforms must be a non-empty subset of ${PLATFORMS.join("|")}`);
        if (!c.auth || !["header", "oauth", "none"].includes(c.auth.mode))
            errors.push(`${w}: auth.mode invalid`);
        if (c.auth?.mode === "header" && !c.auth.headerName)
            errors.push(`${w}: header auth needs headerName`);
        if (c.auth?.mode === "header" && !c.auth.headerValue)
            errors.push(`${w}: header auth needs headerValue source`);
        if (c.auth?.mode === "header" && c.platforms?.includes("chatgpt") && !c.urlByPlatform?.chatgpt)
            errors.push(`${w}: ChatGPT cannot send custom headers; provide urlByPlatform.chatgpt (tokenized URL) or drop chatgpt from platforms`);
        for (const [pl, src] of Object.entries(c.urlByPlatform ?? {})) {
            if (!PLATFORMS.includes(pl))
                errors.push(`${w}: urlByPlatform has unknown platform ${pl}`);
            checkSource(src, `${w}.urlByPlatform.${pl}`, errors);
        }
        checkSource(c.url, `${w}.url`, errors);
        if (c.auth?.headerValue)
            checkSource(c.auth.headerValue, `${w}.auth.headerValue`, errors);
    });
    return errors.length ? { errors } : { registry: reg, errors };
}
export function loadRegistry(path) {
    const { registry, errors } = validateRegistry(JSON.parse(fs.readFileSync(path, "utf8")));
    if (!registry)
        throw new Error("invalid registry:\n  " + errors.join("\n  "));
    return registry;
}
//# sourceMappingURL=registry.js.map