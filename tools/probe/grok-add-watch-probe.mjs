// Repeats the grok add flow for the THROWAWAY cc-selftest connector (working click/typing path) and records what the UI does for ~15s after "Add Connector".
import { openSession } from "../../dist/browser/chrome.js";
import { loadRegistry } from "../../dist/core/registry.js";
import { Redactor } from "../../dist/core/redact.js";
import { resolve } from "../../dist/core/secrets.js";
const reg = loadRegistry("registry/selftest.json");
const c = reg.connectors[0];
const red = new Redactor();
const url = await resolve(c.urlByPlatform.grok, red);
const R = (x) => red.redact(x);
const s = await openSession();
const page = s.page;
const out = { timeline: [] };
const sample = () => page.evaluate(() => {
  const c = (t) => (t || "").trim().replace(/\s+/g, " ");
  const heading = [...document.querySelectorAll("h1,h2,h3")].map((h) => c(h.innerText)).filter((t) => /connector/i.test(t));
  const toasts = [...document.querySelectorAll("[role=alert],[role=status],[data-sonner-toast],[class*=toast],[class*=Toast]")].map((e) => c(e.innerText).slice(0, 200)).filter(Boolean);
  const dialogs = [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => c(e.innerText).slice(0, 140));
  const hints = (document.body.innerText.match(/[^\n]{0,60}(error|fail|invalid|unable|cannot|already|authori[sz]e|sign in to|oauth)[^\n]{0,60}/gi) ?? []).slice(0, 4).map((h) => c(h));
  return { path: location.pathname + (location.search ? "?q" : ""), heading, toasts, dialogs, hints, hasName: document.body.innerText.includes("cc-selftest") };
});
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  await page.getByRole("button", { name: /new connector/i }).first().click();
  const dialog = page.locator("[role=dialog]").last();
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole("button", { name: /^custom/i }).first().click();
  await dialog.getByText(/custom connector/i).first().waitFor({ timeout: 8000 });
  const nameBox = dialog.locator('input[placeholder="My Connector"]');
  const urlBox = dialog.locator('input[placeholder*="mcp.example.com"]');
  await nameBox.click(); await nameBox.pressSequentially("cc-selftest", { delay: 12 });
  await urlBox.click(); await urlBox.pressSequentially(url, { delay: 4 });
  const btn = dialog.getByRole("button", { name: /^add connector$/i }).first();
  out.btnDisabledBefore = await btn.isDisabled();
  await btn.click();
  let prev = "";
  for (let i = 0; i < 22; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const smp = R(JSON.stringify(await sample().catch((e) => ({ err: String(e).slice(0, 80) }))));
    if (smp !== prev) { out.timeline.push({ t: ((i + 1) * 0.7).toFixed(1), ...JSON.parse(smp) }); prev = smp; }
  }
} catch (e) { out.error = R(String(e.message).split("\n")[0]); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
