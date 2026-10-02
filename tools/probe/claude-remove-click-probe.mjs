// Clicks Remove on a THROWAWAY connector (default cc-selftest) and records what the UI does next. Not for real connectors.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
if (!/^cc-selftest/.test(name)) { console.error("refusing: this probe only runs against cc-selftest*"); process.exit(2); }
const s = await openSession();
const out = [];
const dump = async (step) => {
  await new Promise((r) => setTimeout(r, 1800));
  out.push({ step, ...(await s.page.evaluate(() => {
    const clip = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
    return {
      path: location.pathname.replace(/[0-9a-f-]{36}/, "<id>"),
      main: clip(document.querySelector("main")?.innerText).slice(0, 300),
      popups: [...document.querySelectorAll("[role=dialog],[role=alertdialog],[role=menu],[data-radix-popper-content-wrapper],[data-state=open]")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), text: clip(e.innerText).slice(0, 200), buttons: [...e.querySelectorAll("button,[role=menuitem]")].map((b) => clip(b.innerText)) })).slice(0, 6),
    };
  }).catch((e) => ({ err: String(e).slice(0, 120) }))) });
};
try {
  await s.page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded" });
  await s.page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
  await s.page.locator("tr", { hasText: name }).first().click();
  await s.page.waitForURL(/\/yours\/id\//, { timeout: 15000 });
  await dump("detail");
  await s.page.locator("main").getByRole("button", { name: /more|options|menu|actions/i }).first().click();
  await dump("menu open");
  await s.page.getByRole("menuitem", { name: /^remove$/i }).first().click();
  await dump("after Remove click");
  await s.page.screenshot({ path: "artifacts/claude-after-remove-click.png" });
} catch (e) { out.push({ error: String(e.message).split("\n")[0] }); }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
