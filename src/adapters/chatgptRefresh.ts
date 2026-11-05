/**
 * Native ChatGPT plugin Refresh (cc issue #83). No connector-specific values,
 * credentials, API shortcuts, or login automation live here.
 *
 * The real ChatGPT UI must be observed before treating any selector as verified.
 * A click alone is never evidence that the frozen MCP schema was replaced.
 */
import type { Page } from "patchright";

export interface RefreshSelectors {
  directButton: string;
  menuButton: string;
  menuItem: string;
  confirmation: string;
}

export interface RefreshResult {
  clicked: boolean;
  uiConfirmed: boolean;
  reviewRequired: boolean;
  evidence: "ui-confirmed" | "review-required" | "no-readback";
}

export async function refreshPluginUI(
  page: Page,
  pluginName: string,
  config: RefreshSelectors,
  poll: { attempts?: number; waitMs?: number } = {},
): Promise<RefreshResult> {
  const u = new URL(page.url());
  if (u.hostname !== "chatgpt.com" || !/^\/plugins\/[^/]+\/?$/.test(u.pathname)) {
    throw new Error("Refusing Refresh outside ChatGPT's plugin detail page");
  }
  const main = page.locator("main");
  const lines = (await main.innerText()).split("\n").map((s) => s.trim());
  if (!lines.includes(pluginName)) {
    throw new Error("Refusing Refresh: opened plugin detail does not name the requested plugin");
  }

  // Capture existing status messages so a stale prior-success toast can never
  // be misread as evidence that this attempt refreshed anything.
  const noticeLocator = page.locator('[role="status"], [role="alert"], [aria-live]');
  const noticesBefore = await noticeLocator.allTextContents();

  // A live read-only UI survey is required to confirm the selector fields in
  // data/selectors/chatgpt.json. Prefer direct Refresh, then Manage > Refresh.
  const direct = main.getByRole("button", { name: new RegExp(config.directButton, "i") });
  const n = await direct.count();
  if (n > 1) throw new Error("Ambiguous Refresh buttons; refusing to guess");
  if (n === 1) {
    await direct.click();
  } else {
    const menu = main.getByRole("button", { name: new RegExp(config.menuButton, "i") });
    if ((await menu.count()) !== 1) throw new Error("Native Refresh control not found or Manage menu ambiguous");
    await menu.click();
    const action = page.getByRole("menuitem", { name: new RegExp(config.menuItem, "i") });
    if ((await action.count()) !== 1) throw new Error("Refresh menu item missing or ambiguous");
    await action.click();
  }

  // Never approve another page or generic confirmation button. A dialog may
  // require the operator to review a changed action list.
  const dialogs = page.getByRole("dialog").or(page.getByRole("alertdialog"));
  if (await dialogs.count()) {
    const dialogText = await dialogs.last().innerText();
    if (!dialogText.includes(pluginName) || !/refresh|update|review|action/i.test(dialogText)) {
      throw new Error("Unexpected confirmation dialog after Refresh; stopped");
    }
    return { clicked: true, uiConfirmed: false, reviewRequired: true, evidence: "review-required" };
  }

  const confirmed = new RegExp(config.confirmation, "i");
  for (let i = 0; i < (poll.attempts ?? 8); i++) {
    const notices = await noticeLocator.allTextContents();
    if (notices.some((s) => confirmed.test(s) && !noticesBefore.includes(s))) {
      return { clicked: true, uiConfirmed: true, reviewRequired: false, evidence: "ui-confirmed" };
    }
    await page.waitForTimeout(poll.waitMs ?? 500);
  }
  return { clicked: true, uiConfirmed: false, reviewRequired: false, evidence: "no-readback" };
}
