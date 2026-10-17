import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "patchright";
import { sleep } from "./browser/dom.js";
import type { BrowserSession } from "./browser/chrome.js";
import { fileLock } from "./core/reauth.js";

/**
 * `cc threads`: a READ-ONLY look at the claude.ai/code thread list, with a plain account of what could and could not be read.
 * One browser (own lane, admission gate, cloned master profile) opens the page, reads the rows, and closes. It never types,
 * submits, renames or archives anything; the only click it makes is the list's own "Show N more" paging button. Page facts
 * (URL, selectors, status words, challenge markers) live in data/selectors/claude-code.json, not here.
 */

export interface ThreadsSpec {
  url: string; hosts: string[]; rowSelector: string; idPattern: string; labelSelector: string; environmentLabels: string[]; noStatusText: string;
  showMore: { buttonLabel: string; maxClicks: number; growWaitMs: number };
  signedOutMarkers: string[];
  humanCheck: { titles: string[]; bodyMarkers: string[]; frameHosts: string[] };
  cloudflare: { cookie: string; hosts: string[] };
  timeouts: { rowsMs: number; listStableChecks: number };
}

export const loadThreadsSpec = (file = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"), "claude-code.json")): ThreadsSpec => JSON.parse(fs.readFileSync(file, "utf8")) as ThreadsSpec;

export interface Thread { id: string; title: string; status: string }
export type BlockerKind = "human-check" | "signed-out" | "unexpected-page" | "list-not-found" | "reauth-running" | "other-threads-run" | "error";

export interface ThreadsReport {
  /** True only when the list was read completely (paging finished, count stable) and nothing blocked the run. */
  ok: boolean;
  threads: Thread[];
  list: {
    count: number;
    /** "yes": the paging button disappeared and the count held steady; "no": it did not; "unknown": nothing was read. */
    complete: "yes" | "no" | "unknown";
    pagingClicks: number;
    rowsBeforePaging: number;
    statusCounts: Record<string, number>;
    notes: string[];
  };
  cloudflare: { clearanceCookie: string; inMasterProfile: boolean; afterRun: boolean };
  timing: { totalMs: number; browserStartMs: number; pageLoadMs: number; listReadMs: number; waitedForReauthMs: number };
  browsers: number;
  chromeProcesses?: number;
  /** Something that stopped or limited the run. Reported, never worked around. */
  blocker?: { kind: BlockerKind; detail: string };
}

const clean = (s: string) => s.replace(/[-​-‍⁠﻿]/g, " ").replace(/\s+/g, " ").trim();

/** Shape of one raw row as read from the DOM. Exported so the parsing is testable without a browser. */
export interface RawRow { href: string; labels: string[]; title: string }

/** Turn raw rows into threads (deduplicated by id; Pinned and Recents may show the same thread). */
export function parseRows(rows: RawRow[], spec: Pick<ThreadsSpec, "idPattern" | "environmentLabels" | "noStatusText">): Thread[] {
  const rx = new RegExp(spec.idPattern);
  const env = new Set(spec.environmentLabels.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  const out: Thread[] = [];
  for (const r of rows) {
    const id = rx.exec(r.href)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const status = r.labels.map(clean).filter(Boolean).find((l) => !env.has(l.toLowerCase())) ?? spec.noStatusText;
    out.push({ id, title: clean(r.title), status });
  }
  return out;
}

async function readRows(page: Page, spec: ThreadsSpec): Promise<RawRow[]> {
  return page.$$eval(spec.rowSelector, (as, labelSel) => as.map((a) => {
    const clone = a.cloneNode(true) as HTMLElement;
    const labels = [...clone.querySelectorAll(labelSel)].map((e) => e.textContent ?? "");
    clone.querySelectorAll(labelSel).forEach((e) => e.remove());
    return { href: a.getAttribute("href") ?? "", labels, title: clone.textContent ?? "" };
  }), spec.labelSelector);
}

async function hasShowMore(page: Page, label: string): Promise<boolean> {
  return page.evaluate((l) => [...document.querySelectorAll("button")].some((x) => (x.getAttribute("aria-label") ?? "").toLowerCase().includes(l.toLowerCase())), label);
}

/** Click the list's own paging button (matched on aria-label) with a DOM click: it sits below the fold inside the sidebar scroller, where a real click times out. */
async function clickShowMore(page: Page, label: string): Promise<boolean> {
  return page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") ?? "").toLowerCase().includes(l.toLowerCase()));
    if (!b) return false;
    b.click();
    return true;
  }, label);
}

type PageState = { kind: "list" } | { kind: BlockerKind; detail: string };

/** What the page in front of us is. Human check and sign-in loss are reported, never acted on. */
export async function classifyPage(page: Page, spec: ThreadsSpec): Promise<PageState> {
  const url = page.url();
  const title = (await page.title().catch(() => "")).toLowerCase();
  const body = (await page.evaluate(() => document.body?.innerText.slice(0, 800) ?? "").catch(() => "")).toLowerCase();
  const frames = page.frames().map((f) => { try { return new URL(f.url()).hostname; } catch { return ""; } });
  const hc = spec.humanCheck;
  if (hc.titles.some((t) => title.includes(t)) || hc.bodyMarkers.some((m) => body.includes(m)) || frames.some((h) => hc.frameHosts.some((x) => h === x || h.endsWith("." + x)))) {
    return { kind: "human-check", detail: "a human-check (Cloudflare) page was shown instead of the thread list; cc does not try to get past it" };
  }
  let host = "", p = "";
  try { const u = new URL(url); host = u.hostname; p = u.pathname; } catch { /* about:blank etc. */ }
  if (/\/login|\/logout/.test(p) || spec.signedOutMarkers.some((m) => body.includes(m)) && !(await page.$(spec.rowSelector))) {
    return { kind: "signed-out", detail: "claude.ai is not signed in in cc's browser profile (re-seed or re-run the claude sign-in; cc does not log in here)" };
  }
  if (!spec.hosts.some((h) => host === h || host.endsWith("." + h)) || !p.startsWith(new URL(spec.url).pathname)) {
    return { kind: "unexpected-page", detail: `landed on ${host}${p} instead of ${new URL(spec.url).pathname}` };
  }
  return { kind: "list" };
}

async function chromeProcessCount(s: Pick<BrowserSession, "browser">): Promise<number | undefined> {
  try {
    const cdp = await s.browser.newBrowserCDPSession();
    const r = await cdp.send("SystemInfo.getProcessInfo" as never) as unknown as { processInfo?: unknown[] };
    return r.processInfo?.length;
  } catch { return undefined; }
}

const hasCookie = (cookies: { name: string; domain: string }[], name: string, hosts: string[]) =>
  cookies.some((c) => c.name === name && hosts.some((h) => { const d = c.domain.replace(/^\./, ""); return d === h || d.endsWith("." + h) || h.endsWith("." + d); }));

/** Read the list from an open session. Never throws for page problems: they come back as a `blocker`. */
export async function readThreads(s: Pick<BrowserSession, "browser" | "context" | "page">, spec: ThreadsSpec, ctx: { browserStartMs: number; waitedForReauthMs: number }): Promise<ThreadsReport> {
  const cf = spec.cloudflare;
  const inMaster = hasCookie(await s.context.cookies(), cf.cookie, cf.hosts); // names only; taken before the page is opened, so it describes the saved master, not this run
  const report: ThreadsReport = {
    ok: false, threads: [],
    list: { count: 0, complete: "unknown", pagingClicks: 0, rowsBeforePaging: 0, statusCounts: {}, notes: [] },
    cloudflare: { clearanceCookie: cf.cookie, inMasterProfile: inMaster, afterRun: inMaster },
    timing: { totalMs: 0, browserStartMs: ctx.browserStartMs, pageLoadMs: 0, listReadMs: 0, waitedForReauthMs: ctx.waitedForReauthMs },
    browsers: 1,
  };
  const page = s.page;
  try {
    const t1 = Date.now();
    await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector(spec.rowSelector, { timeout: spec.timeouts.rowsMs }).catch(() => {});
    report.timing.pageLoadMs = Date.now() - t1;
    const state = await classifyPage(page, spec);
    if (state.kind !== "list") { report.blocker = { kind: state.kind, detail: state.detail }; return report; }
    if (!(await page.$(spec.rowSelector))) {
      report.blocker = { kind: "list-not-found", detail: `no thread rows (${spec.rowSelector}) appeared within ${Math.round(spec.timeouts.rowsMs / 1000)}s; the page may have changed (fix data/selectors/claude-code.json) or the account has no threads` };
      return report;
    }
    const t2 = Date.now();
    const count = () => page.locator(spec.rowSelector).count();
    const settle = async () => { // the first page fills progressively: wait until the count holds
      let last = -1, stable = 0;
      for (let i = 0; i < 40 && stable < spec.timeouts.listStableChecks; i++) { const n = await count(); stable = n === last ? stable + 1 : 0; last = n; await sleep(800); }
      return stable >= spec.timeouts.listStableChecks;
    };
    let steady = await settle();
    report.list.rowsBeforePaging = await count();
    for (let i = 0; i < spec.showMore.maxClicks; i++) {
      const before = await count();
      if (!(await clickShowMore(page, spec.showMore.buttonLabel))) break;
      report.list.pagingClicks++;
      const deadline = Date.now() + spec.showMore.growWaitMs;
      while (Date.now() < deadline && (await count()) <= before) await sleep(500);
      await sleep(800);
    }
    const buttonGone = !(await hasShowMore(page, spec.showMore.buttonLabel));
    steady = (await settle()) && steady;
    report.threads = parseRows(await readRows(page, spec), spec);
    report.timing.listReadMs = Date.now() - t2;
    report.list.count = report.threads.length;
    for (const t of report.threads) report.list.statusCounts[t.status] = (report.list.statusCounts[t.status] ?? 0) + 1;
    report.list.complete = steady && buttonGone ? "yes" : "no";
    if (!steady) report.list.notes.push("the row count was still changing when the read ended");
    if (!buttonGone) report.list.notes.push(`the paging button was still offered after ${report.list.pagingClicks} click(s); more threads may exist than were read`);
    if (report.threads.some((t) => !t.title)) report.list.notes.push("at least one row had no readable title");
    report.list.notes.push("only the sidebar's own list is read: threads the page does not list (for example archived ones) cannot be seen, so \"complete\" means complete as far as the page offers");
    report.chromeProcesses = await chromeProcessCount(s);
    report.cloudflare.afterRun = hasCookie(await s.context.cookies(), cf.cookie, cf.hosts);
    report.ok = report.list.complete === "yes" && report.threads.length > 0;
  } catch (e) {
    report.blocker = { kind: "error", detail: String((e as Error).message ?? e).split("\n")[0].replace(/\?[^\s)]*/g, "?…") };
  }
  return report;
}

export interface RunThreadsOptions {
  /** Opens the one browser. Production: openSession from src/browser/chrome.js (lane, admission gate, cloned master). */
  open: () => Promise<BrowserSession>;
  spec?: ThreadsSpec;
  /** Where `cc reauth` keeps its per-connector locks (CC_LOCK_DIR). */
  lockDir?: string;
  /** How long to wait for a running `cc reauth` to finish before giving up. */
  reauthWaitMs?: number;
}

const lockDirDefault = () => process.env.CC_LOCK_DIR ?? path.join(os.tmpdir(), "cc-reauth-locks");
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const THREADS_LOCK = "_threads";

/** A `cc reauth` lock held by a live process (the lock file holds the owner's pid; older than 20 minutes counts as dead, as in fileLock). */
export function reauthRunning(dir: string, now = Date.now()): boolean {
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith(".lock") || f === `${THREADS_LOCK}.lock`) continue;
    try {
      const file = path.join(dir, f);
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (Number.isFinite(pid) && pid > 0 && pidAlive(pid) && now - fs.statSync(file).mtimeMs < 20 * 60_000) return true;
    } catch { /* unreadable: not a live lock */ }
  }
  return false;
}

/**
 * The whole operation: refuse to overlap with `cc reauth` (waits while a renewal holds a lock, polling slowly), take its own
 * lock so two `cc threads` never run together, open ONE browser, read, close. The browser is always closed.
 */
export async function runThreads(o: RunThreadsOptions): Promise<ThreadsReport> {
  const started = Date.now();
  const spec = o.spec ?? loadThreadsSpec();
  const dir = o.lockDir ?? lockDirDefault();
  const empty = (kind: BlockerKind, detail: string, waited = 0): ThreadsReport => ({
    ok: false, threads: [], list: { count: 0, complete: "unknown", pagingClicks: 0, rowsBeforePaging: 0, statusCounts: {}, notes: [] },
    cloudflare: { clearanceCookie: spec.cloudflare.cookie, inMasterProfile: false, afterRun: false },
    timing: { totalMs: Date.now() - started, browserStartMs: 0, pageLoadMs: 0, listReadMs: 0, waitedForReauthMs: waited }, browsers: 0, blocker: { kind, detail },
  });
  const release = fileLock(dir)(THREADS_LOCK);
  if (!release) return empty("other-threads-run", "another `cc threads` run is in progress; try again when it has finished");
  try {
    const waitMs = o.reauthWaitMs ?? (Number(process.env.CC_THREADS_REAUTH_WAIT_MS) || 10 * 60_000);
    const w0 = Date.now();
    while (reauthRunning(dir)) {
      if (Date.now() - w0 > waitMs) return empty("reauth-running", `a \`cc reauth\` renewal was still running after ${Math.round(waitMs / 1000)}s; not starting a browser alongside it`, Date.now() - w0);
      await sleep(2000);
    }
    const waited = Date.now() - w0;
    const b0 = Date.now();
    let session: BrowserSession;
    try { session = await o.open(); } catch (e) { return empty("error", `could not open the browser: ${String((e as Error).message).split("\n")[0]}`, waited); }
    try {
      const report = await readThreads(session, spec, { browserStartMs: Date.now() - b0, waitedForReauthMs: waited });
      report.timing.totalMs = Date.now() - started;
      return report;
    } finally { await session.close().catch(() => {}); }
  } finally { release(); }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** Plain-words rendering for the terminal. */
export function formatReport(r: ThreadsReport): string[] {
  const out: string[] = [];
  out.push(`claude.ai/code threads: ${r.list.count} read, list complete: ${r.list.complete}`);
  if (r.threads.length) {
    const w = Math.max(...r.threads.map((t) => t.status.length));
    for (const t of r.threads) out.push(`${t.id}  ${t.status.padEnd(w)}  ${t.title}`);
  }
  out.push("");
  out.push("what could and could not be read:");
  if (r.blocker) out.push(`  STOPPED (${r.blocker.kind}): ${r.blocker.detail}`);
  out.push(`  list: ${r.list.count} thread(s); ${r.list.rowsBeforePaging} on first load, ${r.list.pagingClicks} click(s) on the paging button; complete: ${r.list.complete}`);
  const sc = Object.entries(r.list.statusCounts).map(([k, v]) => `${k}: ${v}`).join(", ");
  if (sc) out.push(`  statuses: ${sc}`);
  for (const n of r.list.notes) out.push(`  note: ${n}`);
  out.push(`  Cloudflare clearance cookie (${r.cloudflare.clearanceCookie}, name only): ${r.cloudflare.inMasterProfile ? "present" : "ABSENT"} in the saved master profile; ${r.cloudflare.afterRun ? "present" : "absent"} after the run`);
  out.push(`  time: ${secs(r.timing.totalMs)} in all (browser start ${secs(r.timing.browserStartMs)}, page load ${secs(r.timing.pageLoadMs)}, list read ${secs(r.timing.listReadMs)}${r.timing.waitedForReauthMs > 1000 ? `, waited for reauth ${secs(r.timing.waitedForReauthMs)}` : ""})`);
  out.push(`  browsers: ${r.browsers}${r.chromeProcesses !== undefined ? `; Chrome processes at the end of the read: ${r.chromeProcesses}` : ""}`);
  return out;
}
