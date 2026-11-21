// @reqs REQ-D017
// Grok's connectors page as read live on 21 Nov 2026 (account ulostthegamers): status word "Connected", an avatar letter before
// the name, a few custom rows in the dialog, an "18 connected" chip that opens "Manage apps" (six rows) with an offer-all button,
// and a detail view per connector: name, Custom, Disconnect, the tools line, one button per tool, an expand button, the server URL.
// TC-D017-01..09 carry the 9 tests of pull request 100 (same intent, renumbered).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Loaded at run time so that each test fails on its own while the module does not exist yet (spec-first, REQ-D017).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const m: any = await import("../src/adapters/grokConnectedList.js").catch(() => ({}));

const sel = JSON.parse(readFileSync("data/selectors/grok.json", "utf8"));
let realSleep: unknown;
let slept: number[] = [];
beforeEach(() => { slept = []; if (m.timing) { realSleep = m.timing.sleep; m.timing.sleep = async (ms: number) => { slept.push(ms); }; } });
afterEach(() => { if (m.timing) m.timing.sleep = realSleep; delete (globalThis as { document?: unknown }).document; });

type RawRow = { own: string[]; wrap: string[] };
const row = (i: number, status: "Connected" | "Connect" = "Connected"): RawRow => ({ own: ["A", `App ${i}`, "Use this connector in chats."], wrap: ["A", `App ${i}`, "Use this connector in chats.", status] });
const rows = (n: number) => Array.from({ length: n }, (_v, i) => row(i + 1));
const SECRET_URL = "https://secret.example.test/mcp?token=NOT-A-REAL-TOKEN";
const TOOLS = ["boot_status", "change_report", "system_brief", "writing_sweep"];
const NAV = ["Settings", "Account", "Connect Apps", "Manage"];
const detailLines = (name: string, tools = TOOLS, more: "See more" | "See less" | null = "See more") => [
  ...NAV, name, name.slice(0, 1).toUpperCase(), name, "Custom", "Disconnect", "All tools enabled", ...tools,
  ...(more ? [more] : []), "Server URL", SECRET_URL, "Third-party connectors are not built or maintained by xAI.",
];

type View = "home" | "manage" | "all" | "detail";
interface WorldOpts {
  view: View; total: number; showAll?: boolean; names?: string[]; seeMore?: boolean;
  rowsFor?: (view: View, reads: number) => RawRow[];
  detailFor?: (reads: number, name: string) => string[];
  openable?: boolean;
}
/** A stand-in page: records every press; evaluate runs the named in-page function's job against the fake view. */
function world(o: WorldOpts) {
  const log: string[] = [];
  let view = o.view, reads = 0, detailReads = 0, opened = "";
  const named = (o.names ?? []).map((n): RawRow => ({ own: ["H", n, "Use this connector in chats."], wrap: ["H", n, "Use this connector in chats.", "Connected"] }));
  const allRows = () => [...named, ...rows(o.total - named.length)];
  const rowsFor = o.rowsFor ?? ((v: View) => (v === "home" ? [...allRows().slice(0, 5), row(90, "Connect")] : v === "manage" ? allRows().slice(0, 6) : allRows()));
  const chipHere = () => view === "home";
  const allHere = () => o.showAll !== false && view === "manage";
  const page = {
    locator: (_s: string) => ({
      filter: (f: { hasText: RegExp }) => ({
        first: () => ({
          count: async () => (chipHere() && f.hasText.test(`H H R ${o.total} connected`) ? 1 : 0),
          innerText: async () => `H\nH\nR\n${o.total} connected`,
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
    evaluate: async (fn: unknown, arg?: unknown) => {
      if (fn === m.pageRows) { reads++; return rowsFor(view, reads); }
      if (fn === m.pageOpenRow) {
        const name = String(arg);
        if (o.openable === false || !allRows().some((r) => r.own[1] === name)) return false;
        log.push(`open:${name}`); opened = name; view = "detail"; return true;
      }
      if (fn === m.pageDetailLines) {
        detailReads++;
        if (view !== "detail") return [...NAV, "Installed"];
        return (o.detailFor ?? ((_r: number, n: string) => detailLines(n)))(detailReads, opened);
      }
      if (fn === m.pagePressButton) {
        const pattern = new RegExp(String(arg), "i");
        if (o.seeMore !== false && view === "detail" && pattern.test("See more")) { log.push("press:see-more"); return true; }
        if (pattern.test("Disconnect") || pattern.test("system_brief") || pattern.test("Manage")) log.push(`press:FORBIDDEN:${String(arg)}`);
        return false;
      }
      throw new Error("unexpected evaluate");
    },
  };
  return { page: page as never, log };
}

/** A stand-in DOM for the in-page functions (they run inside the browser in production). */
interface FakeEl { innerText: string; offsetWidth: number; parentElement: FakeEl | null; kids: FakeEl[]; tag: string; role?: string; clicked: number; click(): void; querySelectorAll(s: string): FakeEl[] }
function el(tag: string, innerText: string, kids: FakeEl[] = [], o: { role?: string; hidden?: boolean } = {}): FakeEl {
  const e: FakeEl = {
    innerText, offsetWidth: o.hidden ? 0 : 10, parentElement: null, kids, tag, role: o.role, clicked: 0,
    click() { e.clicked++; },
    querySelectorAll(s: string) { return descendants(e).filter((d) => matches(d, s)); },
  };
  for (const k of kids) k.parentElement = e;
  return e;
}
function descendants(e: FakeEl): FakeEl[] { return e.kids.flatMap((k) => [k, ...descendants(k)]); }
function matches(e: FakeEl, s: string): boolean {
  if (s === "button") return e.tag === "button";
  if (s === "[role=dialog]") return e.role === "dialog";
  if (s === "[role=dialog] button") { if (e.tag !== "button") return false; for (let p = e.parentElement; p; p = p.parentElement) if (p.role === "dialog") return true; return false; }
  throw new Error(`selector ${s} not in the stand-in DOM`);
}
function installDocument(root: FakeEl) {
  (globalThis as { document?: unknown }).document = { querySelectorAll: (s: string) => [root, ...descendants(root)].filter((d) => matches(d, s)) };
}

describe("REQ-D017 Grok connected list and connector detail", () => {
  it("TC-D017-01 the name is the first line, or the second after a one-character avatar letter", () => {
    expect(m.rowName(["H", "helm-secret", "Use this connector in chats."])).toBe("helm-secret");
    expect(m.rowName(["GitHub", "Look up code, issues, and pull requests."])).toBe("GitHub");
    expect(m.rowName(["HELMMCP", "Use this connector in chats."])).toBe("HELMMCP");
    expect(m.rowName(["X"])).toBe("X");
    expect(m.rowName([])).toBeUndefined();
  });
  it("TC-D017-02 only rows whose wrapper says Connected are names; rows that say Connect are not", () => {
    expect(m.namesFromRows([row(1), row(2, "Connect"), row(3)], sel.list.rowMarkerText)).toEqual(["App 1", "App 3"]);
    expect(m.namesFromRows([{ own: ["Notion", "Search your pages."], wrap: ["Notion", "Search your pages.", "Connect"] }], sel.list.rowMarkerText)).toEqual([]);
    expect(m.namesFromRows([row(1), row(1)], sel.list.rowMarkerText)).toEqual(["App 1"]);
    expect(m.namesFromRows([{ own: [], wrap: ["Connected"] }], sel.list.rowMarkerText)).toEqual([]);
  });
  it("TC-D017-03 the number is read from the chip text or from the Show all text", () => {
    expect(m.parseConnectedCount("18 connected")).toBe(18);
    expect(m.parseConnectedCount("H\nH\nR\n18 connected")).toBe(18);
    expect(m.parseConnectedCount("Show all 18 apps")).toBe(18);
    expect(m.parseConnectedCount("")).toBeUndefined();
    expect(m.parseConnectedCount(null)).toBeUndefined();
    expect(m.parseConnectedCount(undefined)).toBeUndefined();
  });
  it("TC-D017-04 from the first view cc presses the chip then Show all, once each, and reads every connected app", async () => {
    const w = world({ view: "home", total: 18 });
    const names = await m.revealAndReadConnected(w.page, sel);
    expect(names).toHaveLength(18);
    expect(w.log).toEqual(["click:chip", "click:showall"]);
  });
  it("TC-D017-05 already in the Manage view cc presses only Show all", async () => {
    const w = world({ view: "manage", total: 18 });
    expect(await m.revealAndReadConnected(w.page, sel)).toHaveLength(18);
    expect(w.log).toEqual(["click:showall"]);
  });
  it("TC-D017-06 with neither the chip nor Show all on the page cc presses nothing", async () => {
    const w = world({ view: "manage", total: 4, showAll: false });
    expect(await m.revealAndReadConnected(w.page, sel)).toHaveLength(4);
    expect(w.log).toEqual([]);
  });
  it("TC-D017-07 rows that load progressively are waited for until the count is stable and at least N", async () => {
    const w = world({ view: "manage", total: 18, rowsFor: (_v, reads) => rows(reads <= 3 ? 8 : 18) });
    expect(await m.revealAndReadConnected(w.page, sel)).toHaveLength(18);
  });
  it("TC-D017-08 a list that stays below N is an error, never a partial list", async () => {
    const w = world({ view: "manage", total: 18, rowsFor: () => rows(17) });
    await expect(m.revealAndReadConnected(w.page, sel)).rejects.toThrow(/partial or empty list/);
    await expect(m.revealAndReadConnected(world({ view: "manage", total: 18, rowsFor: () => rows(17) }).page, sel)).rejects.toThrow(/18 announced/);
  });
  it("TC-D017-09 the marker, the button patterns and the detail patterns are data in data/selectors/grok.json", () => {
    expect(sel.list.rowMarkerText).toBe("Connected");
    expect(new RegExp(sel.list.connectedChip, "i").test("18 connected")).toBe(true);
    expect(new RegExp(sel.list.showAll, "i").test("Show all 18 apps")).toBe(true);
    expect(new RegExp(sel.list.showAll, "i").test("Show all")).toBe(false);
    expect(new RegExp(sel.detail.toolsLine, "i").test("All tools enabled")).toBe(true);
    expect(new RegExp(sel.detail.toolsLine, "i").test("57 of 58 tools enabled")).toBe(true);
    expect(new RegExp(sel.detail.seeMore, "i").test("See more")).toBe(true);
    expect(new RegExp(sel.detail.seeMore, "i").test("See less")).toBe(false);
    expect(new RegExp(sel.detail.toolsEnd, "i").test("See less")).toBe(true);
    expect(new RegExp(sel.detail.toolName, "i").test("system_brief")).toBe(true);
    expect(new RegExp(sel.detail.toolName, "i").test("Third-party connectors are not built")).toBe(false);
    for (const f of ["src/adapters/grokConnectedList.ts", "src/adapters/grok.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/show all|see more|see less|tools enabled|"Added"/i);
    }
  });
  it("TC-D017-10 an empty page is an error, never an empty list, and polling is 500 ms within 30 s", async () => {
    const w = world({ view: "manage", total: 0, showAll: false, rowsFor: () => [] });
    await expect(m.revealAndReadConnected(w.page, sel)).rejects.toThrow(/0 rows seen/);
    expect(new Set(slept)).toEqual(new Set([500]));
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30000);
  });
  it("TC-D017-11 toolsFromDetail returns the tool names between the tools line and See more", () => {
    expect(m.toolsFromDetail(detailLines("helm-secret"), "helm-secret", sel)).toEqual(TOOLS);
  });
  it("TC-D017-12 the tool list also ends at See less or at the end of the dialog and keeps only tool-name lines", () => {
    expect(m.toolsFromDetail(detailLines("helm-secret", TOOLS, "See less"), "helm-secret", sel)).toEqual(TOOLS);
    const noMore = [...NAV, "helm-secret", "Custom", "Disconnect", "All tools enabled", "boot_status", "system_brief", "boot_status", "Third-party connectors are not built or maintained by xAI."];
    expect(m.toolsFromDetail(noMore, "helm-secret", sel)).toEqual(["boot_status", "system_brief"]);
  });
  it("TC-D017-13 toolsFromDetail refuses a detail that is not this connector's (no name, no Disconnect or no tools line)", () => {
    expect(() => m.toolsFromDetail(detailLines("HELM Relay"), "helm-secret", sel)).toThrow(/detail of "helm-secret" is not open/);
    expect(() => m.toolsFromDetail(detailLines("helm-secret").filter((l: string) => l !== "Disconnect"), "helm-secret", sel)).toThrow(/not open/);
    expect(() => m.toolsFromDetail(detailLines("helm-secret").filter((l: string) => l !== "All tools enabled"), "helm-secret", sel)).toThrow(/not open/);
    expect(() => m.toolsFromDetail([...NAV, "Installed", "helm-secret", "Connected"], "helm-secret", sel)).toThrow(/not open/);
    expect(() => m.toolsFromDetail(["All tools enabled", "helm-secret", "Disconnect", "boot_status"], "helm-secret", sel)).toThrow(/not open/);
  });
  it("TC-D017-14 verify of a connected connector names the apps read, the tool count and every tool, system_brief among them", async () => {
    const w = world({ view: "home", total: 18, names: ["helm-secret"] });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("ok");
    expect(out.detail).toBe(`"helm-secret" is in grok.com's Connected list (18 connected apps read); Grok lists 4 tools for it: ${TOOLS.join(", ")}`);
    expect(out.detail).toContain("system_brief");
  });
  it("TC-D017-15 verify of a name that is not in the list is an error and opens no row", async () => {
    const w = world({ view: "home", total: 18 });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out).toEqual({ status: "error", detail: `"helm-secret" is not in grok.com's Connected list (18 connected apps read)` });
    expect(w.log.some((l) => l.startsWith("open:"))).toBe(false);
  });
  it("TC-D017-16 verify presses only the row and See more once; never a tool, a toggle, Disconnect or Manage", async () => {
    const w = world({ view: "home", total: 18, names: ["helm-secret"] });
    await m.verifyConnected(w.page, "helm-secret", sel);
    expect(w.log).toEqual(["click:chip", "click:showall", "open:helm-secret", "press:see-more"]);
    expect(w.log.join(" ")).not.toMatch(/FORBIDDEN/);
  });
  it("TC-D017-17 without a See more button verify presses only the row", async () => {
    const w = world({ view: "all", total: 18, names: ["helm-secret"], seeMore: false, detailFor: (_r, n) => detailLines(n, TOOLS, null) });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("ok");
    expect(w.log).toEqual(["open:helm-secret"]);
  });
  it("TC-D017-18 a row that is not found is an error, never an ok", async () => {
    const w = world({ view: "all", total: 18, names: ["helm-secret"], openable: false });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("error");
    expect(out.detail).toMatch(/no row named "helm-secret"/);
    await expect(m.readDetailTools(w.page, "helm-secret", sel)).rejects.toThrow(/no row named/);
  });
  it("TC-D017-19 a detail that never shows the tools line within 10 s is an error naming the connector", async () => {
    const w = world({ view: "all", total: 18, names: ["helm-secret"], detailFor: (_r, n) => detailLines(n).filter((l) => l !== "All tools enabled") });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("error");
    expect(out.detail).toMatch(/"helm-secret" is in grok.com's Connected list \(18 connected apps read\), but its tools could not be read: .*detail of "helm-secret" is not open.*10 s/);
    const detailWait = slept.slice(-21);
    expect(detailWait.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10500);
  });
  it("TC-D017-20 a detail that lists no tool is an error", async () => {
    const w = world({ view: "all", total: 18, names: ["helm-secret"], detailFor: (_r, n) => detailLines(n, []) });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("error");
    expect(out.detail).toMatch(/grok.com lists no tool for "helm-secret"/);
  });
  it("TC-D017-21 the tools are read until two reads agree", async () => {
    const seq = [["boot_status"], ["boot_status", "change_report"], TOOLS, TOOLS];
    const w = world({ view: "all", total: 18, names: ["helm-secret"], seeMore: false, detailFor: (r, n) => detailLines(n, seq[Math.min(r - 1, seq.length - 1)], null) });
    expect(await m.readDetailTools(w.page, "helm-secret", sel)).toEqual(TOOLS);
    const flicker = world({ view: "all", total: 18, names: ["helm-secret"], seeMore: false, detailFor: (r, n) => detailLines(n, r % 2 ? ["a_tool"] : ["b_tool"], null) });
    await expect(m.readDetailTools(flicker.page, "helm-secret", sel)).rejects.toThrow(/did not settle/);
  });
  it("TC-D017-22 the in-page detail reader drops every line that holds :// or token=", () => {
    installDocument(el("body", "", [
      el("div", "Old dialog\nhttps://old.example.test", [], { role: "dialog", hidden: true }),
      el("div", ["helm-secret", "Disconnect", "All tools enabled", "system_brief", "Server URL", SECRET_URL, "token=abc", "x?token=abc"].join("\n"), [], { role: "dialog" }),
    ]));
    const lines = m.pageDetailLines();
    expect(lines).toEqual(["helm-secret", "Disconnect", "All tools enabled", "system_brief", "Server URL"]);
    expect(lines.join("\n")).not.toMatch(/:\/\/|token=/);
    installDocument(el("body", "", []));
    expect(m.pageDetailLines()).toEqual([]);
  });
  it("TC-D017-23 no outcome carries a URL or a token even when the page shows one", async () => {
    const w = world({ view: "home", total: 18, names: ["helm-secret"], detailFor: (_r, n) => [...detailLines(n, [...TOOLS, SECRET_URL, "token=zzz"])] });
    const out = await m.verifyConnected(w.page, "helm-secret", sel);
    expect(out.status).toBe("ok");
    expect(out.detail).not.toMatch(/:\/\/|token=|NOT-A-REAL-TOKEN/);
    const bad = world({ view: "all", total: 18, names: ["helm-secret"], detailFor: () => [SECRET_URL] });
    expect((await m.verifyConnected(bad.page, "helm-secret", sel)).detail).not.toMatch(/:\/\/|token=/);
  });
  it("TC-D017-24 the in-page row reader returns each button's lines and the lines of its one-button wrapper", () => {
    const b1 = el("button", "H\nhelm-secret\nUse this connector in chats.");
    const b2 = el("button", "GitHub\nLook up code.");
    const b3 = el("button", "");
    const w1 = el("div", "H\nhelm-secret\nUse this connector in chats.\nConnected", [b1]);
    const w2 = el("div", "GitHub\nLook up code.\nConnected", [b2]);
    installDocument(el("div", "all", [w1, w2, b3]));
    expect(m.pageRows()).toEqual([
      { own: ["H", "helm-secret", "Use this connector in chats."], wrap: ["H", "helm-secret", "Use this connector in chats.", "Connected"] },
      { own: ["GitHub", "Look up code."], wrap: ["GitHub", "Look up code.", "Connected"] },
    ]);
  });
  it("TC-D017-25 the in-page row opener presses only the button whose name is exactly the connector's name", () => {
    const relayTest = el("button", "H\nHELM Relay TEST\nUse this connector in chats.");
    const relay = el("button", "H\nHELM Relay\nUse this connector in chats.");
    const hidden = el("button", "H\nHELM Relay\nUse this connector in chats.", [], { hidden: true });
    const outside = el("button", "HELM Relay");
    installDocument(el("body", "", [el("div", "", [hidden, relayTest, relay], { role: "dialog" }), outside]));
    expect(m.pageOpenRow("HELM Relay")).toBe(true);
    expect([relay.clicked, relayTest.clicked, hidden.clicked, outside.clicked]).toEqual([1, 0, 0, 0]);
    expect(m.pageOpenRow("helm-secret")).toBe(false);
  });
  it("TC-D017-26 the in-page See more presser presses only a matching button and reports false when there is none", () => {
    const more = el("button", "See more");
    const disc = el("button", "Disconnect");
    const tool = el("button", "system_brief");
    installDocument(el("body", "", [el("div", "", [disc, tool, more], { role: "dialog" })]));
    expect(m.pagePressButton(sel.detail.seeMore)).toBe(true);
    expect([more.clicked, disc.clicked, tool.clicked]).toEqual([1, 0, 0]);
    installDocument(el("body", "", [el("div", "", [disc, tool], { role: "dialog" })]));
    expect(m.pagePressButton(sel.detail.seeMore)).toBe(false);
    expect([disc.clicked, tool.clicked]).toEqual([0, 0]);
  });
  it("TC-D017-27 grok.ts reads list, verify, add, remove and update through grokConnectedList", () => {
    const src = readFileSync("src/adapters/grok.ts", "utf8");
    expect(src).toMatch(/from "\.\/grokConnectedList\.js"/);
    expect(src).toMatch(/return revealAndReadConnected\(await openConnectors\(ctx\), sel\)/);
    expect(src).toMatch(/verify\(ctx, c\)[^]*?return verifyConnected\(await openConnectors\(ctx\), c\.name, sel\)/);
    expect(src).not.toMatch(/sel\.list\.rowMarkerText/);
    for (const op of ["list", "remove", "update", "add"]) expect(src).toMatch(new RegExp(`async ${op}\\(ctx[^]*?readConnected\\(ctx\\)`));
  });
  it("TC-D017-28 the release is version 0.2.20", () => {
    expect(JSON.parse(readFileSync("package.json", "utf8")).version).toBe("0.2.20");
    expect(JSON.parse(readFileSync("package-lock.json", "utf8")).version).toBe("0.2.20");
  });
});
