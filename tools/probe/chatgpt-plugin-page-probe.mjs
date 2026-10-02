// Read-only: open an Installed plugin's own page and print its main-region text (query strings redacted) so we can see whether
// ChatGPT exposes the discovered tool list. Clicks only the plugin's link. Usage: node tools/probe/chatgpt-plugin-page-probe.mjs "<plugin name>"
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2];
if (!name) { console.error("usage: <plugin name>"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>").replace(/[A-Za-z0-9_-]{32,}/g, "<id>");
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2500));
  const link = page.locator("section a", { hasText: new RegExp("^\\s*" + name + "\\s*$") }).first();
  out.linkFound = (await link.count()) > 0;
  if (out.linkFound) {
    await link.click();
    await new Promise((r) => setTimeout(r, 5000));
    out.path = page.url().replace(/^https:\/\/chatgpt\.com/, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[A-Za-z0-9_-]{20,}/g, "<id>").split("?")[0];
    out.main = clean(await page.evaluate(() => (document.querySelector("main")?.innerText ?? "").slice(0, 4000)));
    out.status = out.main.split("\n").map((l) => l.trim()).filter((l) => /^(connected|connect|reconnect|disconnect)$/i.test(l));
    out.headings = await page.evaluate(() => [...document.querySelectorAll("main h1,main h2,main h3,main [role=tab]")].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20));
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
