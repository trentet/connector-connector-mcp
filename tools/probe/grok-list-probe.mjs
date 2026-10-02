// Read-only: locate grok.com's connector management UI; look for `name` anywhere in the page text. Filtered output only (no chat titles).
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
const s = await openSession();
const out = {};
const clip = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
const sweep = () => s.page.evaluate(([n]) => {
  const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
  const re = /connector|plugin|app|manage|setting|custom|new|add|install|connected|integration|tool/i;
  return {
    path: location.pathname,
    nameInPage: document.body.innerText.includes(n),
    links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /connector|plugin|app|setting|integration/i.test(h || "")).slice(0, 12),
    controls: [...document.querySelectorAll("button,[role=button],[role=tab],[role=menuitem],a")].filter((e) => (e.offsetWidth || e.offsetHeight) && re.test(c(e.getAttribute("aria-label") || e.innerText)) && c(e.getAttribute("aria-label") || e.innerText).length < 60).map((e) => c(e.getAttribute("aria-label") || e.innerText)).slice(0, 25),
  };
}, [name]);
try {
  await s.page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  const rej = s.page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click().catch(() => {}); await new Promise((r) => setTimeout(r, 500)); }
  out.atLoad = await sweep();
  const nc = s.page.getByRole("button", { name: /new connector/i }).first();
  out.newConnectorButtonVisible = (await nc.count()) > 0;
  const plugins = s.page.getByRole("link", { name: /plugins|connectors|apps/i }).or(s.page.getByRole("button", { name: /plugins|connectors|apps/i })).first();
  if (await plugins.count()) { await plugins.click().catch(() => {}); await new Promise((r) => setTimeout(r, 3000)); out.afterPluginsClick = await sweep(); }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
