// Read-only: in grok's New Connector dialog, find the Custom tile, real-click it, and report which inputs/buttons become VISIBLE. Types nothing, submits nothing.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
const vis = () => page.evaluate(() => {
  const c = (t) => (t || "").trim().replace(/\s+/g, " ");
  const d = [...document.querySelectorAll("[role=dialog]")].pop();
  if (!d) return { dialog: false };
  const v = (e) => !!(e.offsetWidth || e.offsetHeight);
  return { dialog: true, text: c(d.innerText).slice(0, 160), inputs: [...d.querySelectorAll("input,textarea")].map((e) => ({ placeholder: e.getAttribute("placeholder"), visible: v(e) })), buttons: [...d.querySelectorAll("button")].filter(v).map((b) => c(b.innerText).slice(0, 40)).slice(0, 8) };
});
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  await page.getByRole("button", { name: /new connector/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  out.opened = await vis();
  out.customCandidates = await page.evaluate(() => [...document.querySelectorAll("[role=dialog] *")].filter((e) => /^custom\b/i.test((e.innerText || "").trim()) && (e.offsetWidth || e.offsetHeight)).slice(0, 5).map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), text: e.innerText.trim().replace(/\s+/g, " ").slice(0, 60), childButtons: e.querySelectorAll("button").length })));
  const tile = page.locator("[role=dialog]").getByRole("button", { name: /^custom/i }).first();
  out.tileButtonCount = await page.locator("[role=dialog]").getByRole("button", { name: /^custom/i }).count();
  if (out.tileButtonCount) { await tile.click(); await new Promise((r) => setTimeout(r, 1500)); out.afterRealClick = await vis(); }
  await page.keyboard.press("Escape");
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
