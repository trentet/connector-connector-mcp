import { describe, expect, it, vi } from "vitest";
import { requestChatgptRefresh } from "../src/adapters/chatgptRefresh.js";

const labels = { directButton: "^Refresh$", menuButton: "^(Manage|More actions)$", menuItem: "^Refresh$", verified: true };
type FakeRole = "button" | "menuitem";
function fakeControls(counts: Record<string, number>) {
  const clicks: string[] = [];
  const page = {
    getByRole(role: FakeRole, opts: { name: RegExp }) {
      const key = role + ":" + opts.name.source;
      return {
        count: async () => counts[key] ?? 0,
        click: async () => { clicks.push(key); }
      };
    }
  };
  return { page: page as never, clicks };
}

describe("ChatGPT metadata refresh action #83", () => {
  it("refuses unverified selector data before opening a menu or clicking a control", async () => {
    const x=fakeControls({ "button:^Refresh$": 1 });
    await expect(requestChatgptRefresh(x.page, { ...labels, verified: false })).rejects.toThrow(/not yet verified/);
    expect(x.clicks).toEqual([]);
  });
  it("clicks a unique direct Refresh without opening any other menu", async () => {
    const x=fakeControls({ "button:^Refresh$": 1 });
    expect(await requestChatgptRefresh(x.page, labels)).toBe("direct");
    expect(x.clicks).toEqual(["button:^Refresh$"]);
  });
  it("opens only the named Manage menu and its one Refresh item", async () => {
    const x=fakeControls({ "button:^(Manage|More actions)$": 1, "menuitem:^Refresh$": 1 });
    expect(await requestChatgptRefresh(x.page, labels)).toBe("menu");
    expect(x.clicks).toEqual(["button:^(Manage|More actions)$", "menuitem:^Refresh$"]);
  });
  it("refuses missing or ambiguous actions without risky clicks", async () => {
    for(const counts of [{}, { "button:^Refresh$":2 }, { "button:^(Manage|More actions)$": 2 }]) {
      const x=fakeControls(counts);
      await expect(requestChatgptRefresh(x.page, labels)).rejects.toThrow();
      expect(x.clicks).toEqual([]);
    }
  });
  it("opens a menu but refuses a missing Refresh item without deleting anything", async () => {
    const x=fakeControls({ "button:^(Manage|More actions)$": 1, "menuitem:^Refresh$": 0 });
    await expect(requestChatgptRefresh(x.page, labels)).rejects.toThrow(/Refresh menu item/);
    expect(x.clicks).toEqual(["button:^(Manage|More actions)$"]);
  });
});
