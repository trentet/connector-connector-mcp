// Repeats the grok add flow for the THROWAWAY cc-selftest connector and records every alert/toast/dialog text for ~12s after submit.
import fs from "node:fs";
import { openSession } from "../../dist/browser/chrome.js";
import { loadRegistry } from "../../dist/core/registry.js";
import { run } from "../../dist/core/runner.js";
if (process.argv[2] && process.argv[2] !== "cc-selftest") { console.error("refusing: throwaway only"); process.exit(2); }
const reg = loadRegistry("registry/selftest.json");
const c = reg.connectors[0];
// resolve url via the runner's dry-run path is redacted, so resolve directly here
const { Redactor } = await import("../../dist/core/redact.js");
const { resolve } = await import("../../dist/core/secrets.js");
const red = new Redactor();
const url = await resolve(c.urlByPlatform.grok, red);
const s = await openSession();
const page = s.page;
const seen = new Set();
const R = (x) => red.redact(x);
const watch = async () => {
  const items = await page.evaluate(() => [...document.querySelectorAll("[role=alert],[role=status],[data-sonner-toast],[class*=toast],[role=dialog],[role=alertdialog]")].map((e) => (e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 300)).filter(Boolean)).catch(() => []);
  for (const t of items) seen.add(R(t));
};
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click().catch(() => {}); }
  await page.getByRole("button", { name: /new connector/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  await page.getByText(/^custom/i).first().click();
  await new Promise((r) => setTimeout(r, 1200));
  const nameBox = page.locator('input[placeholder="My Connector"]');
  const urlBox = page.locator('input[placeholder*="mcp.example.com"]');
  await nameBox.click(); await nameBox.pressSequentially("cc-selftest", { delay: 15 });
  await urlBox.click(); await urlBox.pressSequentially(url, { delay: 5 });
  await new Promise((r) => setTimeout(r, 1000));
  const btn = page.getByRole("button", { name: /^add connector$/i }).first();
  const dlgText = async () => R(await page.evaluate(() => { const d = [...document.querySelectorAll("[role=dialog]")].pop(); return d ? d.innerText.trim().replace(/\s+/g, " ").slice(0, 400) : "(no dialog)"; }));
  const state = { before: { disabled: await btn.isDisabled().catch(() => "n/a"), ariaDisabled: await btn.getAttribute("aria-disabled").catch(() => null), nameVal: await nameBox.inputValue(), urlLen: (await urlBox.inputValue()).length, dialog: await dlgText() } };
  await btn.click();
  const timeline = [];
  for (let i = 0; i < 16; i++) { await new Promise((r) => setTimeout(r, 700)); timeline.push({ t: ((i + 1) * 0.7).toFixed(1), dialog: await dlgText() }); }
  state.timeline = timeline.filter((x, i) => i === 0 || x.dialog !== timeline[i - 1].dialog);
  for (let i = 0; i < 4; i++) { await watch(); await new Promise((r) => setTimeout(r, 300)); }
  const nameNow = await page.evaluate(() => document.body.innerText.includes("cc-selftest"));
  console.log(JSON.stringify({ ...state, nameInPageAfter: nameNow, path: new URL(page.url()).pathname }, null, 1));
} catch (e) { console.log(JSON.stringify({ error: R(String(e.message).split("\n")[0]), seen: [...seen] })); }
finally { await s.close(); }
