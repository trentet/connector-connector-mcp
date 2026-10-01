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
export async function openSession(opts: { port?: string; artifactsDir?: string } = {}): Promise<BrowserSession> {
  const port = opts.port ?? process.env.CC_DEBUG_PORT ?? "9222";
  const artifactsDir = path.resolve(opts.artifactsDir ?? "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error("CDP browser has no default context");
  for (const p of context.pages()) {
    let host = "";
    try { host = new URL(p.url()).hostname; } catch { /* about:blank etc. */ }
    if (OWNED_HOSTS.some((h) => host === h || host.endsWith("." + h))) await p.close().catch(() => {});
  }
  const page = await context.newPage();
  return {
    browser, context, page, artifactsDir,
    async close() {
      await page.close().catch(() => {});
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
export async function snapshot(page: Page, redact: (s: string) => string) {
  const data = await page.evaluate(() => {
    const vis = (e: Element) => { const h = e as HTMLElement; return !!(h.offsetWidth || h.offsetHeight); };
    const lbl = (e: Element) => ((e.getAttribute("aria-label") || e.getAttribute("placeholder") || (e as HTMLElement).innerText || (e as HTMLInputElement).name || "").trim().replace(/\s+/g, " ").slice(0, 70));
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.replace(/\s+/g, " ").slice(0, 700),
      inputs: [...document.querySelectorAll("input,textarea")].filter(vis).map((e) => ({ type: (e as HTMLInputElement).type, name: (e as HTMLInputElement).name, label: lbl(e), autocomplete: e.getAttribute("autocomplete") })),
      buttons: [...document.querySelectorAll("button,[role=button],a")].filter(vis).map(lbl).filter(Boolean).slice(0, 30),
    };
  });
  return JSON.parse(redact(JSON.stringify(data)));
}
