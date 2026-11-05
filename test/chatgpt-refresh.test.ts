import { describe, it, expect } from "vitest";
import type { Page } from "patchright";
import { refreshPluginUI, type RefreshSelectors } from "../src/adapters/chatgptRefresh.js";

const config: RefreshSelectors = {
  directButton: "^refresh$",
  menuButton: "^more actions$",
  menuItem: "^refresh$",
  confirmation: "plugin refreshed",
};
interface Options {
  url?: string;
  name?: string;
  direct?: number;
  menu?: number;
  menuRefresh?: number;
  dialog?: string;
  previousNotice?: string;
  afterNotice?: string;
}
function fixture(opts: Options = {}) {
  const clicks: string[] = [];
  let clicked = false;
  const loc = (kind: string, count: number) => ({
    count: async () => count,
    click: async () => { clicks.push(kind); clicked = true; },
  });
  const scope = {
    innerText: async () => "Section\n" + (opts.name ?? "Patchright MCP") + "\nConnected",
    getByRole: (role: string, options: { name: RegExp }) => {
      if (role !== "button") return loc("unexpected", 0);
      if (options.name.test("Refresh")) return loc("refresh", opts.direct ?? 1);
      if (options.name.test("More actions")) return loc("menu", opts.menu ?? 0);
      return loc("other", 0);
    },
  };
  const dialogLocator = {
    count: async () => opts.dialog ? 1 : 0,
    last: () => ({ innerText: async () => opts.dialog ?? "" }),
    or: (_: unknown) => dialogLocator,
  };
  const page = {
    url: () => opts.url ?? "https://chatgpt.com/plugins/fixture-id",
    locator: (sel: string) => {
      if (sel === "main") return scope;
      if (sel.includes("role=")) return {
        allTextContents: async () => [clicked ? (opts.afterNotice ?? "") : (opts.previousNotice ?? "")],
      };
      throw Error("Unexpected selector");
    },
    getByRole: (role: string, options?: { name: RegExp }) => {
      if (role === "dialog" || role === "alertdialog") return dialogLocator;
      if (role === "menuitem" && options?.name.test("Refresh")) return loc("menuitem", opts.menuRefresh ?? 0);
      return loc("other", 0);
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  return { page, clicks };
}
describe("ChatGPT plugin native Refresh issue 83", () => {
  it("clicks only exact Refresh and requires new UI evidence", async () => {
    const { page, clicks } = fixture({ afterNotice: "Plugin refreshed" });
    const r = await refreshPluginUI(page, "Patchright MCP", config, { attempts: 1 });
    expect(clicks).toEqual(["refresh"]);
    expect(r).toEqual({ clicked: true, uiConfirmed: true, reviewRequired: false, evidence: "ui-confirmed" });
  });
  it("does not claim success from an old notice", async () => {
    const { page } = fixture({ previousNotice: "Plugin refreshed", afterNotice: "Plugin refreshed" });
    const r = await refreshPluginUI(page, "Patchright MCP", config, { attempts: 1 });
    expect(r).toMatchObject({ clicked: true, uiConfirmed: false, evidence: "no-readback" });
  });
  it("refuses the wrong plugin", async () => {
    const { page, clicks } = fixture({ name: "Another Plugin" });
    await expect(refreshPluginUI(page, "Patchright MCP", config)).rejects.toThrow("does not name");
    expect(clicks).toEqual([]);
  });
  it("refuses a different host", async () => {
    const { page, clicks } = fixture({ url: "https://example.com/plugins/fixture-id" });
    await expect(refreshPluginUI(page, "Patchright MCP", config)).rejects.toThrow("outside");
    expect(clicks).toEqual([]);
  });
  it("rejects ambiguous buttons", async () => {
    const { page, clicks } = fixture({ direct: 2 });
    await expect(refreshPluginUI(page, "Patchright MCP", config)).rejects.toThrow("Ambiguous");
    expect(clicks).toEqual([]);
  });
  it("uses only Manage > Refresh then stops at a review dialog", async () => {
    const { page, clicks } = fixture({ direct: 0, menu: 1, menuRefresh: 1, dialog: "Review updates to Patchright MCP before refreshing tools" });
    const r = await refreshPluginUI(page, "Patchright MCP", config, { attempts: 1 });
    expect(clicks).toEqual(["menu", "menuitem"]);
    expect(r).toMatchObject({ clicked: true, uiConfirmed: false, reviewRequired: true });
  });
  it("never clicks unrelated actions when Refresh is missing", async () => {
    const { page, clicks } = fixture({ direct: 0, menu: 0 });
    await expect(refreshPluginUI(page, "Patchright MCP", config)).rejects.toThrow("not found");
    expect(clicks).toEqual([]);
  });
  it("does not approve unexpected dialogs", async () => {
    const { page, clicks } = fixture({ dialog: "Delete this plugin?" });
    await expect(refreshPluginUI(page, "Patchright MCP", config)).rejects.toThrow("Unexpected confirmation");
    expect(clicks).toEqual(["refresh"]);
  });
});
