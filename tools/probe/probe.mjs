// P0 probe: read-only inspection of each platform's connector UI over CDP.
// Opens ONE new tab, visits each page, records redacted structure + screenshot, closes its own tab.
// Never submits a form. Becomes `cc probe` in P2.
import { openSession } from "../../dist/browser/chrome.js";
import fs from "node:fs";
import path from "node:path";

const port = process.env.CC_DEBUG_PORT || "9222";
const targets = {
  claude: "https://claude.ai/customize/connectors?modal=add-custom-connector",
  chatgpt: "https://chatgpt.com/plugins",
  grok: "https://grok.com/connectors",
};
const only = process.argv.slice(2);
const outDir = path.resolve("artifacts", "probe-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(outDir, { recursive: true });

const redact = (s) => String(s ?? "").replace(/([?&](token|shell_secret|key|code|state)=)[^&\s"]+/gi, "$1<REDACTED>");

const sess = await openSession({ port });
const page = sess.page;
const results = {};
try {
  for (const [name, url] of Object.entries(targets)) {
    if (only.length && !only.includes(name)) continue;
    const r = { requested: url };
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      r.finalUrl = redact(page.url());
      r.title = await page.title();
      r.bodyText = redact((await page.evaluate(() => document.body.innerText)).slice(0, 1500));
      r.controls = await page.evaluate(() => {
        const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
        const lbl = (e) => (e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.innerText || e.name || "").trim().slice(0, 80);
        return {
          dialogs: [...document.querySelectorAll('[role=dialog]')].filter(vis).length,
          inputs: [...document.querySelectorAll("input,textarea")].filter(vis).map((e) => ({ type: e.type, name: e.name, label: lbl(e) })),
          buttons: [...document.querySelectorAll("button,[role=button],a[role=button]")].filter(vis).map(lbl).filter(Boolean).slice(0, 40),
        };
      });
      await page.screenshot({ path: path.join(outDir, name + ".png"), fullPage: false });
    } catch (e) {
      r.error = redact(e.message).slice(0, 300);
      await page.screenshot({ path: path.join(outDir, name + "-error.png") }).catch(() => {});
    }
    results[name] = r;
  }
} finally {
  await sess.close(); // never closes the last tab (a zero-tab Chrome exits)
}
fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ outDir, results }, null, 2));
