import fs from "node:fs";
import path from "node:path";
import { PLATFORMS, type Platform } from "./types.js";
import { AccountNotAuthorizedError } from "./accountChoice.js";

/**
 * The platform accounts cc works in (registry/accounts.json). Data, not code: an account's email and vault label live there, never in src/.
 * Each account has its OWN cold master profile, so a run for one account can never see or change another account's connectors.
 */
export interface AccountDef {
  id: string;
  description?: string;
  /** The account's sign-in email. The vault entry's username must match it, so cc can never sign the wrong account in. */
  email?: string;
  /** Platforms this account is used on; a run for any other platform is skipped. */
  platforms: Platform[];
  /** ACCT-C10 ACCT-C12: a cross-check only (e.g. { "grok": "x" }): when the owner's registry entry records a login method it must be this one. Never itself the expected method. */
  loginProvider?: Partial<Record<Platform, LoginProvider>>;
  /** Folder name of this account's master profile, next to the default master. Absent = the default master itself (one account at most). */
  master?: string;
  /** How `cc browser signin` signs this account in to claude.ai: with Google, using this vault entry (username + password, resolved in-process, never logged). */
  signIn?: { google?: { vaultLabel: string; /** the vault entry also holds the authenticator secret; cc types the current code when Google asks */ totp?: boolean } };
  /**
   * What `cc settings apply|verify` keeps in place on claude.ai for this account (CLAUDE.md rule 9). References only: each project's
   * instruction text stays in its file and never enters the registry, the repo, output or logs.
   */
  settings?: AccountSettings;
}
/** A text file on this machine. `%VAR%` is expanded; the result must be an absolute path. A reference, never the content. */
export interface TextFileRef { type: "file"; path: string }
export interface ProjectSettings { /** The project's name exactly as claude.ai shows it. */ name: string; instructions: TextFileRef }
export interface AccountSettings { projects: ProjectSettings[] }
export interface Accounts { version: 1; default: string; accounts: AccountDef[] }

/** ACCT-C10: login methods an identity reader can report (data/selectors/identity.json providerMap values). */
export const LOGIN_PROVIDERS = ["email", "google", "x", "apple", "github", "sso", "phone", "cursor", "android"] as const;
export type LoginProvider = (typeof LOGIN_PROVIDERS)[number];

export const DEFAULT_ACCOUNTS_PATH = () => path.resolve("registry", "accounts.json");
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateAccounts(a: unknown): string[] {
  const errs: string[] = [];
  const o = a as Partial<Accounts>;
  if (!o || o.version !== 1) errs.push("version: must be 1");
  if (!Array.isArray(o?.accounts) || o.accounts.length === 0) { errs.push("accounts: at least one account is required"); return errs; }
  const ids = new Set<string>(), folders = new Set<string>();
  let defaults = 0;
  o.accounts.forEach((x, i) => {
    const w = `accounts[${i}]`;
    if (typeof x?.id !== "string" || !ID_RE.test(x.id)) errs.push(`${w}.id: lowercase letters, digits and dashes`);
    else if (ids.has(x.id)) errs.push(`${w}.id: duplicate "${x.id}"`); else ids.add(x.id);
    if (!Array.isArray(x?.platforms) || x.platforms.some((p) => !PLATFORMS.includes(p))) errs.push(`${w}.platforms: a list of ${PLATFORMS.join(", ")}`);
    if (x?.master === undefined) defaults++;
    else if (typeof x.master !== "string" || !FOLDER_RE.test(x.master) || x.master === "browser-master") errs.push(`${w}.master: a plain folder name (no path, not "browser-master")`);
    else if (folders.has(x.master.toLowerCase())) errs.push(`${w}.master: "${x.master}" is used by two accounts`); else folders.add(x.master.toLowerCase());
    if (x?.email !== undefined && (typeof x.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email))) errs.push(`${w}.email: an email address`);
    const g = x?.signIn?.google;
    if (x?.signIn !== undefined && (!g || typeof g.vaultLabel !== "string" || !g.vaultLabel)) errs.push(`${w}.signIn.google.vaultLabel: required when signIn is present`);
    if (x?.settings !== undefined) errs.push(...validateSettings(x.settings, `${w}.settings`));
    if (x?.loginProvider !== undefined) {
      const lp = x.loginProvider as unknown;
      if (!lp || typeof lp !== "object" || Array.isArray(lp)) errs.push(`${w}.loginProvider: an object such as { "grok": "x" }`);
      else for (const [p, v] of Object.entries(lp as Record<string, unknown>)) {
        if (!PLATFORMS.includes(p as Platform)) errs.push(`${w}.loginProvider.${p}: not a platform (${PLATFORMS.join(", ")})`);
        if (!LOGIN_PROVIDERS.includes(v as LoginProvider)) errs.push(`${w}.loginProvider.${p}: one of ${LOGIN_PROVIDERS.join(", ")}`);
      }
    }
  });
  if (defaults > 1) errs.push("accounts: only one account may use the default master (leave out `master`)");
  if (typeof o.default !== "string" || !ids.has(o.default)) errs.push(`default: must name one of the accounts`);
  return errs;
}

/** A project name cc can match exactly: non-empty, no leading/trailing or doubled spaces, no control characters, at most 200 characters. */
export function projectNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "a non-empty string";
  if (name !== name.trim() || /\s{2,}/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return "an exact name: no leading, trailing or doubled spaces and no control characters";
  if (name.length > 200) return "at most 200 characters";
  return undefined;
}

export function validateSettings(s: unknown, w = "settings"): string[] {
  const errs: string[] = [];
  const o = s as Partial<AccountSettings> | undefined;
  if (!o || typeof o !== "object" || !Array.isArray(o.projects) || o.projects.length === 0) return [`${w}.projects: at least one project is required`];
  const names = new Set<string>();
  o.projects.forEach((p, i) => {
    const pw = `${w}.projects[${i}]`;
    const bad = projectNameProblem(p?.name);
    if (bad) errs.push(`${pw}.name: ${bad}`);
    else if (names.has(p.name)) errs.push(`${pw}.name: duplicate "${p.name}"`); else names.add(p.name);
    const r = p?.instructions as Partial<TextFileRef> | undefined;
    if (!r || r.type !== "file" || typeof r.path !== "string" || !r.path.trim()) errs.push(`${pw}.instructions: { "type": "file", "path": "<absolute path, %VAR% allowed>" } (a reference; the text itself never goes in the registry)`);
    const extra = Object.keys(p ?? {}).filter((k) => k !== "name" && k !== "instructions");
    if (extra.length) errs.push(`${pw}: unknown field(s) ${extra.join(", ")} (only name and instructions)`);
  });
  return errs;
}

/** No accounts file = one default account on every platform (cc's behaviour before accounts existed). */
export function loadAccounts(file = DEFAULT_ACCOUNTS_PATH()): Accounts {
  if (!fs.existsSync(file)) return { version: 1, default: "main", accounts: [{ id: "main", platforms: [...PLATFORMS] }] };
  const a = JSON.parse(fs.readFileSync(file, "utf8")) as Accounts;
  const errs = validateAccounts(a);
  if (errs.length) throw new Error(`invalid accounts file ${file}:\n  ${errs.join("\n  ")}`);
  return a;
}

/**
 * The named account, else CC_ACCOUNT, else the file's default. An unknown id is an error, never a silent fallback to another account.
 * Purpose "explicit" (ACCT-001, ACCT-C01: cc browser *, cc_signin): only the account named in the call; the default, CC_ACCOUNT and
 * "the only account" never choose one, so no name is ACCOUNT_NOT_AUTHORIZED. cc_run requires its account before calling this (runner.ts).
 */
export function pickAccount(a: Accounts, id?: string, env = process.env, purpose: "use" | "explicit" = "use"): AccountDef {
  if (purpose === "explicit") {
    if (id === undefined) throw new AccountNotAuthorizedError("no account was named; name one with --account / account (the accounts file's default and CC_ACCOUNT never choose one)");
    const named = a.accounts.find((x) => x.id === id);
    if (!named) throw new Error(`unknown account "${id}" (known: ${a.accounts.map((x) => x.id).join(", ")})`);
    return named;
  }
  const want = id ?? env.CC_ACCOUNT ?? a.default;
  const acc = a.accounts.find((x) => x.id === want);
  if (!acc) throw new Error(`unknown account "${want}" (known: ${a.accounts.map((x) => x.id).join(", ")})`);
  return acc;
}

/** This account's master profile directory, given the default master. */
export function accountMaster(acc: AccountDef, defaultMaster: string): string {
  return acc.master ? path.join(path.dirname(defaultMaster), acc.master) : defaultMaster;
}
