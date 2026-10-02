// Screenshots ONLY the New Connector dialog (cropped) at three moments. Types dummy text; submits nothing.
import fs from "node:fs";
import path from "node:path";
import { openSession } from "../../dist/browser/chrome.js";
const dir = process.env.CC_SHOT_DIR ?? "artifacts";
fs.mkdirSync(dir, { recursive: true });
const s = await openSession();
const page = s.page;
const shot = async (label) => { const d = page.locator("[role=dialog]").last(); await d.screenshot({ path: path.join(dir, `grok-dialog-${label}.png`) }); };
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  await page.getByRole("button", { name: /new connector/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  await shot("1-opened");
  await page.locator("[role=dialog]").getByRole("button", { name: /^custom/i }).first().click();
  await new Promise((r) => setTimeout(r, 1500));
  await shot("2-after-custom-click");
  const nameBox = page.locator('input[placeholder="My Connector"]');
  await nameBox.click(); await nameBox.pressSequentially("dummy-name", { delay: 20 });
  await new Promise((r) => setTimeout(r, 800));
  await shot("3-after-typing-name");
  await page.keyboard.press("Escape");
  console.log("shots saved to " + path.resolve(dir));
} catch (e) { console.log("error: " + String(e.message).split("\n")[0]); }
finally { await s.close(); }
