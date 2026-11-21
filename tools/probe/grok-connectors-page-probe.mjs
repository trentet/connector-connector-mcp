// Read-only probe (REQ-D017, carried from pull request 100 and extended): grok.com/connectors in the browser of ONE account's
// master profile. Prints the visible dialogs only (text lines and buttons); the sidebar with private chat titles is never printed,
// and no line holding a URL or token= is ever printed (the detail view shows the server URL with its token).
// Presses the "N connected" chip once and "Show all N apps" once; with --detail <name> it then opens that one connected row
// and presses "See more" once. It never presses a tool, a toggle, Disconnect, Manage or any other control.
// Usage: node tools/probe/grok-connectors-page-probe.mjs <master folder name, e.g. browser-master-ulostthegamers> [--detail <name>]
import path from "node:path";
import { masterDir, openSession } from "../../dist/browser/chrome.js";
const folder = process.argv[2];
if (!folder) { console.error("usage: <master folder name> [--detail <name>]"); process.exit(2); }
const di = process.argv.indexOf("--detail"); const detail = di > 0 ? process.argv[di + 1] : undefined;
const s = await openSession({ master: path.join(path.dirname(masterDir()), folder) });
const page = s.page; const out = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const look = () => page.evaluate(() => {
  const t = (x) => (x || "").trim().replace(/\s+/g, " ");
  return { path: location.pathname, dialogs: [...document.querySelectorAll("[role=dialog]")].filter((e) => e.offsetWidth).map((e) => ({ lines: e.innerText.split("\n").map(t).filter(Boolean).filter((l) => !/:\/\/|token=|^server url$/i.test(l)).slice(0, 220), buttons: [...e.querySelectorAll("button,[role=switch],[role=checkbox],input[type=checkbox]")].filter((b) => b.offsetWidth).map((b) => (b.getAttribute("role") || b.tagName) + ":" + t(b.getAttribute("aria-label") || b.innerText) + (b.getAttribute("aria-checked") ? "[" + b.getAttribute("aria-checked") + "]" : "")).slice(0, 120) })) };
});
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded", timeout: 45000 }); await wait(7000);
  const rej = page.getByRole("button", { name: /reject all/i }); if (await rej.count()) { await rej.first().click().catch(() => {}); await wait(800); }
  out.atLoad = await look();
  const chip = page.locator("[role=dialog] button, [role=dialog] [role=button], [role=dialog] a").filter({ hasText: /\d+ connected/i }).first();
  out.chipCount = await chip.count();
  if (out.chipCount) { out.chipText = await chip.innerText(); await chip.click(); await wait(3000); out.afterChip = await look(); }
  const all = page.getByRole("button", { name: /^show all \d+ apps$/i }).first();
  out.showAllCount = await all.count();
  if (out.showAllCount) { await all.click(); await wait(3000); out.afterShowAll = await look(); }
  if (detail) {
    const rowBtn = page.locator("[role=dialog] button").filter({ hasText: detail }).first();
    out.detailRowCount = await rowBtn.count();
    if (out.detailRowCount) { out.clickErr = await rowBtn.click({ timeout: 8000 }).then(() => "").catch(async (e) => { await rowBtn.evaluate((b) => b.click()); return String(e.message).split("\n")[0]; }); await wait(5000); out.afterDetail = await look(); const more = page.locator("[role=dialog] button").filter({ hasText: /^see more$/i }).first(); out.seeMore = await more.count(); if (out.seeMore) { await more.evaluate((b) => b.click()); await wait(3000); out.afterSeeMore = await look(); } }
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));


