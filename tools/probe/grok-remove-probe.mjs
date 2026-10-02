// Read-only on a THROWAWAY connector: click its row in grok's Connected list and report removal-related controls. Never clicks a destructive one.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
if (!/^cc-selftest/.test(name)) { console.error("refusing: throwaway only"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = [];
const surface = (step) => page.evaluate((st) => {
  const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
  const re = /remove|delete|disconnect|disable|uninstall|manage|edit|settings|more|options|revoke/i;
  const vis = (e) => e.offsetWidth || e.offsetHeight;
  const pops = [...document.querySelectorAll("[role=dialog],[role=alertdialog],[role=menu],[data-radix-popper-content-wrapper]")].filter(vis).map((e) => ({ role: e.getAttribute("role"), text: c(e.innerText).slice(0, 180), buttons: [...e.querySelectorAll("button,[role=menuitem]")].map((b) => c(b.getAttribute("aria-label") || b.innerText).slice(0, 40)).slice(0, 10) }));
  const rowish = [...document.querySelectorAll("button,[role=button],[role=menuitem],[role=switch],a")].filter((e) => vis(e) && re.test(c(e.getAttribute("aria-label") || e.innerText)) && c(e.getAttribute("aria-label") || e.innerText).length < 50).map((e) => c(e.getAttribute("aria-label") || e.innerText)).slice(0, 12);
  return { step: st, path: location.pathname, pops, controls: rowish };
}, step);
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  const row = page.locator("button", { hasText: name }).first();
  out.push({ rowFound: (await row.count()) > 0 });
  await row.click();
  await new Promise((r) => setTimeout(r, 2000));
  out.push(await surface("after row click"));
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
