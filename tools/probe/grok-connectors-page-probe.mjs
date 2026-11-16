// Read-only: opens grok.com/connectors in the browser of ONE account's master profile and prints what the connectors UI shows:
// headings, dialogs (full text), and the text lines of <main> only (the sidebar holds private chat titles and is never printed).
// With --click-connected it presses one chip/button whose text matches /\d+ connected/i once and prints the dialog that opens; with --show-all it then presses "Show all N apps" once.
// Usage: node tools/probe/grok-connectors-page-probe.mjs <master folder name, e.g. browser-master-ulostthegamers> [--click-connected]
import path from "node:path";
import { masterDir, openSession } from "../../dist/browser/chrome.js";
const folder = process.argv[2];
if (!folder) { console.error("usage: <master folder name> [--click-connected]"); process.exit(2); }
const s = await openSession({ master: path.join(path.dirname(masterDir()), folder) });
const page = s.page;
const out = {};
const c = (t) => (t || "").trim().replace(/\s+/g, " ");
const look = () => page.evaluate(() => {
  const t = (x) => (x || "").trim().replace(/\s+/g, " ");
  const main = document.querySelector("main");
  return {
    path: location.pathname,
    headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].filter((e) => e.offsetWidth).map((e) => t(e.innerText)).filter((x) => x && x.length < 80).slice(0, 20),
    dialogs: [...document.querySelectorAll("[role=dialog]")].filter((e) => e.offsetWidth).map((e) => ({ lines: e.innerText.split("\n").map(t).filter(Boolean).slice(0, 80), buttons: [...e.querySelectorAll("button")].filter((b) => b.offsetWidth).map((b) => t(b.getAttribute("aria-label") || b.innerText)).slice(0, 60) })),
    mainLines: main ? main.innerText.split("\n").map(t).filter(Boolean).slice(0, 80) : "no <main>",
    chips: [...document.querySelectorAll("button,[role=button],a")].filter((e) => e.offsetWidth && /\d+ connected|connected \d+/i.test(t(e.getAttribute("aria-label") || e.innerText))).map((e) => t(e.getAttribute("aria-label") || e.innerText)).slice(0, 5),
  };
});
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded", timeout: 45000 });
  await new Promise((r) => setTimeout(r, 7000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click().catch(() => {}); await new Promise((r) => setTimeout(r, 800)); }
  out.atLoad = await look();
  if (process.argv.includes("--click-connected")) {
    const chip = page.locator("button,[role=button],a").filter({ hasText: /\d+ connected/i }).first();
    out.chipCount = await chip.count();
    if (out.chipCount) { await chip.click().catch((e) => { out.clickError = String(e.message).split("\n")[0]; }); await new Promise((r) => setTimeout(r, 4000)); out.afterClick = await look(); }
    const all = page.getByRole("button", { name: /show all \d+ apps/i }).first();
    if (process.argv.includes("--show-all") && (await all.count())) { await all.click().catch((e) => { out.showAllError = String(e.message).split("\n")[0]; }); await new Promise((r) => setTimeout(r, 4000)); out.afterShowAll = await look(); }
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
