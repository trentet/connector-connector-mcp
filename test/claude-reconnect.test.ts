// @reqs REQ-D012
// claude.ai: Reconnect is pressed like Connect, the sign-in round trip is awaited, a registered row that is not Connected is repaired.
// Page facts (found live 15 Nov 2026, page notes pages 1 to 4): a re-added row shows "Your session has expired" with a Reconnect button;
// pressing it sends the SAME tab to the connector's own sign-in page and back to claude.ai.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { awaitSignInRoundTrip, claudeAdapter, connectIfNeeded, isConnectAction, timing } from "../src/adapters/claude.js";
import type { AdapterContext, ResolvedConnector } from "../src/adapters/types.js";

const CLAUDE = "https://claude.ai/customize/connectors/yours";
let clock = 0;
let sleeps: number[] = [];
const realTiming = { ...timing };
beforeEach(() => { clock = 0; sleeps = []; timing.now = () => clock; timing.sleep = async (ms: number) => { sleeps.push(ms); clock += ms; }; });
afterEach(() => { timing.now = realTiming.now; timing.sleep = realTiming.sleep; });

interface World { ctx: AdapterContext; log: string[]; clicks: () => string[]; pressedAt: () => number | undefined; gotosAfterPress: () => number[] }
/** A fake claude.ai: one list of rows, a fake clock, and a tab that goes away to the connector's sign-in page after a press. */
function world(o: { initial: "reconnect" | "connected" | "connect" | "missing"; away?: { fromMs: number; untilMs: number | null; url: string }; connectsAfterReturn?: boolean }): World {
  const log: string[] = [];
  let pressedAt: number | undefined;
  let base = CLAUDE;
  let forcedBack = false; // a goto() moves the tab back to claude.ai
  const awayNow = () => !forcedBack && !!(o.away && pressedAt !== undefined && clock - pressedAt >= o.away.fromMs && (o.away.untilMs === null || clock - pressedAt < o.away.untilMs));
  const returned = () => pressedAt !== undefined && (!o.away || (o.away.untilMs !== null && clock - pressedAt >= o.away.untilMs));
  const connected = () => o.initial === "connected" || (pressedAt !== undefined && o.connectsAfterReturn !== false && returned());
  const rows = (): Array<{ text: string; buttons: string[] }> => {
    const out = [{ text: "Gmail Web Connected", buttons: [] as string[] }, { text: "DSM Connect TEST Web Custom Reconnect", buttons: ["More options for DSM Connect TEST", "Reconnect"] }];
    if (o.initial !== "missing") {
      out.push({ text: "DSM Connect Web Custom " + (connected() ? "Connected" : o.initial === "connect" ? "Connect" : "Reconnect"), buttons: connected() ? ["More options for DSM Connect"] : ["More options for DSM Connect", o.initial === "connect" ? "Connect" : "Reconnect"] });
    }
    return out;
  };
  const page = {
    url: () => (awayNow() ? o.away!.url : base),
    goto: async (u: string) => { if (awayNow()) log.push("goto-while-away"); log.push(`goto@${clock}`); base = u; if (pressedAt !== undefined) forcedBack = true; },
    waitForSelector: async () => undefined,
    evaluate: async () => "customize connectors",
    $$eval: async (_s: string, fn: (r: Array<{ innerText: string }>) => unknown) => fn(rows().map((r) => ({ innerText: r.text }))),
    locator: (_s: string) => ({
      nth: (i: number) => ({
        getByRole: (_role: string, opt: { name: RegExp }) => {
          const matching = rows()[i].buttons.filter((b) => opt.name.test(b));
          return { count: async () => matching.length, first: () => ({ evaluate: async () => { log.push(`click:${i}:${matching[0]}`); if (isConnectAction(matching[0]) && pressedAt === undefined) pressedAt = clock; } }) };
        },
      }),
    }),
  };
  const ctx: AdapterContext = { platform: "claude", redact: (x) => x, session: async () => ({ page }) as never };
  return { ctx, log, clicks: () => log.filter((l) => l.startsWith("click:")), pressedAt: () => pressedAt, gotosAfterPress: () => { const i = log.findIndex((l) => l.startsWith("click:")); return i < 0 ? [] : log.slice(i + 1).filter((l) => l.startsWith("goto@")).map((l) => Number(l.slice(5))); } };
}
const dsm: ResolvedConnector = { def: { id: "dsm-connect", name: "DSM Connect", auth: { mode: "oauth" }, platforms: ["claude"] } as never, name: "DSM Connect", url: "https://dsm.trentt.me/mcp?client=claude" };
const AWAY = { fromMs: 2000, untilMs: 20000, url: "https://dsm.trentt.me/login?txn=abc&code=SECRET123" };

describe("REQ-D012 claude.ai Reconnect", () => {
  it("TC-D012-01 the names Connect and Reconnect, in any case, are pressable", () => {
    for (const n of ["Connect", "Reconnect", "connect", "RECONNECT", " Reconnect "]) expect(isConnectAction(n), n).toBe(true);
  });
  it("TC-D012-02 Disconnect, More options for DSM Connect, Connect to server and Reconnecting are never pressable", () => {
    for (const n of ["Disconnect", "More options for DSM Connect", "Connect to server", "Reconnecting", "Copy server URL", ""]) expect(isConnectAction(n), n).toBe(false);
  });
  it("TC-D012-03 the pattern is data in data/selectors/claude.json and the code holds no copy of it", () => {
    const sel = JSON.parse(readFileSync("data/selectors/claude.json", "utf8"));
    expect(new RegExp(sel.add.rowConnectButton, "i").test("Reconnect")).toBe(true);
    expect(new RegExp(sel.add.rowConnectButton, "i").test("Disconnect")).toBe(false);
    const src = readFileSync("src/adapters/claude.ts", "utf8");
    expect(src).not.toContain("(re)?connect");
    expect(src).not.toContain("^connect$");
  });
  it("TC-D012-04 add skip on a Reconnect row presses once, waits for the round trip, and reports ok when the row is then Connected", async () => {
    const w = world({ initial: "reconnect", away: AWAY });
    const r = await claudeAdapter().add(w.ctx, dsm, "skip");
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Reconnect");
    expect(w.clicks()).toEqual(["click:2:Reconnect"]);
  });
  it("TC-D012-05 add skip on a Connected row is skipped and nothing is pressed", async () => {
    const w = world({ initial: "connected" });
    const r = await claudeAdapter().add(w.ctx, dsm, "skip");
    expect(r.status).toBe("skipped");
    expect(w.clicks()).toEqual([]);
  });
  it("TC-D012-06 a row that is not listed is never pressed", async () => {
    const w = world({ initial: "missing" });
    const r = await connectIfNeeded(w.ctx, "DSM Connect");
    expect(r.row).toBeUndefined();
    expect(w.clicks()).toEqual([]);
  });
  it("TC-D012-07 while the tab is on the connector's sign-in page cc waits and reads the list only after the tab is back on claude.ai", async () => {
    const w = world({ initial: "reconnect", away: AWAY });
    await connectIfNeeded(w.ctx, "DSM Connect");
    const t0 = w.pressedAt()!;
    expect(t0).toBeDefined();
    expect(w.gotosAfterPress().length).toBeGreaterThan(0);
    for (const t of w.gotosAfterPress()) expect(t - t0).toBeGreaterThanOrEqual(AWAY.untilMs);
  });
  it("TC-D012-08 no navigation of the tab happens before the tab is back", async () => {
    const w = world({ initial: "reconnect", away: AWAY });
    await connectIfNeeded(w.ctx, "DSM Connect");
    expect(w.log).not.toContain("goto-while-away");
  });
  it("TC-D012-09 polling is never faster than 500 ms, even when asked for less", async () => {
    const w = world({ initial: "reconnect", away: AWAY });
    await connectIfNeeded(w.ctx, "DSM Connect");
    sleeps = [];
    clock = 0;
    const page = { url: () => (clock < 3000 ? "https://dsm.trentt.me/login" : CLAUDE) };
    const trip = await awaitSignInRoundTrip(page, { pollMs: 10 });
    expect(trip.left).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(500);
  });
  it("TC-D012-10 a tab that never comes back is given up after 120 s and reported as not returned", async () => {
    const page = { url: () => (clock < 1000 ? CLAUDE : "https://dsm.trentt.me/login?x=1") };
    const trip = await awaitSignInRoundTrip(page);
    expect(trip.left).toBe(true);
    expect(trip.returned).toBe(false);
    expect(trip.waitedMs).toBeGreaterThanOrEqual(120000);
    expect(trip.waitedMs).toBeLessThan(123000);
  });
  it("TC-D012-11 a press after which the tab never leaves claude.ai ends after 15 s as a press without a round trip", async () => {
    const page = { url: () => CLAUDE };
    const trip = await awaitSignInRoundTrip(page);
    expect(trip.left).toBe(false);
    expect(trip.waitedMs).toBeGreaterThanOrEqual(15000);
    expect(trip.waitedMs).toBeLessThan(17000);
  });
  it("TC-D012-12 a row still not Connected after the press is an error that names the Reconnect press", async () => {
    const w = world({ initial: "reconnect", away: AWAY, connectsAfterReturn: false });
    const r = await claudeAdapter().add(w.ctx, dsm, "skip");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("still not Connected");
    expect(r.detail).toContain("Reconnect");
  });
  it("TC-D012-13 a tab that stayed away is reported with origin and path only, never a query string, plus the seconds waited", async () => {
    const w = world({ initial: "reconnect", away: { fromMs: 2000, untilMs: null, url: AWAY.url } });
    const r = await claudeAdapter().add(w.ctx, dsm, "skip");
    expect(r.status).toBe("error");
    expect(r.detail).toContain("https://dsm.trentt.me/login");
    expect(r.detail).toMatch(/12\d s|120 s/);
    expect(r.detail).not.toContain("SECRET123");
    expect(r.detail).not.toContain("txn=");
  });
  it("TC-D012-14 the add path calls the same press-and-wait as the repair path", () => {
    const src = readFileSync("src/adapters/claude.ts", "utf8");
    const addBody = src.slice(src.indexOf("async add("), src.indexOf("async update("));
    expect((addBody.match(/connectIfNeeded\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(addBody).toContain("doAdd(");
  });
  it("TC-D012-15 the press is one native click on the matching button of the matching row and nothing is typed", async () => {
    const w = world({ initial: "reconnect", away: AWAY });
    await connectIfNeeded(w.ctx, "DSM Connect");
    expect(w.clicks()).toEqual(["click:2:Reconnect"]);
  });
  it("TC-D012-16 no query string and no secret reaches the result of a repair", async () => {
    const w = world({ initial: "reconnect", away: { fromMs: 2000, untilMs: null, url: AWAY.url } });
    const r = await claudeAdapter().add(w.ctx, dsm, "skip");
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("?txn");
  });
});
