import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "patchright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchChrome, openSession, shutdownChrome, type BrowserSession } from "../src/browser/chrome.js";
import { formatReport, loadThreadsSpec, parseRows, runThreads, type ThreadsSpec } from "../src/threads.js";

const CHROME = process.env.CC_TEST_CHROME ?? (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
const HEADLESS = "--headless=new --no-sandbox --disable-gpu";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const real = loadThreadsSpec();

describe("parseRows (shapes captured live from claude.ai/code 2026-10-17)", () => {
  it("takes the first non-environment label as the status, 'none' when there is only the environment", () => {
    const t = parseRows([
      { href: "/code/session_01Aaa", labels: ["Running", "Cloud"], title: "[PEND][PIP] W20 Why processed files are not relocated" },
      { href: "/code/session_01Bbb", labels: ["Unread response", "Cloud"], title: "[ASK][CC][010] Connector Connector controller " },
      { href: "/code/session_01Ccc", labels: ["Cloud"], title: "[CLOSED][PIP] W9 evidence coverage map by date" },
    ], real);
    expect(t).toEqual([
      { id: "session_01Aaa", status: "Running", title: "[PEND][PIP] W20 Why processed files are not relocated" },
      { id: "session_01Bbb", status: "Unread response", title: "[ASK][CC][010] Connector Connector controller" },
      { id: "session_01Ccc", status: "none", title: "[CLOSED][PIP] W9 evidence coverage map by date" },
    ]);
  });
  it("ignores links that are not threads, drops icon-font characters, and lists a thread once even if it is shown twice", () => {
    const t = parseRows([
      { href: "/code/artifacts", labels: [], title: "Artifacts" },
      { href: "/code/session_01Aaa", labels: ["Awaiting input"], title: " Pinned one" },
      { href: "/code/session_01Aaa", labels: ["Awaiting input"], title: " Pinned one" },
    ], real);
    expect(t).toEqual([{ id: "session_01Aaa", status: "Awaiting input", title: "Pinned one" }]);
  });
});

// ---- real Chromium against a fake claude.ai/code ----
const row = (id: string, title: string, labels: string[]) => `<div data-row><a href="/code/session_${id}">${title}${labels.map((l) => `<span class="sr-only">${l}</span>`).join("")}</a><button aria-label="More options for ${title}">...</button></div>`;
const FIRST = [row("AAA1", "[PEND][X] first", ["Running", "Cloud"]), row("AAA2", "[ASK][X] second", ["Awaiting input", "Cloud"]), row("AAA3", "[CLOSED][X] third", ["Cloud"]), row("AAA4", "[SLEEP][X] fourth ", ["Unread response", "Cloud"])];
const PAGE2 = [row("BBB1", "[PEND][Y] fifth", ["Running", "Cloud"]), row("BBB2", "[ASK][Y] sixth", ["Unread response", "Cloud"])];
const PAGE3 = [row("CCC1", "[CLOSED][Z] seventh", ["Cloud"]), row("AAA1", "[PEND][X] first", ["Running", "Cloud"]) /* shown twice */];

const listPage = (stuck: boolean) => `<!doctype html><title>Claude Code</title><body><nav><a href="/code/artifacts">Artifacts</a><a href="/code/routines">Routines</a><div id="recents">${FIRST.join("")}</div>
<button id="more" aria-label="Show 2 more in Recents" style="margin-top:3000px">Show more</button></nav>
<script>
let step = 0;
document.getElementById("more").onclick = () => {
  const pages = [${JSON.stringify(PAGE2)}, ${JSON.stringify(PAGE3)}];
  const b = document.getElementById("more");
  setTimeout(() => {
    document.getElementById("recents").insertAdjacentHTML("beforeend", pages[step].join(""));
    step++;
    if (step === 1) b.setAttribute("aria-label", "Show 2 more in Recents");
    else if (!${stuck}) b.remove();
  }, 700);
};
</script>`;

let site: http.Server;
let origin = "";
const state = { cloudflareTitle: false };
beforeAll(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/code") return void res.end(listPage(false));
    if (u.pathname === "/stuck/code") return void res.end(listPage(true).replace("</nav>", "</nav>"));
    if (u.pathname === "/challenge/code") return void res.end(`<!doctype html><title>Just a moment...</title><body><p>Verify you are human</p>`);
    if (u.pathname === "/signedout/code") { res.statusCode = 302; res.setHeader("location", "/login"); return void res.end(); }
    if (u.pathname === "/login") return void res.end(`<!doctype html><title>Claude</title><body><button>Continue with Google</button>`);
    if (u.pathname === "/empty/code") return void res.end(`<!doctype html><title>Claude Code</title><body><p>Nothing here</p>`);
    res.statusCode = 404; res.end("no");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  void state;
});
afterAll(async () => { await new Promise((r) => site.close(r)); });

const opened: BrowserSession[] = [];
const envKeys = ["CC_CHROME_PATH", "CC_BROWSER_MASTER", "CC_CHROME_EXTRA_ARGS", "CC_LANES_DIR", "CC_MAX_CONCURRENCY", "CC_LANE_PORT_BASE", "CC_SELECTORS_DIR", "CC_ADMIT"];
afterEach(async () => { while (opened.length) await opened.pop()!.close().catch(() => {}); for (const k of envKeys) delete process.env[k]; });

/** A master profile that does (or does not) hold a cf_clearance cookie for the fake origin. */
async function setup(portBase: number, withClearance: boolean) {
  const master = tmp("cc-master-");
  Object.assign(process.env, { CC_CHROME_PATH: CHROME, CC_BROWSER_MASTER: master, CC_CHROME_EXTRA_ARGS: HEADLESS, CC_LANES_DIR: tmp("cc-lanes-"), CC_MAX_CONCURRENCY: "2", CC_LANE_PORT_BASE: String(portBase), CC_ADMIT: "off", CC_SELECTORS_DIR: path.resolve("data", "selectors") });
  const l = await launchChrome(master, portBase + 50);
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${portBase + 50}`);
  const ctx = b.contexts()[0];
  await ctx.addCookies([{ name: "other", value: "x", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }, ...(withClearance ? [{ name: "cf_clearance", value: "secret-clearance-value", url: origin, expires: Math.floor(Date.now() / 1000) + 86400 }] : [])]);
  await shutdownChrome(b, l.child, l.exited);
}
const specFor = (p: string): ThreadsSpec => ({ ...real, url: origin + p, hosts: ["127.0.0.1"], cloudflare: { ...real.cloudflare, hosts: ["127.0.0.1"] }, timeouts: { rowsMs: 4000, listStableChecks: 2 }, showMore: { ...real.showMore, maxClicks: 4, growWaitMs: 3000 } });
const open = async () => { const s = await openSession({ artifactsDir: tmp("cc-art-") }); opened.push(s); return s; };

describe("cc threads names the account it read (issue #81)", () => {
  it("the report carries the account id and the text says it; without one nothing is added", async () => {
    const failing = async () => { throw new Error("no browser in this test"); };
    const withAcc = await runThreads({ open: failing as never, account: "third", spec: real });
    expect(withAcc.account).toBe("third");
    expect(formatReport(withAcc).join("\n")).toContain("account: third");
    const without = await runThreads({ open: failing as never, spec: real });
    expect(without.account).toBeUndefined();
    expect(formatReport(without).join("\n")).not.toContain("account:");
  });
});

describe.skipIf(!CHROME)("cc threads (real Chromium, fake claude.ai/code)", () => {
  it("reads every page of a paged list, reports status per thread, the cookie by name only, one browser, and never writes", async () => {
    await setup(9560, true);
    const rep = await runThreads({ open, spec: specFor("/code") });
    expect(rep.blocker).toBeUndefined();
    expect(rep.ok).toBe(true);
    expect(rep.list).toMatchObject({ count: 7, complete: "yes", rowsBeforePaging: 4, pagingClicks: 2 });
    expect(rep.threads.map((t) => [t.id, t.status])).toEqual([
      ["session_AAA1", "Running"], ["session_AAA2", "Awaiting input"], ["session_AAA3", "none"], ["session_AAA4", "Unread response"],
      ["session_BBB1", "Running"], ["session_BBB2", "Unread response"], ["session_CCC1", "none"],
    ]);
    expect(rep.threads[3].title).toBe("[SLEEP][X] fourth"); // icon-font glyph dropped
    expect(rep.list.statusCounts).toEqual({ Running: 2, "Awaiting input": 1, none: 2, "Unread response": 2 });
    expect(rep.cloudflare).toEqual({ clearanceCookie: "cf_clearance", inMasterProfile: true, afterRun: true });
    expect(rep.browsers).toBe(1);
    expect(rep.chromeProcesses).toBeGreaterThan(0);
    expect(rep.timing.totalMs).toBeGreaterThan(0);
    const text = formatReport(rep).join("\n");
    expect(text).toContain("session_AAA2");
    expect(text).toContain("present in the saved master profile");
    expect(text).not.toContain("secret-clearance-value");
    expect(JSON.stringify(rep)).not.toContain("secret-clearance-value");
  }, 90_000);

  it("says plainly when the clearance cookie is absent from the saved master", async () => {
    await setup(9570, false);
    const rep = await runThreads({ open, spec: specFor("/code") });
    expect(rep.cloudflare.inMasterProfile).toBe(false);
    expect(formatReport(rep).join("\n")).toContain("ABSENT");
  }, 90_000);

  it("does not call a list complete when the paging button never goes away", async () => {
    await setup(9580, true);
    const rep = await runThreads({ open, spec: specFor("/stuck/code") });
    expect(rep.ok).toBe(false);
    expect(rep.list.complete).toBe("no");
    expect(rep.list.notes.join(" ")).toMatch(/paging button was still offered/);
  }, 90_000);

  it("reports a human-check page and stops, reading nothing", async () => {
    await setup(9590, true);
    const rep = await runThreads({ open, spec: specFor("/challenge/code") });
    expect(rep.ok).toBe(false);
    expect(rep.blocker?.kind).toBe("human-check");
    expect(rep.threads).toEqual([]);
  }, 60_000);

  it("reports a sign-in loss and stops", async () => {
    await setup(9600, true);
    const rep = await runThreads({ open, spec: specFor("/signedout/code") });
    expect(rep.blocker?.kind).toBe("signed-out");
    expect(rep.ok).toBe(false);
  }, 60_000);

  it("reports a page with no thread rows (page drift) instead of an empty success", async () => {
    await setup(9610, true);
    const rep = await runThreads({ open, spec: specFor("/empty/code") });
    expect(rep.blocker?.kind).toBe("list-not-found");
    expect(rep.ok).toBe(false);
  }, 60_000);

  it("closes its browser and frees its lane on every path", async () => {
    await setup(9620, true);
    let closed = 0;
    const counting = async () => { const s = await open(); const c = s.close.bind(s); s.close = async () => { closed++; await c(); }; return s; };
    await runThreads({ open: counting, spec: specFor("/challenge/code") });
    expect(closed).toBe(1);
    expect(fs.readdirSync(process.env.CC_LANES_DIR!).filter((f) => f.startsWith("slot-"))).toEqual([]);
  }, 60_000);
});

describe.skipIf(!CHROME)("cc threads never waits for a renewal or for another read (v0.2.8)", () => {
  it("runs while a renewal lock is held and while another read runs, and every run completes", async () => {
    await setup(9630, true);
    const lockDir = tmp("cc-locks-");
    process.env.CC_LOCK_DIR = lockDir;
    fs.writeFileSync(path.join(lockDir, "some-connector.lock"), String(process.pid)); // a live renewal lock: reads no longer care
    const t0 = Date.now();
    const [a, b] = await Promise.all([runThreads({ open, spec: specFor("/code") }), runThreads({ open, spec: specFor("/code") })]);
    delete process.env.CC_LOCK_DIR;
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.list.count).toBe(7);
    expect(b.list.count).toBe(7);
    expect(a.timing.waitedForReauthMs).toBe(0);
    expect(b.timing.waitedForReauthMs).toBe(0);
    expect(Date.now() - t0).toBeLessThan(80_000);
    expect(fs.existsSync(path.join(lockDir, "_threads.lock"))).toBe(false); // no lock of its own is ever taken
  }, 120_000);
});
