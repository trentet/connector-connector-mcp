// Read-only: map chatgpt.com/plugins when signed in. Buttons/tabs/headings only (sidebar chat titles are links and are skipped).
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 9000));
  out.url = page.url();
  out.title = await page.title();
  const dump = () => page.evaluate(() => {
    const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
    const vis = (e) => e.offsetWidth || e.offsetHeight;
    return {
      headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].filter(vis).map((h) => c(h.innerText)).filter(Boolean).slice(0, 25),
      tabs: [...document.querySelectorAll("[role=tab],[role=tablist] *")].filter(vis).map((t) => c(t.innerText)).filter(Boolean).slice(0, 10),
      buttons: [...document.querySelectorAll("button,[role=button]")].filter(vis).map((b) => c(b.getAttribute("aria-label") || b.innerText)).filter((t) => t && t.length < 45).slice(0, 45),
      inputs: [...document.querySelectorAll("input")].filter(vis).map((i) => c(i.getAttribute("placeholder") || i.getAttribute("aria-label"))).slice(0, 5),
    };
  });
  out.page = await dump();
  const add = page.getByRole("button", { name: /^(add|create|new)\b/i }).first();
  out.addCandidate = (await add.count()) ? (await add.innerText()).trim() : null;
  if (out.addCandidate) { await add.click(); await new Promise((r) => setTimeout(r, 1500)); out.afterAddClick = await page.evaluate(() => [...document.querySelectorAll("[role=menu],[role=menuitem],[role=dialog]")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => (e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 120)).slice(0, 8)); await page.keyboard.press("Escape"); }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
