// Exploratory, read-only: walk grok.com's sign-in UI up to (not including) credential entry.
import { openSession, snapshot } from "../../dist/browser/chrome.js";
const s = await openSession();
const red = (x) => x;
const steps = [];
try {
  await s.page.goto("https://grok.com/sign-in", { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForTimeout(3000);
  steps.push({ step: "sign-in page", ...(await snapshot(s.page, red)) });
  const reject = s.page.getByRole("button", { name: /reject all/i });
  if (await reject.count()) { await reject.first().click(); await s.page.waitForTimeout(800); }
  const emailBtn = s.page.getByRole("button", { name: /email/i }).first();
  if (await emailBtn.count()) { await emailBtn.click(); await s.page.waitForTimeout(1500); steps.push({ step: "after email option", ...(await snapshot(s.page, red)) }); }
} catch (e) { steps.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(steps, null, 1));
