import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "patchright";

/** Hosts whose stale tabs this tool may close. Anything else in the shared profile is left alone. */
const OWNED_HOSTS = ["claude.ai", "chatgpt.com", "grok.com", "x.ai", "accounts.google.com", "auth.openai.com"];

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  artifactsDir: string;
  close(): Promise<void>;
}

/**
 * Attach to an ALREADY-RUNNING, normally launched Chrome over CDP (never launchPersistentContext:
 * claude.ai's anti-automation sends a persistent-context browser into a challenge/logout loop).
 * Starts the run from ONE clean tab: stale tabs on platform hosts are closed first.
 */
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function cdpUp(port: string): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; }
}

const OWNER_FILE = "cc-launched.json";
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A Chrome that cc itself started is recorded next to its profile, so a later cc process can tell it from one somebody else owns. */
export function readOwner(profile: string | undefined, port: string, alive: (pid: number) => boolean = pidAlive): { pid: number } | undefined {
  if (!profile) return undefined;
  try {
    const o = JSON.parse(fs.readFileSync(path.join(profile, OWNER_FILE), "utf8")) as { pid?: number; port?: string };
    return typeof o.pid === "number" && o.port === port && alive(o.pid) ? { pid: o.pid } : undefined;
  } catch { return undefined; }
}
const writeOwner = (profile: string, port: string, pid: number) => fs.writeFileSync(path.join(profile, OWNER_FILE), JSON.stringify({ pid, port, launchedAt: new Date().toISOString() }));
const clearOwner = (profile: string | undefined) => { if (profile) try { fs.rmSync(path.join(profile, OWNER_FILE), { force: true }); } catch { /* best effort */ } };

/** If nothing listens on the debug port, start a normal (not automation-launched) Chrome with the dedicated profile and record that cc owns it. */
export async function ensureChrome(port: string): Promise<void> {
  if (await cdpUp(port)) return;
  const exe = process.env.CC_CHROME_PATH ?? DEFAULT_CHROME;
  const profile = process.env.CC_CHROME_PROFILE;
  if (!profile) throw new Error(`nothing listens on CDP port ${port} and CC_CHROME_PROFILE is not set; cannot relaunch Chrome`);
  const extra = (process.env.CC_CHROME_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...extra, "about:blank"], { detached: true, stdio: "ignore" });
  child.unref();
  if (child.pid) { fs.mkdirSync(profile, { recursive: true }); writeOwner(profile, port, child.pid); }
  for (let i = 0; i < 30; i++) { if (await cdpUp(port)) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`Chrome did not expose CDP on port ${port} within 30s`);
}

const isBlank = (url: string) => url === "about:blank" || url === "chrome://newtab/" || url === "";

export async function openSession(opts: { port?: string; artifactsDir?: string } = {}): Promise<BrowserSession> {
  const port = opts.port ?? process.env.CC_DEBUG_PORT ?? "9222";
  const artifactsDir = path.resolve(opts.artifactsDir ?? "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  await ensureChrome(port);
  const profile = process.env.CC_CHROME_PROFILE;
  const ownedByCc = !!readOwner(profile, port) && process.env.CC_KEEP_BROWSER !== "1";
  let browser: Browser, context: BrowserContext, page: Page;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    for (const p of context.pages()) {
      let host = "";
      try { host = new URL(p.url()).hostname; } catch { /* about:blank etc. */ }
      if (OWNED_HOSTS.some((h) => host === h || host.endsWith("." + h))) await p.close().catch(() => {});
    }
    page = await context.newPage();
  } catch (e) {
    // Setup failed after cc may have launched Chrome: do not leave that browser behind.
    const owner = ownedByCc ? readOwner(profile, port) : undefined;
    if (owner) { try { process.kill(owner.pid); } catch { /* already gone */ } clearOwner(profile); }
    throw e;
  }
  return {
    browser, context, page, artifactsDir,
    async close() {
      // A Chrome that cc started and nobody else is using is shut down with the run, so no browser is left idling.
      // Anything else (a Chrome somebody else started, or one with other tabs open) is left running.
      const othersInUse = context.pages().some((p) => p !== page && !isBlank(p.url()));
      if (ownedByCc && !othersInUse) {
        try { await (await browser.newBrowserCDPSession()).send("Browser.close"); clearOwner(profile); return; } catch { /* fall through to a plain disconnect */ }
      }
      // Never close the LAST tab of a browser we leave running: a Chrome with zero tabs exits, killing the shared logged-in session.
      if (context.pages().length <= 1) await page.goto("about:blank").catch(() => {});
      else await page.close().catch(() => {});
      await browser.close().catch(() => {}); // disconnects CDP only; Chrome keeps running
    },
  };
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
