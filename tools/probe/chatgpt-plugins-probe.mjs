// Read-only: map chatgpt.com/plugins when signed in: section headings, whether user-created plugins are listed, and the Add menu items. Filtered output.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  out.headings = await page.evaluate(() => [...document.querySelectorAll("main h1,main h2,main h3,[role=tab],main [role=heading]")].map((h) => h.innerText.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, 25));
  out.mainStart = c(await page.evaluate(() => document.querySelector("main")?.innerText ?? "")).slice(0, 400);
  out.pageControls = await page.evaluate(() => [...document.querySelectorAll("main button,main [role=tab],main a")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 40)).filter((t) => /^(add|create|new|manage|your|my|drafts|installed|created|all|mine|plugins?|apps?)\b/i.test(t) || /by you|your/i.test(t)).slice(0, 20));
  const add = page.getByRole("button", { name: /^add$/i }).first();
  out.addButtonPresent = (await add.count()) > 0;
  if (out.addButtonPresent) {
    await add.click(); await new Promise((r) => setTimeout(r, 1200));
    out.addMenu = await page.evaluate(() => [...document.querySelectorAll("[role=menuitem],[role=menu] *")].filter((e) => e.children.length === 0 && (e.innerText || "").trim()).map((e) => e.innerText.trim().replace(/\s+/g, " ")).slice(0, 10));
    await page.keyboard.press("Escape");
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
