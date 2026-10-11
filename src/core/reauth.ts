import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Redactor } from "./redact.js";
import { expandEnv, transportFor, type Transport } from "./transport.js";
import type { ConnectorDef, GoogleOAuthDef, Registry } from "./types.js";
import { getCredential } from "./vaultClient.js";

/**
 * `cc reauth`: renew the Google OAuth grant (token.json) of every connector whose registry entry carries a `googleOAuth` block.
 * Google expires such a refresh token after 7 days while the operator's OAuth app stays in Testing status, so this runs weekly.
 *
 * Knows OAuth and hosts, never a specific connector: where a connector's secrets live, its scopes, how to restart it and how to
 * check it are registry data. Both front doors (CLI, MCP) call this one function.
 *
 * Per connector: read credentials.json -> loopback redirect server -> drive Google's consent in cc's own browser session ->
 * exchange the code -> require a refresh token and every declared scope -> deliver token.json (atomically; over ssh when the
 * connector runs elsewhere) -> restart -> health check. If the restart or health check fails, the previous token is restored.
 * A failure at any earlier step changes nothing. Output is redacted: the code, tokens and client secret never appear.
 */
/** `onlyIfOlderThanDays`: skip a connector whose renewal record (RENEWED_FILE next to its token.json) is newer than this; used by a second renewer that only acts when the first one has not. */
export interface ReauthRequest { connectors: string[]; includeTest?: boolean; dryRun?: boolean; onlyIfOlderThanDays?: number }
export interface ReauthItem { connector: string; status: "ok" | "skipped" | "dry-run" | "error"; detail?: string }
export interface ReauthResult { ok: boolean; items: ReauthItem[] }

export interface TokenResponse { access_token?: string; refresh_token?: string; scope?: string; token_type?: string; expires_in?: number }
export interface GoogleAccountCredential { username?: string; password?: string }

export interface ReauthDeps {
  transport: (def: GoogleOAuthDef) => Transport;
  vault: (label: string) => Promise<GoogleAccountCredential | undefined>;
  /** Drive the consent URL in a browser until `isDone()` (the loopback server has the code). */
  consent: (a: { url: string; credential: GoogleAccountCredential; isDone: () => boolean; log: (line: string) => void }) => Promise<void>;
  /** Release the browser (called once, after the last connector). */
  closeBrowser: () => Promise<void>;
  exchange: (p: { code: string; clientId: string; clientSecret: string; redirectUri: string }) => Promise<TokenResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  state: () => string;
  /** Log file (appended; redacted text only). null = none. */
  logFile: string | null;
  /** Cross-process lock per connector so two renewals (CLI, a scheduled task, the MCP tool) never run at once. Returns a release function, or undefined when another renewal holds it. Absent = no locking. */
  lock?: (connectorId: string) => (() => void) | undefined;
}

/** Exclusive lock file per connector; a lock older than 20 minutes, or whose owner process is gone, is stale and taken over. */
export function fileLock(dir = process.env.CC_LOCK_DIR ?? path.join(os.tmpdir(), "cc-reauth-locks"), now: () => number = Date.now) {
  return (id: string): (() => void) | undefined => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(file, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let stale = false;
        try {
          const pid = Number(fs.readFileSync(file, "utf8"));
          const aged = now() - fs.statSync(file).mtimeMs > 20 * 60_000;
          let alive = true;
          try { process.kill(pid, 0); } catch (k) { alive = (k as NodeJS.ErrnoException).code === "EPERM"; }
          stale = aged || !alive;
        } catch { stale = true; }
        if (!stale) return undefined;
        try { fs.unlinkSync(file); } catch { /* raced with another taker: the next attempt decides */ }
      }
    }
    return undefined;
  };
}

/**
 * Written next to token.json after a FULLY successful renewal (delivered, restarted and healthy, or delivered with no restart configured). It is the only
 * record of "when" a second renewer can trust: token.json's own expiry_date and its file time change whenever a server saves a refreshed access token,
 * which would make an old grant look fresh forever. A failed or restored renewal writes nothing.
 */
export const RENEWED_FILE = "token.renewed.json";

/** Age of the last renewal in days, or undefined when the record is missing, unreadable or dated in the future (clock skew): then nothing is trusted and the caller renews. */
export function renewalAge(raw: string | undefined, nowMs: number): { days: number; byHost?: string } | undefined {
  if (raw === undefined) return undefined;
  try {
    const j = JSON.parse(raw) as { renewedAt?: unknown; byHost?: unknown };
    const at = typeof j.renewedAt === "string" ? Date.parse(j.renewedAt) : NaN;
    if (!Number.isFinite(at) || at > nowMs + 5 * 60_000) return undefined;
    return { days: Math.max(0, nowMs - at) / 86_400_000, byHost: typeof j.byHost === "string" ? j.byHost : undefined };
  } catch { return undefined; }
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CONSENT_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export async function exchangeWithGoogle(p: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<TokenResponse> {
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string };
  if (!r.ok) throw new Error(`Google's token endpoint refused the code: ${j.error ?? "HTTP " + r.status}${j.error_description ? " - " + j.error_description : ""}`);
  return j;
}

/** Default log location: CC_LOG_DIR, else <helm data base>/logs (the base the browser master profile uses). File name: reauth.log. */
function defaultLogFile(e = process.env): string | null {
  try {
    if (e.CC_LOG_DIR) return path.join(e.CC_LOG_DIR, "reauth.log");
    const app = (JSON.parse(fs.readFileSync(path.resolve("data", "app.json"), "utf8")) as { dataDirName: string }).dataDirName;
    const home = e.USERPROFILE ?? e.HOME ?? ".";
    const base = e.HELM_DATA_ROOT
      ?? (process.platform === "win32" ? path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", app) : path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", app));
    return path.join(base, "logs", "reauth.log");
  } catch { return null; }
}

export function defaultReauthDeps(): ReauthDeps {
  let session: Promise<import("../browser/chrome.js").BrowserSession> | undefined;
  return {
    transport: transportFor,
    vault: getCredential,
    async consent(a) {
      const [{ openSession }, { driveConsent }] = await Promise.all([import("../browser/chrome.js"), import("../browser/googleConsent.js")]);
      session ??= openSession(); // ONE browser (own lane, cloned master profile) for the whole call; admission gate applies
      const s = await session;
      await driveConsent({ context: s.context, url: a.url, credential: a.credential, isDone: a.isDone, log: a.log });
    },
    async closeBrowser() { if (session) { const p = session; session = undefined; try { await (await p).close(); } catch { /* never opened */ } } },
    exchange: exchangeWithGoogle,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    state: () => crypto.randomBytes(16).toString("hex"),
    logFile: defaultLogFile(),
    lock: fileLock(),
  };
}

interface Loopback { port: number; isDone(): boolean; result(): { code?: string; error?: string }; close(): void }

/** A real loopback HTTP server for Google's redirect: every browser-side way of noticing a connection-refused redirect proved unreliable. Accepts only the state cc generated. */
function startLoopback(state: string): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let code: string | undefined, error: string | undefined;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.searchParams.get("state") !== state) { res.statusCode = 400; res.end("Waiting for Google..."); return; }
      const err = u.searchParams.get("error"), c = u.searchParams.get("code");
      if (err) { error = err; res.end(`Authorization failed: ${err}. You can close this tab.`); }
      else if (c) { code = c; res.end("Authorization complete. You can close this tab."); }
      else res.end("Waiting for Google...");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, isDone: () => !!code || !!error, result: () => ({ code, error }), close: () => { server.close(); server.closeAllConnections?.(); } });
    });
  });
}

/** Google's own default for a Desktop-app client registers a bare http://localhost, which it treats as matching any port. */
export function withPort(redirectUri: string, port: number): string {
  const u = new URL(redirectUri);
  u.port = String(port);
  return u.toString();
}

export function buildConsentUrl(p: { clientId: string; redirectUri: string; scopes: string[]; state: string; loginHint?: string }): string {
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code", scope: p.scopes.join(" "), access_type: "offline", prompt: "consent", state: p.state });
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${CONSENT_ENDPOINT}?${q.toString()}`;
}

export function selectGoogleConnectors(reg: Registry, req: ReauthRequest): { picked: ConnectorDef[]; items: ReauthItem[] } {
  const items: ReauthItem[] = [];
  if (req.connectors.includes("*")) return { picked: reg.connectors.filter((c) => c.googleOAuth && (req.includeTest || c.tier !== "test")), items };
  const picked: ConnectorDef[] = [];
  for (const id of req.connectors) {
    const c = reg.connectors.find((x) => x.id === id);
    if (!c) items.push({ connector: id, status: "error", detail: "unknown connector id" });
    else if (!c.googleOAuth) items.push({ connector: id, status: "error", detail: "this connector's registry entry has no googleOAuth block, so cc has nothing to renew for it" });
    else picked.push(c);
  }
  return { picked, items };
}

export async function reauth(reg: Registry, req: ReauthRequest, deps: ReauthDeps = defaultReauthDeps()): Promise<ReauthResult> {
  const red = new Redactor();
  const t0 = deps.now();
  const log = (line: string): void => {
    const text = red.redact(line);
    console.error(`[reauth +${((deps.now() - t0) / 1000).toFixed(1)}s] ${text}`);
    if (deps.logFile) { try { fs.mkdirSync(path.dirname(deps.logFile), { recursive: true }); fs.appendFileSync(deps.logFile, `${new Date(deps.now()).toISOString()}  ${text}\n`); } catch { /* the log is best effort */ } }
  };
  const { picked, items } = selectGoogleConnectors(reg, req);
  const results: ReauthItem[] = [...items];
  log(`=== cc reauth starting (${picked.length} connector(s)${req.dryRun ? ", dry-run" : ""}) ===`);
  try {
    for (const c of picked) {
      let item: ReauthItem;
      // A dry run changes nothing, so it never needs (or blocks on) the lock.
      const release = req.dryRun || !deps.lock ? (() => {}) : deps.lock(c.id);
      if (!release) { item = { connector: c.id, status: "skipped", detail: "another renewal of this connector is already running" }; log(`${c.id}: ${item.status} - ${item.detail}`); results.push(item); continue; }
      try { const r = await reauthOne(c, c.googleOAuth!, req, deps, red, log); item = { connector: c.id, status: r.status, detail: r.detail === undefined ? undefined : red.redact(r.detail) }; }
      catch (e) { item = { connector: c.id, status: "error", detail: red.redact((e as Error).message) }; }
      finally { release(); }
      log(`${c.id}: ${item.status}${item.detail ? " - " + item.detail : ""}`);
      results.push(item);
    }
  } finally {
    await deps.closeBrowser().catch(() => undefined);
  }
  const ok = results.every((r) => r.status !== "error");
  log(`=== cc reauth finished (${ok ? "all ok" : "WITH FAILURES"}) ===`);
  return { ok, items: results };
}

async function reauthOne(c: ConnectorDef, g: GoogleOAuthDef, req: ReauthRequest, deps: ReauthDeps, red: Redactor, log: (l: string) => void): Promise<Omit<ReauthItem, "connector">> {
  const t = deps.transport(g);
  const dir = g.host ? g.secretsDir : expandEnv(g.secretsDir);
  const credsFile = t.join(dir, "credentials.json");
  const tokenFile = t.join(dir, "token.json");
  const renewedFile = t.join(dir, RENEWED_FILE);
  let renewNote = "";

  // A second renewer acts only when needed: one read over the same transport, before the vault or a browser is touched.
  if (req.onlyIfOlderThanDays !== undefined) {
    const prior = renewalAge(await t.readFile(renewedFile), deps.now());
    renewNote = prior ? `would renew: last renewal ${prior.days.toFixed(1)} day(s) ago, older than ${req.onlyIfOlderThanDays} days; ` : "would renew: no usable renewal record; ";
    if (prior && prior.days < req.onlyIfOlderThanDays) {
      const detail = `renewed ${prior.days.toFixed(1)} day(s) ago${prior.byHost ? ` by ${prior.byHost}` : ""}; nothing to do (renews after ${req.onlyIfOlderThanDays} days)`;
      return req.dryRun ? { status: "dry-run", detail: `would skip: ${detail}` } : { status: "skipped", detail };
    }
  }

  const raw = await t.readFile(credsFile);
  if (raw === undefined) throw new Error(`credentials.json not found at ${t.where}:${dir}`);
  let inst: { client_id?: string; client_secret?: string; redirect_uris?: string[] } | undefined;
  try { inst = (JSON.parse(raw) as { installed?: typeof inst }).installed; } catch { /* reported below */ }
  if (!inst?.client_id || !inst.client_secret || !inst.redirect_uris?.length) throw new Error(`credentials.json on ${t.where} is not a Desktop-app OAuth client (needs installed.client_id, client_secret and redirect_uris)`);
  red.add(inst.client_secret);
  const redirectBase = inst.redirect_uris.find((u) => /^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(u));
  if (!redirectBase) throw new Error("credentials.json has no localhost redirect URI, which the loopback consent flow needs");

  const cred = await deps.vault(g.account.vaultLabel);
  if (!cred) throw new Error(`vault entry "${g.account.vaultLabel}" not found`);
  red.add(cred.password); // the address is not a secret (it is in the vault label and the consent hint); the password is

  const hadToken = (await t.readFile(tokenFile)) !== undefined;
  if (req.dryRun) {
    return { status: "dry-run", detail: `${renewNote}credentials.json readable on ${t.where}; OAuth client present; vault entry "${g.account.vaultLabel}" found (username ${cred.username ? "present" : "MISSING"}, password ${cred.password ? "present" : "MISSING"}); token.json ${hadToken ? "present" : "absent"}; ${g.scopes.length} scope(s); restart ${g.restart ? "configured" : "none"}; health ${g.health ? "configured" : "none"}` };
  }

  const state = deps.state();
  const lb = await startLoopback(state);
  let tokens: TokenResponse;
  try {
    const redirectUri = withPort(redirectBase, lb.port);
    const url = buildConsentUrl({ clientId: inst.client_id, redirectUri, scopes: g.scopes, state, loginHint: cred.username });
    log(`${c.id}: asking Google for consent (${g.scopes.length} scope(s)) as the vault account`);
    await deps.consent({ url, credential: cred, isDone: () => lb.isDone(), log: (l) => log(`${c.id}: ${l}`) });
    const { code, error } = lb.result();
    if (error) throw new Error(`Google's redirect reported an OAuth error: ${error}`);
    if (!code) throw new Error("the consent flow ended without an authorization code");
    red.add(code);
    tokens = await deps.exchange({ code, clientId: inst.client_id, clientSecret: inst.client_secret, redirectUri });
  } finally { lb.close(); }

  if (!tokens.refresh_token) throw new Error("Google returned no refresh_token (the account already granted this client without prompting); nothing was written");
  red.add(tokens.refresh_token); red.add(tokens.access_token);
  const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
  const missing = g.scopes.filter((s) => !granted.has(s));
  if (missing.length) throw new Error(`Google granted fewer scopes than the connector declares (missing: ${missing.join(", ")}); nothing was written`);

  const next = JSON.stringify({ access_token: tokens.access_token ?? null, refresh_token: tokens.refresh_token, scope: tokens.scope, token_type: tokens.token_type ?? "Bearer", expiry_date: deps.now() + (tokens.expires_in ?? 3600) * 1000 }, null, 2);
  const previous = await t.readFile(tokenFile);
  const expect = g.health?.expectRenewedAt === true;
  const previousRecord = expect ? await t.readFile(renewedFile) : undefined;
  const renewedAt = new Date(deps.now()).toISOString();
  await t.replaceFile(tokenFile, next);
  log(`${c.id}: new token.json delivered to ${t.where}`);
  let warning = "";
  const record = async (): Promise<void> => {
    try { await t.replaceFile(renewedFile, JSON.stringify({ renewedAt, byHost: os.hostname() }, null, 2)); }
    catch (e) {
      log(`${c.id}: renewed, but could not write ${RENEWED_FILE} (${(e as Error).message}); a --only-if-older-than job will renew again`);
      warning = `; WARNING: could not write ${RENEWED_FILE} (${(e as Error).message}), so a --only-if-older-than job will renew again`;
    }
  };
  if (!g.restart && !g.health) { await record(); return { status: "ok", detail: `renewed; new token delivered to ${t.where} (no restart configured: the server must pick it up itself)${warning}` }; }

  const restartCmd = g.restart ? (g.host ? g.restart.command : expandEnv(g.restart.command)) : undefined;
  // `stamp`: the renewedAt the health body must show (proof the server loaded the NEW token); the check after a restore asks only for plain health.
  const restartAndCheck = async (stamp?: string): Promise<string | undefined> => {
    if (restartCmd) {
      const r = await t.exec(restartCmd, 180_000);
      if (r.code !== 0) return `restart command exited ${r.code}`;
    }
    if (!g.health) return undefined;
    const end = deps.now() + (g.health.waitSeconds ?? 60) * 1000;
    for (;;) {
      const body = await t.fetchText(g.health.url);
      if (body !== undefined && (!g.health.contains || body.includes(g.health.contains)) && (!stamp || body.includes(stamp))) return undefined;
      if (deps.now() >= end) return `health check did not pass within ${g.health.waitSeconds ?? 60}s${stamp ? " (the health page did not show the new renewal record)" : ""}`;
      await deps.sleep(3000);
    }
  };
  // The record goes first when the health page must echo it; a failed renewal puts the previous record back (an undated one if there was none, which reads as "renew").
  if (expect) await record();
  log(restartCmd ? `${c.id}: restarting on ${t.where}` : `${c.id}: no restart configured; waiting for the server to re-read the token (health check on ${t.where})`);
  const problem = await restartAndCheck(expect ? renewedAt : undefined);
  if (!problem) {
    if (!expect) await record();
    return { status: "ok", detail: `renewed; new token delivered to ${t.where}; ${restartCmd ? "restarted" : "re-read by the server (no restart)"}${g.health ? "; health ok" : ""}${expect ? ", showing the new renewal" : ""}${warning}` };
  }
  if (expect) { try { await t.replaceFile(renewedFile, previousRecord ?? "{}"); } catch { /* the token restore below still matters most */ } }

  // The new token did not bring the server back: put the old one back (it is still valid until it expires) and restart again (or just re-check, with no restart).
  if (previous !== undefined) {
    await t.replaceFile(tokenFile, previous);
    const again = await restartAndCheck();
    throw new Error(`${problem}; the previous token was restored${again ? ` but the server still did not come back (${again})` : " and the server is running again"}`);
  }
  throw new Error(`${problem}; there was no previous token to restore`);
}
