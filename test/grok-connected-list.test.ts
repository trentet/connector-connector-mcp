// @reqs REQ-D014
// Grok's connectors page as found live on 15 Nov 2026 (page notes page 10): status word "Connected", an avatar letter before the name,
// five custom rows in the dialog, a "19 connected" chip that opens "Manage apps" (six rows) with a "Show all 19 apps" button.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { namesFromRows, parseConnectedCount, revealAndReadConnected, rowName, timing, type RawRow } from "../src/adapters/grok.js";

const sel = JSON.parse(readFileSync("data/selectors/grok.json", "utf8"));
const realSleep = timing.sleep;
beforeEach(() => { timing.sleep = async () => undefined; });
afterEach(() => { timing.sleep = realSleep; });

const row = (i: number, status: "Connected" | "Connect" = "Connected"): RawRow => ({ own: ["A", `App ${i}`, "Use this connector in chats."], wrap: ["A", `App ${i}`, "Use this connector in chats.", status] });
const rows = (n: number) => Array.from({ length: n }, (_v, i) => row(i + 1));

type View = "home" | "manage" | "all";
function world(o: { view: View; total: number; showAll?: boolean; rowsFor?: (view: View, reads: number) => RawRow[] }) {
  const log: string[] = [];
  let view = o.view, reads = 0;
  const chipHere = () => view === "home";
  const allHere = () => o.showAll !== false && view === "manage";
  const rowsFor = o.rowsFor ?? ((v: View) => (v === "home" ? [...rows(5), row(90, "Connect")] : v === "manage" ? rows(Math.min(6, o.total)) : rows(o.total)));
  const page = {
    locator: (_s: string) => ({
      filter: (f: { hasText: RegExp }) => ({
        first: () => ({
          count: async () => (chipHere() && f.hasText.test(`${o.total} connected`) ? 1 : 0),
          innerText: async () => `${o.total} connected`,
          click: async () => { log.push("click:chip"); view = "manage"; },
        }),
      }),
    }),
    getByRole: (_r: string, opt: { name: RegExp }) => ({
      first: () => ({
        count: async () => (allHere() && opt.name.test(`Show all ${o.total} apps`) ? 1 : 0),
        innerText: async () => `Show all ${o.total} apps`,
        click: async () => { log.push("click:showall"); view = "all"; },
      }),
    }),
    evaluate: async () => { reads++; return rowsFor(view, reads); },
  };
  return { page: page as never, log };
}

describe("REQ-D014 Grok connected list", () => {
  it("TC-D014-01 the name is the first line, or the second after a one-character avatar letter", () => {
    expect(rowName(["H", "helm-secret", "Use this connector in chats."])).toBe("helm-secret");
    expect(rowName(["GitHub", "Look up code, issues, and pull requests."])).toBe("GitHub");
    expect(rowName(["HELMMCP", "Use this connector in chats."])).toBe("HELMMCP");
    expect(rowName(["X"])).toBe("X");
    expect(rowName([])).toBeUndefined();
  });
  it("TC-D014-02 only rows whose wrapper says Connected are names; rows that say Connect are not", () => {
    expect(namesFromRows([row(1), row(2, "Connect"), row(3)], sel.list.rowMarkerText)).toEqual(["App 1", "App 3"]);
    expect(namesFromRows([{ own: ["Notion", "Search your pages."], wrap: ["Notion", "Search your pages.", "Connect"] }], sel.list.rowMarkerText)).toEqual([]);
  });
  it("TC-D014-03 the number is read from the chip text or from the Show all text", () => {
    expect(parseConnectedCount("19 connected")).toBe(19);
    expect(parseConnectedCount("Show all 19 apps")).toBe(19);
    expect(parseConnectedCount("")).toBeUndefined();
    expect(parseConnectedCount(null)).toBeUndefined();
  });
  it("TC-D014-04 from the first view cc presses the chip then Show all, once each, and reads every connected app", async () => {
    const w = world({ view: "home", total: 19 });
    const names = await revealAndReadConnected(w.page);
    expect(names).toHaveLength(19);
    expect(w.log).toEqual(["click:chip", "click:showall"]);
  });
  it("TC-D014-05 already in the Manage view cc presses only Show all", async () => {
    const w = world({ view: "manage", total: 19 });
    expect(await revealAndReadConnected(w.page)).toHaveLength(19);
    expect(w.log).toEqual(["click:showall"]);
  });
  it("TC-D014-06 with neither the chip nor Show all on the page cc presses nothing", async () => {
    const w = world({ view: "manage", total: 4, showAll: false });
    expect(await revealAndReadConnected(w.page)).toHaveLength(4);
    expect(w.log).toEqual([]);
  });
  it("TC-D014-07 rows that load progressively are waited for until the count is stable and at least N", async () => {
    const w = world({ view: "manage", total: 19, rowsFor: (_v, reads) => rows(reads <= 3 ? 8 : 19) });
    expect(await revealAndReadConnected(w.page)).toHaveLength(19);
  });
  it("TC-D014-08 a list that stays below N is an error, never a partial list", async () => {
    const w = world({ view: "manage", total: 19, rowsFor: () => rows(18) });
    await expect(revealAndReadConnected(w.page)).rejects.toThrow(/partial or empty list/);
  });
  it("TC-D014-09 the marker and the button patterns are data in data/selectors/grok.json", () => {
    expect(sel.list.rowMarkerText).toBe("Connected");
    expect(new RegExp(sel.list.connectedChip, "i").test("19 connected")).toBe(true);
    expect(new RegExp(sel.list.showAll, "i").test("Show all 19 apps")).toBe(true);
    expect(new RegExp(sel.list.showAll, "i").test("Show all")).toBe(false);
    const src = readFileSync("src/adapters/grok.ts", "utf8");
    expect(src).not.toMatch(/show all/i);
  });
});
