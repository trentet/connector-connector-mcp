import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "patchright";
import { acquireLane, type Lane } from "./lanes.js";
import { cloneProfile, profileInUse, removeProfile, withMasterLock } from "./profile.js";

/** Hosts whose stale tabs this tool may close. Anything else in the shared profile is left alone. */
const OWNED_HOSTS = ["claude.ai", "chatgpt.com", "grok.com", "x.ai", "accounts.google.com", "auth.openai.com"];
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SESSION_COOKIE_LIFETIME_S = 30 * 24 * 3600;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  artifactsDir: string;
  /** Platforms this run drove; decides whether its refreshed sign-in state is healthy enough to write back. */
  touched?: Set<string>;
  close(): Promise<void>;
}

/** What the browser layer knows about a platform's sign-in state (data/selectors/<platform>.json "auth"). */
export interface AuthSpec { cookie: string; refresh: string[]; hosts: string[]; ssoHosts: string[] }

export function loadAuthSpecs(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): Record<string, AuthSpec> {
  const out: Record<string, AuthSpec> = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".json")) continue;
    const a = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { auth?: Partial<AuthSpec> }).auth;
    if (a?.cookie && a.hosts?.length) out[f.replace(/\.json$/, "")] = { cookie: a.cookie, refresh: a.refresh?.length ? a.refresh : [a.cookie], hosts: a.hosts, ssoHosts: a.ssoHosts ?? [] };
  }
  return out;
}

const domainMatches = (cookieDomain: string, hosts: string[]) => { const d = cookieDomain.replace(/^\./, ""); return hosts.some((h) => d === h || d.endsWith("." + h)); };

/** Every touched platform still has its sign-in cookie: the run's session is healthy. */
export function sessionHealthy(cookies: Cookie[], touched: Iterable<string>, specs: Record<string, AuthSpec>): boolean {
  const list = [...touched];
  if (list.length === 0) return false;
  return list.every((p) => { const s = specs[p]; return !!s && cookies.some((c) => c.name.startsWith(s.cookie) && domainMatches(c.domain, s.hosts)); });
}

/**
 * The cold master profile: CC_BROWSER_MASTER, else <helm base>/browser-master (same base as scripts/env.mjs).
 * The old CC_CHROME_PROFILE (a shared, always-running Chrome's profile) is deliberately ignored: a master must be cold.
 */
export function masterDir(e = process.env, platform = process.platform, home = os.homedir()): string {
  if (e.CC_BROWSER_MASTER) return e.CC_BROWSER_MASTER;
  const app = (JSON.parse(fs.readFileSync(path.resolve("data", "app.json"), "utf8")) as { dataDirName: string }).dataDirName;
  const base = e.HELM_DATA_ROOT
    ?? (platform === "win32" ? path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", app)
      : platform === "darwin" ? path.join(home, "Library", "Application Support", "HELM", app)
      : path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", app));
  return path.join(base, "browser-master");
}

const cookieKey = (c: Cookie) => `${c.domain}|${c.path}|${c.name}`;

/** The sign-in cookies (spec.refresh) of the platforms a run touched. */
export function refreshCookies(cookies: Cookie[], touched: Iterable<string>, specs: Record<string, AuthSpec>): Cookie[] {
  const list = [...touched].map((p) => specs[p]).filter((s): s is AuthSpec => !!s);
  return cookies.filter((c) => list.some((s) => domainMatches(c.domain, s.hosts) && s.refresh.some((n) => c.name.startsWith(n))));
}

/** Sign-in cookies whose value differs from what the run started with (rotated or newly issued). Unchanged cookies are never written, so a stale copy cannot overwrite a newer master. */
export function changedSince(start: Map<string, string>, now: Cookie[]): Cookie[] {
  return now.filter((c) => start.get(cookieKey(c)) !== c.value);
}

/**
 * Merge rotated sign-in cookies into the cold master, cookie by cookie, with a short-lived Chrome on the master itself.
 * Holds a lane and then the master lock (same order as a run, so the two cannot deadlock); clones wait for it. Best effort:
 * on any failure the master simply keeps its previous cookies.
 */
export async function mergeCookiesIntoMaster(master: string, cookies: Cookie[]): Promise<boolean> {
  if (!cookies.length) return false;
  const lane = await acquireLane();
  try {
    return await withMasterLock(master, async () => {
      if (profileInUse(master)) return false;
      const l = await launchChrome(master, lane.port);
      let b: Browser | undefined;
      try {
        b = await chromium.connectOverCDP(`http://127.0.0.1:${lane.port}`);
        const now = Math.floor(Date.now() / 1000);
        await b.contexts()[0].addCookies(cookies.map((c) => ({ ...c, expires: c.expires > 0 ? c.expires : now + SESSION_COOKIE_LIFETIME_S })));
        return true;
      } finally { await shutdownChrome(b, l.child, l.exited); }
    });
  } finally { lane.release(); }
}

async function cdpUp(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}

/**
 * Flags that stop Chrome doing work nobody asked for (background networking, sync, component updates, pings, telemetry).
 * Deliberately NOT the usual automation flag set: cc drives a normally launched Chrome, and claude.ai's anti-automation notices otherwise.
 */
const LEAN_FLAGS = ["--disable-background-networking", "--disable-sync", "--disable-component-update", "--disable-default-apps", "--no-pings", "--metrics-recording-only"];

/**
 * Start a normal (not automation-launched) Chrome on a user-data-dir and CDP port. Playwright's persistent-context API is never used.
 * It runs at BELOW-NORMAL priority (children inherit it) so other workloads on the shared host win a CPU fight; CC_CHROME_PRIORITY=normal opts out.
 */
export async function launchChrome(userDataDir: string, port: number, opts: { cacheDir?: string } = {}): Promise<{ child: ChildProcess; exited: Promise<void> }> {
  const exe = process.env.CC_CHROME_PATH ?? DEFAULT_CHROME;
  const extra = (process.env.CC_CHROME_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
  const cache = opts.cacheDir ? [`--disk-cache-dir=${opts.cacheDir}`, `--disk-cache-size=${(Number(process.env.CC_CACHE_MB) || 150) * 1024 * 1024}`] : [];
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", ...LEAN_FLAGS, ...cache, ...extra, "about:blank"], { stdio: "ignore", windowsHide: false });
  if (child.pid && process.env.CC_CHROME_PRIORITY !== "normal") { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: run at normal priority */ } }
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  for (let i = 0; i < 60; i++) {
    if (await cdpUp(port)) return { child, exited };
    if (child.exitCode !== null) throw new Error(`Chrome exited immediately (code ${child.exitCode}) when launched on port ${port}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  killTree(child);
  throw new Error(`Chrome did not expose CDP on port ${port} within 30s`);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    else child.kill("SIGKILL");
  } catch { /* already gone */ }
}

/** Ask Chrome to quit over CDP, wait for the process to exit, and force it if it does not. */
export async function shutdownChrome(browser: Browser | undefined, child: ChildProcess, exited: Promise<void>): Promise<void> {
  try { if (browser) await (await browser.newBrowserCDPSession()).send("Browser.close"); } catch { /* fall through to waiting/killing */ }
  const done = await Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
  if (!done) { killTree(child); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
}

/**
 * One run = one Chrome process. The run claims a lane (CDP port), clones the cold master profile into a private temp dir,
 * launches an independent Chrome on that copy, attaches over CDP, and on close() shuts that Chrome down, deletes the copy and,
 * if the run's sign-in state is still healthy, writes the refreshed cookies back to the master. Nothing is shared between runs,
 * so concurrent runs cannot touch each other's tabs.
 */
export async function openSession(opts: { artifactsDir?: string } = {}): Promise<BrowserSession> {
  const master = masterDir();
  const artifactsDir = path.resolve(opts.artifactsDir ?? "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const lane: Lane = await acquireLane();
  let runDir: string | undefined;
  let launched: { child: ChildProcess; exited: Promise<void> } | undefined;
  let browser: Browser | undefined;
  const cleanup = async () => {
    if (launched) await shutdownChrome(browser, launched.child, launched.exited);
    if (runDir) removeProfile(runDir);
    lane.release();
  };
  try {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-run-${lane.index}-`));
    await cloneProfile(master, runDir);
    // A warm HTTP cache per lane (the lane lock makes it exclusive) cuts a run's CPU and network by roughly a quarter on the HELM host (measured on ChatGPT: 45 to 34 CPU-seconds).
    launched = await launchChrome(runDir, lane.port, { cacheDir: path.join(process.env.CC_CACHE_DIR ?? path.join(path.dirname(master), "browser-cache"), `lane-${lane.index}`) });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${lane.port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    for (const p of context.pages()) {
      let host = "";
      try { host = new URL(p.url()).hostname; } catch { /* about:blank etc. */ }
      if (OWNED_HOSTS.some((h) => host === h || host.endsWith("." + h))) await p.close().catch(() => {});
    }
    const page = await context.newPage();
    const touched = new Set<string>();
    const run = runDir, child = launched, br = browser;
    // What the sign-in cookies looked like when this run started, to find out later which ones the run rotated.
    const specsAtStart = loadAuthSpecs();
    const startCookies = new Map((await context.cookies()).filter((c) => Object.values(specsAtStart).some((sp) => domainMatches(c.domain, sp.hosts) && sp.refresh.some((n) => c.name.startsWith(n)))).map((c) => [cookieKey(c), c.value] as const));
    return {
      browser: br, context, page, artifactsDir, touched,
      async close() {
        let rotated: Cookie[] = [];
        try {
          const specs = loadAuthSpecs();
          const cookies = await context.cookies();
          // Only a healthy run (every platform it touched still has its sign-in cookie) may contribute; a signed-out browser never does.
          if (sessionHealthy(cookies, touched, specs)) rotated = changedSince(startCookies, refreshCookies(cookies, touched, specs));
        } catch { /* a dead browser contributes nothing */ }
        await shutdownChrome(br, child.child, child.exited);
        removeProfile(run);
        lane.release(); // free the lane BEFORE merging: the merge claims its own, and holding two could starve other callers
        try { if (rotated.length) await mergeCookiesIntoMaster(master, rotated); } catch { /* the master keeps its previous cookies */ }
      },
    };
  } catch (e) {
    await cleanup().catch(() => {});
    throw e;
  }
}

/** Run a step; on failure save a screenshot (filename carries no secrets) and rethrow with the path. */
export async function guarded<T>(s: BrowserSession, label: string, redact: (x: string) => string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const file = path.join(s.artifactsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^a-z0-9-]/gi, "_")}-FAILED.png`);
    await s.page.screenshot({ path: file }).catch(() => {});
    throw new Error(redact(`${label} failed: ${(e as Error).message.split("\n")[0]} (screenshot: ${file})`));
  }
}

/** Compact, redacted structural snapshot of the visible page (for probing and diagnostics). */
export async function snapshot(page: Page, redact: (s: string) => string, scope?: { containing: string; up?: number }) {
  const data = await page.evaluate((sc) => {
    let root: ParentNode = document;
    if (sc) {
      let el: Element | null = document.querySelector(sc.containing);
      for (let i = 0; el && i < (sc.up ?? 5); i++) el = el.parentElement;
      if (el) root = el;
    }
    const vis = (e: Element) => { const h = e as HTMLElement; return !!(h.offsetWidth || h.offsetHeight); };
    const lbl = (e: Element) => ((e.getAttribute("aria-label") || e.getAttribute("placeholder") || (e as HTMLElement).innerText || (e as HTMLInputElement).name || "").trim().replace(/\s+/g, " ").slice(0, 70));
    return {
      url: location.href,
      title: document.title,
      text: ((root as HTMLElement).innerText ?? document.body.innerText).replace(/\s+/g, " ").slice(0, 700),
      inputs: [...root.querySelectorAll("input,textarea")].filter(vis).map((e) => ({ type: (e as HTMLInputElement).type, name: (e as HTMLInputElement).name, label: lbl(e), autocomplete: e.getAttribute("autocomplete") })),
      buttons: [...root.querySelectorAll("button,[role=button],a,[role=radio],[role=tab],select")].filter(vis).map(lbl).filter(Boolean).slice(0, 30),
    };
  }, scope);
  return JSON.parse(redact(JSON.stringify(data)));
}
