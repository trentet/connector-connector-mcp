// Read-only: open a custom connector's detail page on claude.ai and list ONLY controls that could remove it. Never clicks a destructive one.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
const s = await openSession();
const out = [];
const pick = async () => s.page.evaluate(() => {
  const clip = (e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ").slice(0, 60);
  const re = /remove|disconnect|delete|configure|more|settings|menu|edit|actions|options/i;
  return [...document.querySelectorAll("button,[role=button],[role=menuitem],a")].filter((e) => (e.offsetWidth || e.offsetHeight) && !e.closest("nav,aside,[data-testid*=sidebar]")).map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), label: clip(e) })).filter((x) => re.test(x.label) && !/^more options for /i.test(x.label)).slice(0, 25);
});
try {
  await s.page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded" });
  await s.page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
  await s.page.locator("tr", { hasText: name }).first().click();
  await new Promise((r) => setTimeout(r, 3000));
  out.push({ step: "detail page", url: s.page.url().replace(/[0-9a-f-]{36}/, "<id>"), main: (await s.page.evaluate(() => (document.querySelector("main")?.innerText ?? "").replace(/[-]/g, "").replace(/\s+/g, " ").slice(0, 500))), controls: await pick() });
  const more = s.page.locator("main").getByRole("button", { name: /more|options|menu|actions/i }).first();
  if (await more.count()) { await more.click(); await new Promise((r) => setTimeout(r, 1200)); out.push({ step: "after more-menu click", menu: await s.page.locator("[role=menu] [role=menuitem],[role=menuitem]").evaluateAll((es) => es.map((e) => e.innerText.trim().replace(/\s+/g, " ")).filter(Boolean)) }); await s.page.keyboard.press("Escape"); }
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
