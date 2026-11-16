// @reqs REQ-D013
// ChatGPT: the Installed section of /plugins shows 12 plugins and a link "11 more" (found live 15 Nov 2026, page notes pages 6 to 9);
// the full list is on /settings/plugins-settings, and a plugin's id is the same on both pages.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chatgptAdapter, openPluginPage, parseInstalledSection, parseSettingsEntries, pluginIdFromHref, timing } from "../src/adapters/chatgpt.js";
import type { AdapterContext, ResolvedConnector } from "../src/adapters/types.js";

const sel = JSON.parse(readFileSync("data/selectors/chatgpt.json", "utf8"));
let clock = 0;
const realTiming = { ...timing };
beforeEach(() => { clock = 0; timing.sleep = async (ms: number) => { clock += ms; }; });
afterEach(() => { timing.sleep = realTiming.sleep; });

const ID = (n: string) => "plugin_asdk_app_" + n;
const VISIBLE = ["HELM Thread Monitor", "roku-mcp", "HELM Relay", "Fleet Connect", "HELM Shell", "DSM Connect"];
const ALL = [...VISIBLE, "Connector Connector", "HELM Drive MCP Connector", "Patchright MCP", "Vault MCP"];
const entryFor = (name: string) => ({ text: name + "\nA description line", href: "/settings/plugins-settings/" + ID(name.toLowerCase().replace(/[^a-z0-9]/g, "")) });

interface Opts { section: string[]; settings?: Array<{ text: string; href: string | null }> | (() => Array<{ text: string; href: string | null }>); titleOk?: boolean }
function world(o: Opts) {
  const log: string[] = [];
  let settingsReads = 0;
  const settingsNow = () => (typeof o.settings === "function" ? o.settings() : o.settings ?? []);
  const page = {
    goto: async (u: string) => { log.push("goto:" + u); },
    evaluate: async (fn: (...a: never[]) => unknown, arg?: unknown) => {
      log.push("evaluate");
      if (String(fn).includes("1200")) return "welcome";
      if (arg === "Installed") return o.section;
      return ["Connected"]; // the plugin page's main lines
    },
    waitForFunction: async (fn: unknown, arg?: unknown) => { log.push("waitForFunction"); if (o.titleOk === false && typeof arg === "string" && arg !== "Installed") throw new Error("timeout"); return true; },
    waitForURL: async () => { log.push("waitForURL"); },
    $$eval: async (selector: string) => { settingsReads++; log.push("$$eval:" + selector); return settingsNow(); },
    locator: (_s: string, opt?: { hasText?: RegExp }) => ({
      count: async () => (opt?.hasText && VISIBLE_OF(o).some((n) => opt.hasText!.test(n)) ? 1 : 0),
      first: () => ({ click: async () => { log.push("click:section-link"); } }),
    }),
  };
  const ctx: AdapterContext = { platform: "chatgpt", redact: (x) => x, session: async () => ({ page, context: {} }) as never };
  return { ctx, log, settingsReads: () => settingsReads, page };
}
const VISIBLE_OF = (o: Opts) => o.section.filter((n) => !/^\d+ more/.test(n));
const MORE = "11 more";
const settingsAll = () => ALL.map(entryFor);
const rc = (name: string): ResolvedConnector => ({ def: { id: "x", name, auth: { mode: "none" }, platforms: ["chatgpt"] } as never, name, url: "https://x.example/mcp" });

describe("REQ-D013 ChatGPT reads every installed plugin", () => {
  it("TC-D013-01 a section without an N more link gives its names as they are", () => {
    expect(parseInstalledSection(["HELM Shell", "DSM Connect"])).toEqual({ names: ["HELM Shell", "DSM Connect"], more: false });
  });
  it("TC-D013-02 without an N more link the settings page is never loaded", async () => {
    const w = world({ section: VISIBLE, settings: settingsAll() });
    const r = await chatgptAdapter().list(w.ctx);
    expect(r.names).toEqual(VISIBLE);
    expect(w.log.some((l) => l.includes("plugins-settings"))).toBe(false);
  });
  it("TC-D013-03 with an N more link the list holds every plugin of the settings page, each once, in page order", async () => {
    const w = world({ section: [...VISIBLE, MORE], settings: [...settingsAll(), entryFor("Vault MCP")] });
    const r = await chatgptAdapter().list(w.ctx);
    expect(r.names).toEqual(ALL);
    expect(r.names).toContain("Vault MCP");
  });
  it("TC-D013-04 a name in the section that the settings page lacks is added, and the more link is never a name", async () => {
    const w = world({ section: [...VISIBLE, "Legacy Only In Section", MORE], settings: settingsAll() });
    const r = await chatgptAdapter().list(w.ctx);
    expect(r.names).toContain("Legacy Only In Section");
    expect(r.names).not.toContain(MORE);
    expect(r.names.filter((n) => n === "DSM Connect")).toHaveLength(1);
  });
  it("TC-D013-05 entries that appear progressively are waited for until the count is stable", async () => {
    let call = 0;
    const w = world({ section: [...VISIBLE, MORE], settings: () => (++call === 1 ? settingsAll().slice(0, 3) : settingsAll()) });
    const r = await chatgptAdapter().list(w.ctx);
    expect(r.names).toEqual(ALL);
    expect(w.settingsReads()).toBeGreaterThanOrEqual(4);
  });
  it("TC-D013-06 a settings page that never shows entries is an error, not an empty or partial list", async () => {
    const w = world({ section: [...VISIBLE, MORE], settings: [] });
    await expect(chatgptAdapter().list(w.ctx)).rejects.toThrow(/did not finish loading|partial list/);
  });
  it("TC-D013-07 the id of an entry link is read from its path only, for both page kinds", () => {
    expect(pluginIdFromHref("/settings/plugins-settings/plugin_asdk_app_6abf4d0e")).toBe("plugin_asdk_app_6abf4d0e");
    expect(pluginIdFromHref("/plugins/plugin_connector_1p_1a69035c?x=1")).toBe("plugin_connector_1p_1a69035c");
    expect(parseSettingsEntries([{ text: "Vault MCP\nDesc", href: "/settings/plugins-settings/plugin_a_1" }, { text: "Vault MCP\nDesc", href: "/settings/plugins-settings/plugin_a_1" }])).toEqual([{ name: "Vault MCP", id: "plugin_a_1" }]);
  });
  it("TC-D013-08 addresses that are not a plugin id are never accepted", () => {
    for (const h of [null, undefined, "", "/plugins/other", "/plugins/plugin_x/../../evil", "https://evil.example/plugins/plugin_x", "/plugins/PLUGIN_X", "/settings/plugins-settings", "/plugins/plugin_x#frag/../a"]) expect(pluginIdFromHref(h as never), String(h)).toBeUndefined();
  });
  it("TC-D013-09 a plugin that is not in the section is opened at its own id address", async () => {
    const w = world({ section: [...VISIBLE, MORE], settings: settingsAll() });
    await openPluginPage(w.ctx, "Vault MCP");
    const want = sel.list.pluginUrlBase + entryFor("Vault MCP").href.split("/").pop();
    expect(w.log).toContain("goto:" + want);
    expect(w.log).not.toContain("click:section-link");
    const bad = world({ section: [...VISIBLE, MORE], settings: settingsAll(), titleOk: false });
    await expect(openPluginPage(bad.ctx, "Vault MCP")).rejects.toThrow(/never showed/);
  });
  it("TC-D013-10 add skip of a plugin behind the more link makes no create attempt and reports it Connected", async () => {
    const w = world({ section: [...VISIBLE, MORE], settings: settingsAll() });
    const r = await chatgptAdapter().add(w.ctx, rc("Vault MCP"), "skip");
    expect(r.status).toBe("skipped");
    expect(r.detail).toContain("already installed and Connected");
    expect(w.log.some((l) => l.startsWith("click:") && l !== "click:section-link")).toBe(false);
  });
  it("TC-D013-11 the link text, addresses and selector are data in data/selectors/chatgpt.json", () => {
    expect(new RegExp(sel.list.moreLinkText, "i").test("11 more")).toBe(true);
    expect(new RegExp(sel.list.moreLinkText, "i").test("Install more apps")).toBe(false);
    expect(sel.list.settingsUrl).toContain("/settings/plugins-settings");
    expect(sel.list.entryLink).toContain("plugins-settings");
    expect(sel.list.pluginUrlBase).toMatch(/\/plugins\/$/);
    const src = readFileSync("src/adapters/chatgpt.ts", "utf8");
    expect(src).not.toContain("plugins-settings");
  });
  it("TC-D013-12 reading the settings page clicks nothing and reads only the entry links", async () => {
    const w = world({ section: [...VISIBLE, MORE], settings: settingsAll() });
    await chatgptAdapter().list(w.ctx);
    const i = w.log.indexOf("goto:" + sel.list.settingsUrl);
    expect(i).toBeGreaterThanOrEqual(0);
    const after = w.log.slice(i + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((l) => l === "$$eval:" + sel.list.entryLink)).toBe(true);
  });
});
