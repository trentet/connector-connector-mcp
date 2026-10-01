// Read-only: find how claude.ai removes a custom connector. Clicks the row / its menu and snapshots; never clicks a destructive button.
import { openSession, snapshot } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
const s = await openSession();
const R = (x) => x;
const out = [];
try {
  await s.page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded" });
  await s.page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 5000));
  const row = s.page.locator("tr", { hasText: name }).first();
  out.push({ step: "row controls", rowText: (await row.innerText()).replace(/[-]/g, "").replace(/\s+/g, " "), buttons: await row.locator("button,[role=button],a").evaluateAll((es) => es.map((e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 50))) });
  await row.click();
  await new Promise((r) => setTimeout(r, 2500));
  out.push({ step: "after row click", ...(await snapshot(s.page, R, { containing: "[role=dialog]", up: 0 }).catch(() => ({}))), pageUrl: s.page.url(), menuItems: await s.page.locator("[role=menuitem],[role=dialog] button,[role=dialog] a").evaluateAll((es) => es.map((e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 50)).filter(Boolean).slice(0, 30)) });
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
