// Opens one connector's detail page on claude.ai (Customize > Connectors > Yours), presses its "Reconnect" button ONCE and reports, for 30 s,
// every page of the browser context (origin + path only), dialogs and the detail text. It never types into any page and never presses anything else.
// Usage: node tools/probe/claude-reconnect-probe.mjs "<connector display name>"
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2];
if (!name) { console.error("usage: <connector display name>"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = { steps: [] };
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/[-]/g, " ");
const where = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
const look = async (label) => {
  const pages = s.context.pages().map((p) => where(p.url()));
  const dialogs = await page.evaluate(() => [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => e.offsetWidth).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 300))).catch(() => []);
  const main = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
  out.steps.push({ label, pages, dialogs, main });
};
try {
  await page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
  const texts = await page.$$eval("tr", (rs) => rs.map((r) => r.innerText));
  const idx = texts.findIndex((t) => t.replace(/[-]/g, " ").replace(/\s+/g, " ").trim().startsWith(name + " "));
  if (idx < 0) throw new Error("row not found");
  await page.locator("tr").nth(idx).click();
  await page.waitForURL(/\/yours\/id\//, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));
  await look("detail before");
  const btn = page.locator("main").getByRole("button", { name: /^reconnect$/i }).first();
  out.reconnectButtons = await btn.count();
  if (out.reconnectButtons) {
    await btn.click();
    for (const t of [2, 4, 6, 8, 10]) { await new Promise((r) => setTimeout(r, 2000)); await look("after click +" + t + "s"); }
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
