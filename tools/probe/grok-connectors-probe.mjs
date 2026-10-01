// Read-only: open grok.com/connectors (logged in), open New Connector > Custom, snapshot the form, then Escape. Submits nothing.
import fs from "node:fs";
import { openSession, snapshot } from "../../dist/browser/chrome.js";
const s = await openSession();
const R = (x) => x;
const out = [];
try {
  await s.page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForTimeout(4000);
  const rej = s.page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click(); await s.page.waitForTimeout(500); }
  out.push({ step: "connectors page", ...(await snapshot(s.page, R)) });
  const nc = s.page.getByRole("button", { name: /new connector/i }).first();
  if (await nc.count()) { await nc.click(); await s.page.waitForTimeout(1500); out.push({ step: "after New Connector", ...(await snapshot(s.page, R)) }); }
  const custom = s.page.getByText(/^custom$/i).first();
  if (await custom.count()) { await custom.click(); await s.page.waitForTimeout(1500); out.push({ step: "after Custom", ...(await snapshot(s.page, R)) }); }
  await s.page.screenshot({ path: "artifacts/grok-custom-form.png" });
  await s.page.keyboard.press("Escape");
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
