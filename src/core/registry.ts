import fs from "node:fs";
import { HEADERLESS_PLATFORMS, PLATFORMS, type ConnectorDef, type Registry, type Source } from "./types.js";

const SOURCE_TYPES = ["literal", "env", "envFile", "fileRegex", "vault", "template"];

function checkSource(s: unknown, where: string, errs: string[]): void {
  const o = s as { type?: string; variables?: Record<string, unknown> };
  if (!o || typeof o !== "object" || !SOURCE_TYPES.includes(o.type ?? "")) { errs.push(`${where}: invalid source type`); return; }
  if (o.type === "template") for (const [k, v] of Object.entries(o.variables ?? {})) checkSource(v, `${where}.variables.${k}`, errs);
}

function checkGoogleOAuth(g: unknown, where: string, errs: string[]): void {
  const o = g as { secretsDir?: unknown; scopes?: unknown; account?: { vaultLabel?: unknown }; host?: { ssh?: unknown; keyFile?: unknown; port?: unknown; os?: unknown }; restart?: { command?: unknown }; health?: { url?: unknown; waitSeconds?: unknown } };
  if (!o || typeof o !== "object") { errs.push(`${where}: must be an object`); return; }
  if (typeof o.secretsDir !== "string" || !o.secretsDir.trim()) errs.push(`${where}.secretsDir: required`);
  if (!Array.isArray(o.scopes) || o.scopes.length === 0 || o.scopes.some((s) => typeof s !== "string" || !/^https:\/\/www\.googleapis\.com\/auth\/[\w.-]+$/.test(s))) errs.push(`${where}.scopes: a non-empty list of https://www.googleapis.com/auth/... scopes`);
  if (typeof o.account?.vaultLabel !== "string" || !o.account.vaultLabel) errs.push(`${where}.account.vaultLabel: required (the Google account's vault entry)`);
  if (o.host !== undefined) {
    if (typeof o.host.ssh !== "string" || !/^[\w.-]+@[\w.-]+$/.test(o.host.ssh)) errs.push(`${where}.host.ssh: must look like user@host`);
    if (typeof o.host.keyFile !== "string" || !o.host.keyFile) errs.push(`${where}.host.keyFile: required`);
    if (o.host.port !== undefined && !(Number.isInteger(o.host.port) && (o.host.port as number) > 0 && (o.host.port as number) < 65536)) errs.push(`${where}.host.port: invalid`);
    if (o.host.os !== undefined && o.host.os !== "windows" && o.host.os !== "posix") errs.push(`${where}.host.os: "windows" or "posix"`);
  }
  if (o.restart !== undefined && (typeof o.restart.command !== "string" || !o.restart.command.trim())) errs.push(`${where}.restart.command: required when restart is given`);
  if (o.health !== undefined) {
    if (typeof o.health.url !== "string" || !/^https?:\/\//.test(o.health.url)) errs.push(`${where}.health.url: must be an http(s) URL`);
    if (o.health.waitSeconds !== undefined && !(typeof o.health.waitSeconds === "number" && o.health.waitSeconds > 0 && o.health.waitSeconds <= 600)) errs.push(`${where}.health.waitSeconds: 1-600`);
    if (!o.restart) errs.push(`${where}.health: only meaningful together with restart`);
  }
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
    if (c.tier !== undefined && c.tier !== "production" && c.tier !== "test") errors.push(`${w}: tier must be "production" or "test"`);
    if (!c.platforms?.length || c.platforms.some((p) => !PLATFORMS.includes(p))) errors.push(`${w}: platforms must be a non-empty subset of ${PLATFORMS.join("|")}`);
    if (!c.auth || !["header", "oauth", "none"].includes(c.auth.mode)) errors.push(`${w}: auth.mode invalid`);
    if (c.auth?.oauthLogin !== undefined && (c.auth.mode !== "oauth" || !c.auth.oauthLogin.vaultLabel)) errors.push(`${w}: auth.oauthLogin needs mode "oauth" and a vaultLabel`);
    if (c.auth?.mode === "header" && !c.auth.headerName) errors.push(`${w}: header auth needs headerName`);
    if (c.auth?.mode === "header" && !c.auth.headerValue) errors.push(`${w}: header auth needs headerValue source`);
    if (c.auth?.mode === "header") for (const hp of HEADERLESS_PLATFORMS) if (c.platforms?.includes(hp) && !c.urlByPlatform?.[hp]) errors.push(`${w}: ${hp} cannot send custom headers; provide urlByPlatform.${hp} (tokenized URL) or drop ${hp} from platforms`);
    for (const [pl, src] of Object.entries(c.urlByPlatform ?? {})) {
      if (!PLATFORMS.includes(pl as never)) errors.push(`${w}: urlByPlatform has unknown platform ${pl}`);
      checkSource(src, `${w}.urlByPlatform.${pl}`, errors);
    }
    if (c.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) errors.push(`${w}.repo: must look like owner/name`);
    if (c.googleOAuth !== undefined) {
      checkGoogleOAuth(c.googleOAuth, `${w}.googleOAuth`, errors);
      if (!c.repo) errors.push(`${w}.repo: required when googleOAuth is set (the coverage guard matches repos to entries by it)`);
    }
    checkSource(c.url as Source, `${w}.url`, errors);
    if (c.auth?.headerValue) checkSource(c.auth.headerValue, `${w}.auth.headerValue`, errors);
  });
  (reg.googleOAuthExemptions ?? []).forEach((x, i) => {
    const w = `googleOAuthExemptions[${i}]`;
    if (!x || typeof x.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(x.repo)) errors.push(`${w}.repo: must look like owner/name`);
    if (!x || (x.kind !== "exempt" && x.kind !== "pending")) errors.push(`${w}.kind: "exempt" or "pending"`);
    if (!x || typeof x.reason !== "string" || x.reason.trim().length < 10) errors.push(`${w}.reason: say why (at least a sentence)`);
  });
  return errors.length ? { errors } : { registry: reg, errors };
}

export function loadRegistry(path: string): Registry {
  const { registry, errors } = validateRegistry(JSON.parse(fs.readFileSync(path, "utf8")));
  if (!registry) throw new Error("invalid registry:\n  " + errors.join("\n  "));
  return registry;
}
