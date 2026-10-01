import fs from "node:fs";
import { HEADERLESS_PLATFORMS, PLATFORMS, type ConnectorDef, type Registry, type Source } from "./types.js";

const SOURCE_TYPES = ["literal", "env", "envFile", "fileRegex", "vault", "template"];

function checkSource(s: unknown, where: string, errs: string[]): void {
  const o = s as { type?: string; variables?: Record<string, unknown> };
  if (!o || typeof o !== "object" || !SOURCE_TYPES.includes(o.type ?? "")) { errs.push(`${where}: invalid source type`); return; }
  if (o.type === "template") for (const [k, v] of Object.entries(o.variables ?? {})) checkSource(v, `${where}.variables.${k}`, errs);
}

export function validateRegistry(r: unknown): { registry?: Registry; errors: string[] } {
  const errors: string[] = [];
  const reg = r as Registry;
  if (!reg || reg.version !== 1 || !Array.isArray(reg.connectors)) return { errors: ["registry must be {version:1, connectors:[]}"] };
  const seen = new Set<string>();
  reg.connectors.forEach((c: ConnectorDef, i) => {
    const w = `connectors[${i}]${c?.id ? `(${c.id})` : ""}`;
    if (!c.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errors.push(`${w}: id must be kebab-case`);
    if (seen.has(c.id)) errors.push(`${w}: duplicate id`);
    seen.add(c.id);
    if (!c.name) errors.push(`${w}: name required`);
    if (!c.platforms?.length || c.platforms.some((p) => !PLATFORMS.includes(p))) errors.push(`${w}: platforms must be a non-empty subset of ${PLATFORMS.join("|")}`);
    if (!c.auth || !["header", "oauth", "none"].includes(c.auth.mode)) errors.push(`${w}: auth.mode invalid`);
    if (c.auth?.mode === "header" && !c.auth.headerName) errors.push(`${w}: header auth needs headerName`);
    if (c.auth?.mode === "header" && !c.auth.headerValue) errors.push(`${w}: header auth needs headerValue source`);
    if (c.auth?.mode === "header") for (const hp of HEADERLESS_PLATFORMS) if (c.platforms?.includes(hp) && !c.urlByPlatform?.[hp]) errors.push(`${w}: ${hp} cannot send custom headers; provide urlByPlatform.${hp} (tokenized URL) or drop ${hp} from platforms`);
    for (const [pl, src] of Object.entries(c.urlByPlatform ?? {})) {
      if (!PLATFORMS.includes(pl as never)) errors.push(`${w}: urlByPlatform has unknown platform ${pl}`);
      checkSource(src, `${w}.urlByPlatform.${pl}`, errors);
    }
    checkSource(c.url as Source, `${w}.url`, errors);
    if (c.auth?.headerValue) checkSource(c.auth.headerValue, `${w}.auth.headerValue`, errors);
  });
  return errors.length ? { errors } : { registry: reg, errors };
}

export function loadRegistry(path: string): Registry {
  const { registry, errors } = validateRegistry(JSON.parse(fs.readFileSync(path, "utf8")));
  if (!registry) throw new Error("invalid registry:\n  " + errors.join("\n  "));
  return registry;
}
