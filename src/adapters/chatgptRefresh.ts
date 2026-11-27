import type { Page } from "patchright";

export interface RefreshLabels {
  directButton: string;
  menuButton: string;
  menuItem: string;
  verified?: boolean;
}

/**
 * Refreshes metadata only when the current plugin page exposes EXACTLY one
 * visible control named Refresh. No Delete, Remove, Reinstall or OAuth controls
 * are touched. UI labels are injected from data/selectors/chatgpt.json.
 *
 * Refs issue #83.
 */
export async function requestChatgptRefresh(page: Pick<Page, "getByRole">, labels: RefreshLabels): Promise<"direct" | "menu"> {
  if (labels.verified !== true) throw new Error("Refresh UI selectors are not yet verified against a live authenticated ChatGPT plugin details page; no action taken");
  const direct = page.getByRole("button", { name: new RegExp(labels.directButton, "i"), exact: true });
  const directCount = await direct.count();
  if (directCount > 1) throw new Error("Multiple Refresh buttons: refusing ambiguous metadata update");
  if (directCount === 1) { await direct.click(); return "direct"; }

  const menu = page.getByRole("button", { name: new RegExp(labels.menuButton, "i"), exact: true });
  const menuCount = await menu.count();
  if (menuCount !== 1) throw new Error("Cannot identify one Manage menu: no metadata update attempted");
  await menu.click();

  const item = page.getByRole("menuitem", { name: new RegExp(labels.menuItem, "i"), exact: true });
  const itemCount = await item.count();
  if (itemCount !== 1) throw new Error("Cannot identify one Refresh menu item: no metadata update attempted");
  await item.click();
  return "menu";
}
