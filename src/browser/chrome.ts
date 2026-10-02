import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "patchright";
import { acquireLane, type Lane } from "./lanes.js";
import { cloneProfile, removeProfile, syncBack } from "./profile.js";

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
export interface AuthSpec { cookie: string; hosts: string[]; ssoHosts: string[] }

export function loadAuthSpecs(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): Record<string, AuthSpec> {
  const out: Record<string, AuthSpec> = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".json")) continue;
    const a = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { auth?: Partial<AuthSpec> }).auth;
    if (a?.cookie && a.hosts?.length) out[f.replace(/\.json$/, "")] = { cookie: a.cookie, hosts: a.hosts, ssoHosts: a.ssoHosts ?? [] };
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
  const base = e.HELM_DATA_ROOT
    ?? (platform === "win32" ? path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", "connector-connector-mcp")
      : platform === "darwin" ? path.join(home, "Library", "Application Support", "HELM", "connector-connector-mcp")
      : path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", "connector-connector-mcp"));
  return path.join(base, "browser-master");
}

async function cdpUp(port: number): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}

/** Start a normal (not automation-launched) Chrome on a user-data-dir and CDP port. Playwright's persistent-context API is never used. */
export async function launchChrome(userDataDir: string, port: number): Promise<{ child: ChildProcess; exited: Promise<void> }> {
  const exe = process.env.CC_CHROME_PATH ?? DEFAULT_CHROME;
  const extra = (process.env.CC_CHROME_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", ...extra, "about:blank"], { stdio: "ignore", windowsHide: false });
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
    const { generation } = await cloneProfile(master, runDir);
    launched = await launchChrome(runDir, lane.port);
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
    return {
      browser: br, context, page, artifactsDir, touched,
      async close() {
        let healthy = false;
        try {
          const specs = loadAuthSpecs();
          const cookies = await context.cookies();
          healthy = sessionHealthy(cookies, touched, specs);
          if (healthy) {
            // Session-only cookies vanish when Chrome exits; make the auth ones persistent so the write-back carries them.
            const hosts = Object.values(specs).flatMap((s) => [...s.hosts, ...s.ssoHosts]);
            const promote = cookies.filter((c) => c.expires <= 0 && domainMatches(c.domain, hosts)).map((c) => ({ ...c, expires: Math.floor(Date.now() / 1000) + SESSION_COOKIE_LIFETIME_S }));
            if (promote.length) await context.addCookies(promote).catch(() => {});
          }
        } catch { /* a dead browser is simply not healthy */ }
        await shutdownChrome(br, child.child, child.exited);
        try { if (healthy) await syncBack(run, master, generation); } catch { /* the master keeps its previous state */ }
        removeProfile(run);
        lane.release();
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
