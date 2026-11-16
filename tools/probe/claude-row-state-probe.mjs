// Read-only: for one connector row on claude.ai Customize > Connectors > Yours, prints the row's own text and button names,
// then opens the row's detail page and prints its main text and button names. Clicks nothing but the row. Query strings and ids redacted.
// Usage: node tools/probe/claude-row-state-probe.mjs "<connector display name>" [account master dir is the default master]
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2];
if (!name) { console.error("usage: <connector display name>"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/[-]/g, " ");
try {
  await page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
  const rows = await page.$$eval("tr", (rs) => rs.map((r) => ({ text: r.innerText, buttons: [...r.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.innerText).trim().replace(/\s+/g, " ")) })));
  out.matchingRows = rows.filter((r) => r.text.toLowerCase().includes(name.toLowerCase())).map((r) => ({ text: r.text.replace(/\s+/g, " "), buttons: r.buttons }));
  const idx = rows.findIndex((r) => r.text.toLowerCase().includes(name.toLowerCase()));
  if (idx >= 0) {
    await page.locator("tr").nth(idx).click();
    await page.waitForURL(/\/yours\/id\//, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 3000));
    out.detail = {
      path: page.url().replace(/^https:\/\/claude\.ai/, ""),
      main: (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 1500),
      buttons: await page.locator("main button").evaluateAll((bs) => bs.filter((b) => b.offsetWidth).map((b) => (b.getAttribute("aria-label") || b.innerText).trim().replace(/\s+/g, " "))),
      dialogs: await page.evaluate(() => [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter((e) => e.offsetWidth).map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 400))),
    };
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
