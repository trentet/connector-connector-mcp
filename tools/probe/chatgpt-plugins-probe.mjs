// Read-only: controls beside the "Plugins" heading and the names under "Installed" on chatgpt.com/plugins. Never clicks anything.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 9000));
  out.result = await page.evaluate(() => {
    const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
    const vis = (e) => e.offsetWidth || e.offsetHeight;
    const h1 = [...document.querySelectorAll("h1,h2,[role=heading]")].find((h) => c(h.innerText) === "Plugins" && vis(h));
    const chain = [];
    let a = h1;
    for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
      chain.push({ tag: a.tagName.toLowerCase(), buttons: [...a.querySelectorAll("button,[role=button],a[role=button]")].filter(vis).map((b) => c(b.getAttribute("aria-label") || b.innerText)).filter((t) => t && t.length < 50 && !/Project actions|New chat in|Unpin|sidebar/i.test(t)).slice(0, 14) });
    }
    const installedHeading = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((h) => c(h.innerText) === "Installed");
    let installed = [];
    if (installedHeading) { const sec = installedHeading.closest("section") ?? installedHeading.parentElement?.parentElement; installed = [...(sec?.querySelectorAll("button,a,[role=listitem],li") ?? [])].filter(vis).map((e) => c(e.innerText).slice(0, 60)).filter(Boolean).slice(0, 20); }
    return { foundPluginsHeading: !!h1, chain, installed };
  });
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
