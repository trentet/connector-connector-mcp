// Read-only: open grok.com/connectors > New Connector, snapshot ONLY the dialog; type DUMMY values (never ours) to
// reveal conditional auth options; Escape without submitting.
import { openSession, snapshot } from "../../dist/browser/chrome.js";
const s = await openSession();
const R = (x) => x;
const scope = { containing: 'input[placeholder="My Connector"]', up: 6 };
const out = [];
try {
  await s.page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForTimeout(4000);
  const rej = s.page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click(); await s.page.waitForTimeout(500); }
  await s.page.getByRole("button", { name: /new connector/i }).first().click();
  await s.page.waitForTimeout(1500);
  out.push({ step: "dialog as opened", ...(await snapshot(s.page, R, scope)) });
  await s.page.locator('input[placeholder="My Connector"]').fill("cc-probe-dummy");
  await s.page.locator('input[placeholder="https://mcp.example.com/sse"]').fill("https://example.invalid/mcp");
  await s.page.waitForTimeout(1200);
  out.push({ step: "after dummy name+url", ...(await snapshot(s.page, R, scope)) });
  await s.page.screenshot({ path: "artifacts/grok-new-connector-dialog.png" });
  await s.page.keyboard.press("Escape");
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
