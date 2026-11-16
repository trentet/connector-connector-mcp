// Presses the Installed section's "N more connected plugins" link on chatgpt.com/plugins ONCE and reports where it leads
// (path only) and what the page then lists (names of plugins: the plugin lists hold no chat titles). Nothing else is pressed.
// Usage: node tools/probe/chatgpt-more-probe.mjs
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>");
const pageState = () => page.evaluate(() => {
  const main = document.querySelector("main");
  const lines = ((main && main.innerText) || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return { path: location.pathname, lineCount: lines.length, lines: lines.slice(0, 120), dialogs: [...document.querySelectorAll("[role=dialog]")].filter((e) => e.offsetWidth).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 600)) };
});
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000, polling: 500 });
  await new Promise((r) => setTimeout(r, 3000));
  const link = page.locator("section a", { hasText: /\d+ more/i }).first();
  out.moreLinks = await page.locator("section a", { hasText: /\d+ more/i }).count();
  out.href = await link.getAttribute("href").catch(() => null);
  await link.click();
  await new Promise((r) => setTimeout(r, 4000));
  out.after = await pageState();
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
