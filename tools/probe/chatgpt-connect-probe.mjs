// Opens an Installed plugin's page, clicks its "Connect" button once, and reports what happens (dialogs, status after). Query strings redacted.
// Usage: node tools/probe/chatgpt-connect-probe.mjs "<plugin name>"
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2];
if (!name) { console.error("usage: <plugin name>"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>").replace(/[A-Za-z0-9_-]{32,}/g, "<id>");
const snap = () => page.evaluate(() => ({
  path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[A-Za-z0-9_-]{20,}/g, "<id>"),
  status: ((document.querySelector("main") || {}).innerText || "").split("\n").map((l) => l.trim()).filter((l) => /^(connected|connect|reconnect|disconnect)$/i.test(l)),
  dialogs: [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => e.offsetWidth).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 300)),
  toasts: [...document.querySelectorAll("[role=status],[role=alert]")].filter((e) => e.offsetWidth).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)),
}));
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.locator("section a", { hasText: new RegExp("^\\s*" + name + "\\s*$") }).first().click();
  await page.waitForURL(/\/plugins\/[^/]+/, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));
  out.before = await snap();
  const btn = page.getByRole("button", { name: /^connect$/i }).first();
  out.hasConnect = (await btn.count()) > 0;
  if (out.hasConnect) {
    await btn.click();
    await new Promise((r) => setTimeout(r, 2000));
    const dlg = page.locator("[role=dialog],[role=alertdialog]").last();
    out.dialogButtons = await dlg.locator("button").evaluateAll((bs) => bs.filter((b) => b.offsetWidth).map((b) => (b.getAttribute("aria-label") || b.innerText).trim().replace(/\s+/g, " ")));
    if (process.env.CONFIRM) {
      await dlg.getByRole("button", { name: new RegExp(process.env.CONFIRM, "i") }).last().click();
      out.confirmed = process.env.CONFIRM;
    }
    for (const t of [2, 5, 10]) { await new Promise((r) => setTimeout(r, t * 1000)); out["after" + t] = await snap(); }
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
