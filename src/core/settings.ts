import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AccountDef, ProjectSettings, TextFileRef } from "./accounts.js";
import { projectNameProblem, validateSettings } from "./accounts.js";
import { Redactor } from "./redact.js";
import { expandEnv } from "./transport.js";

/**
 * `cc settings apply|verify --account <id> [--dry-run]` (CLAUDE.md rule 9, operator 3 Nov 2026): keep the claude.ai Projects that an account's
 * registry entry declares in place, with the instruction text from the referenced file. The text never appears in output, logs or errors:
 * cc reports only its length and a sha256 prefix. One browser per call (the injected `open`, in production openSession on the account's
 * master); the page logic is src/adapters/claudeSettings.ts. A result is real only when read back.
 */

export type SettingsOp = "apply" | "verify";
export interface SettingsItem { project: string; status: "ok" | "dry-run" | "error"; action?: "created" | "updated" | "unchanged" | "matches" | "would-apply" | "would-verify"; detail: string }
export interface SettingsResult { ok: boolean; account: string; op: SettingsOp; items: SettingsItem[]; notes: string[] }

/** Instruction text as compared and written: no BOM, LF line ends, no leading or trailing blank space (claude.ai's editor is not trusted to keep them). */
export function normalizeText(t: string): string { return t.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim(); }
export interface Fingerprint { chars: number; sha256: string }
export function fingerprint(t: string): Fingerprint { const n = normalizeText(t); return { chars: [...n].length, sha256: crypto.createHash("sha256").update(n, "utf8").digest("hex") }; }
export const fpText = (f: Fingerprint) => `${f.chars} characters, sha256 ${f.sha256.slice(0, 12)}`;
const same = (a: Fingerprint, b: Fingerprint) => a.chars === b.chars && a.sha256 === b.sha256;

export const MAX_INSTRUCTION_CHARS = 100_000;

/** Read a referenced text file. Refuses an unexpanded %VAR%, a relative path, a missing, empty or oversized file. Errors name the path, never the content. */
export function resolveTextFile(ref: TextFileRef, env: NodeJS.ProcessEnv = process.env, readFile: (p: string) => string | undefined = (p) => (fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : undefined)): string {
  const p = expandEnv(ref.path, env);
  const unset = /%([A-Za-z_][A-Za-z0-9_]*)%/.exec(p);
  if (unset) throw new Error(`instructions path uses %${unset[1]}%, which is not set`);
  if (!path.isAbsolute(p) && !path.win32.isAbsolute(p)) throw new Error(`instructions path must be absolute (got "${p}")`);
  const t = readFile(p);
  if (t === undefined) throw new Error(`instructions file not found: ${p}`);
  const n = normalizeText(t);
  if (!n) throw new Error(`instructions file is empty: ${p}`);
  if ([...n].length > MAX_INSTRUCTION_CHARS) throw new Error(`instructions file is over ${MAX_INSTRUCTION_CHARS} characters: ${p}`);
  return n;
}

const loose = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export type ProjectPlan = { kind: "open"; href: string } | { kind: "create" } | { kind: "refuse"; why: string };

/** Exact name only: one exact match is opened; none is created, unless a near-identical name exists (then refuse, so no look-alike duplicate is made); two exact matches are ambiguous. */
export function planProject(found: { name: string; href: string }[], name: string): ProjectPlan {
  const exact = found.filter((p) => p.name === name);
  if (exact.length === 1) return { kind: "open", href: exact[0].href };
  if (exact.length > 1) return { kind: "refuse", why: `${exact.length} projects are named exactly "${name}"; cc will not guess which one (rename one by hand)` };
  const near = found.filter((p) => loose(p.name) === loose(name));
  if (near.length) return { kind: "refuse", why: `no project is named exactly "${name}", but ${near.map((p) => `"${p.name}"`).join(", ")} is close; cc does not rename and will not create a look-alike (fix the name in registry/accounts.json or on claude.ai)` };
  return { kind: "create" };
}

/** The page side, one per browser. Production: claudeSettingsDriver(session.page, spec). */
export interface SettingsPage {
  listProjects(): Promise<{ name: string; href: string }[]>;
  createProject(name: string): Promise<string>;
  openProject(href: string): Promise<void>;
  readInstructions(): Promise<string>;
  writeInstructions(text: string): Promise<void>;
}
export interface SettingsSession { page: SettingsPage; close(): Promise<void>; /** e.g. "human-check" when the error is a BlockedError */ blockedKind?: (e: unknown) => string | undefined }

export interface SettingsOptions {
  dryRun?: boolean;
  /** Opens ONE browser for the whole call. Not called on a dry run or when a pre-check fails. */
  open?: () => Promise<SettingsSession>;
  env?: NodeJS.ProcessEnv;
  readFile?: (p: string) => string | undefined;
  /** Every line goes through the Redactor before it reaches this. */
  log?: (line: string) => void;
  /** Appended to (best effort), redacted, with a timestamp. */
  logFile?: string | null;
  unverifiedSelectors?: string[];
  sleep?: (ms: number) => Promise<void>;
  readBack?: { attempts: number; delayMs: number };
}

/** logs/settings/<account>.log under CC_LOG_DIR, else <helm data base>/logs (the base the master profiles use). */
export function settingsLogFile(account: string, e: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (e.CC_LOG_DIR) return path.join(e.CC_LOG_DIR, "settings", `${account}.log`);
    const app = (JSON.parse(fs.readFileSync(path.resolve("data", "app.json"), "utf8")) as { dataDirName: string }).dataDirName;
    const home = e.USERPROFILE ?? e.HOME ?? ".";
    const base = e.HELM_DATA_ROOT ?? (process.platform === "win32" ? path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", app) : path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", app));
    return path.join(base, "logs", "settings", `${account}.log`);
  } catch { return null; }
}

/** Every line of the text (and the text itself) becomes a redaction term, so not even a fragment can reach output. */
function protect(red: Redactor, text: string): void {
  red.add(text);
  for (const line of text.split("\n")) if (line.trim().length >= 12) red.add(line.trim());
}

export async function runSettings(op: SettingsOp, acc: AccountDef, o: SettingsOptions = {}): Promise<SettingsResult> {
  const red = new Redactor();
  const res: SettingsResult = { ok: false, account: acc.id, op, items: [], notes: [] };
  const say = (l: string) => {
    const line = red.redact(l);
    o.log?.(line);
    if (o.logFile) { try { fs.mkdirSync(path.dirname(o.logFile), { recursive: true }); fs.appendFileSync(o.logFile, `${new Date().toISOString()}  ${line}\n`); } catch { /* the log is best effort */ } }
  };
  const fail = (project: string, detail: string) => { res.items.push({ project, status: "error", detail: red.redact(detail) }); say(`error    ${op} ${project}: ${detail}`); };
  const pause = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  say(`start    settings ${op}${o.dryRun ? " --dry-run" : ""} account ${acc.id}`);

  // 1. Refusals that need no browser.
  if (!acc.platforms.includes("claude")) { fail("-", `account "${acc.id}" is not used on claude`); return res; }
  if (!acc.settings) { fail("-", `account "${acc.id}" has no "settings" block in registry/accounts.json; nothing to ${op}`); return res; }
  const errs = validateSettings(acc.settings);
  if (errs.length) { fail("-", `invalid settings for account "${acc.id}": ${errs.join("; ")}`); return res; }
  const wanted: { p: ProjectSettings; fp: Fingerprint; text: string }[] = [];
  for (const p of acc.settings.projects) {
    try {
      const text = resolveTextFile(p.instructions, o.env, o.readFile);
      protect(red, text);
      wanted.push({ p, text, fp: fingerprint(text) });
    } catch (e) { fail(p.name, (e as Error).message); }
  }
  if (res.items.length) { say(`stopped  no browser opened: ${res.items.length} pre-check(s) failed`); return res; }
  if (o.unverifiedSelectors?.length) { const n = `${o.unverifiedSelectors.length} selector(s) in data/selectors/claude-settings.json are still marked unverified: ${o.unverifiedSelectors.join(", ")}`; res.notes.push(n); say(`note     ${n}`); }

  // 2. Dry run: say what would happen, open nothing.
  if (o.dryRun) {
    for (const w of wanted) {
      const detail = op === "apply" ? `would open project "${w.p.name}" (or create it if no project has exactly that name) and make its instructions ${fpText(w.fp)}; no browser opened` : `would compare project "${w.p.name}"'s instructions with ${fpText(w.fp)}; no browser opened`;
      res.items.push({ project: w.p.name, status: "dry-run", action: op === "apply" ? "would-apply" : "would-verify", detail });
      say(`dry-run  ${op} ${w.p.name}: ${detail}`);
    }
    res.ok = true;
    return res;
  }
  if (!o.open) { fail("-", "no browser available"); return res; }

  // 3. One browser for the whole call.
  let s: SettingsSession;
  try { s = await o.open(); } catch (e) { fail("-", `could not open the browser: ${String((e as Error).message).split("\n")[0]}`); return res; }
  const attempts = o.readBack?.attempts ?? 4, delayMs = o.readBack?.delayMs ?? 2500;
  try {
    let found = await s.page.listProjects();
    say(`list     ${found.length} project(s) on claude.ai`);
    for (const w of wanted) {
      const name = w.p.name;
      try {
        const bad = projectNameProblem(name);
        if (bad) throw new Error(`project name must be ${bad}`);
        const plan = planProject(found, name);
        if (plan.kind === "refuse") { fail(name, plan.why); continue; }
        if (op === "verify") {
          if (plan.kind === "create") { fail(name, `no project named exactly "${name}" exists on claude.ai`); continue; }
          await s.page.openProject(plan.href);
          const have = fingerprint(await s.page.readInstructions());
          if (same(have, w.fp)) { res.items.push({ project: name, status: "ok", action: "matches", detail: `instructions match the file: ${fpText(have)}` }); say(`ok       verify ${name}: instructions match, ${fpText(have)}`); }
          else fail(name, `instructions differ from the file: claude.ai has ${fpText(have)}, the file has ${fpText(w.fp)}`);
          continue;
        }
        // apply
        let href: string, action: SettingsItem["action"];
        if (plan.kind === "create") {
          say(`create   project ${name}`);
          await s.page.createProject(name);
          found = await s.page.listProjects();
          const again = planProject(found, name);
          if (again.kind !== "open") { fail(name, `clicked create, but the project list does not show exactly one "${name}" afterwards`); continue; }
          href = again.href; action = "created";
        } else { href = plan.href; action = "unchanged"; }
        await s.page.openProject(href);
        const before = fingerprint(await s.page.readInstructions());
        if (!same(before, w.fp)) {
          say(`write    ${name}: ${fpText(before)} -> ${fpText(w.fp)}`);
          await s.page.writeInstructions(w.text);
          if (action !== "created") action = "updated";
        }
        // Read back: reopen the project and compare; the save may land a moment later, so poll a few times (slowly).
        let after: Fingerprint | undefined = action === "unchanged" ? before : undefined; // nothing written: the read above is the read-back
        for (let i = 0; i < attempts && !after; i++) {
          if (i) await pause(delayMs);
          await s.page.openProject(href);
          const got = fingerprint(await s.page.readInstructions());
          if (same(got, w.fp) || i === attempts - 1) after = got;
        }
        if (!after || !same(after, w.fp)) { fail(name, `instructions were saved but reading them back gives ${after ? fpText(after) : "nothing"}, not ${fpText(w.fp)}`); continue; }
        const what = action === "created" ? "project created; instructions set" : action === "updated" ? "instructions updated" : "instructions already match; nothing written";
        res.items.push({ project: name, status: "ok", action, detail: `${what}; read back: ${fpText(after)}` });
        say(`ok       apply ${name}: ${what}; read back ${fpText(after)}`);
      } catch (e) {
        const kind = s.blockedKind?.(e);
        fail(name, `${kind ? `STOPPED (${kind}): ` : ""}${String((e as Error).message ?? e).split("\n")[0]}`);
        if (kind) break; // a human check or a lost sign-in stops the whole call; it is never worked around
      }
    }
  } catch (e) {
    const kind = s.blockedKind?.(e);
    fail("-", `${kind ? `STOPPED (${kind}): ` : ""}${String((e as Error).message ?? e).split("\n")[0]}`);
  } finally { await s.close().catch(() => {}); }
  res.ok = res.items.length > 0 && res.items.every((i) => i.status === "ok");
  say(`end      settings ${op} account ${acc.id}: ${res.ok ? "ok" : "FAILED"}`);
  return res;
}
