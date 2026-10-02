// Describes the New Connector dialog layout as text (element order, rects, scroll state) before/after clicking the Custom tile. Types nothing; submits nothing.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const layout = () => page.evaluate(() => {
  const c = (t) => (t || "").trim().replace(/\s+/g, " ");
  const d = [...document.querySelectorAll("[role=dialog]")].pop();
  if (!d) return { dialog: false };
  const dr = d.getBoundingClientRect();
  const els = [...d.querySelectorAll("input,textarea,button,h1,h2,h3,label")].filter((e) => e.offsetWidth || e.offsetHeight);
  const row = (e) => { const r = e.getBoundingClientRect(); return { k: e.tagName.toLowerCase(), t: c(e.getAttribute("placeholder") || e.getAttribute("aria-label") || e.innerText).slice(0, 38), y: Math.round(r.top - dr.top), h: Math.round(r.height), disabled: e.disabled || e.getAttribute("aria-disabled") === "true" || undefined }; };
  const scrollers = [d, ...d.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => ({ tag: e.tagName.toLowerCase(), scrollTop: Math.round(e.scrollTop), scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }));
  return { dialogSize: [Math.round(dr.width), Math.round(dr.height)], scrollers, nonTileElements: els.map(row).filter((x) => !/^(add|)$/i.test(x.t) && !/Securely|Check your|Search files|Create and|Search pages|Look up|Manage|Search and|Inspect|Generate/i.test(x.t)).slice(0, 24) };
});
const out = {};
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  await page.getByRole("button", { name: /new connector/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  out.opened = await layout();
  await page.locator("[role=dialog]").getByRole("button", { name: /^custom/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  out.afterCustomClick = await layout();
  await page.keyboard.press("Escape");
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out));
