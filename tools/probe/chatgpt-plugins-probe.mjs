// Read-only: find the control that creates a custom MCP plugin on chatgpt.com/plugins (icon-only buttons included). Never clicks.
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
    const search = document.querySelector('input[placeholder*="Search plugins"]');
    const describe = (e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), aria: e.getAttribute("aria-label"), testid: e.getAttribute("data-testid"), text: c(e.innerText).slice(0, 30), hasPopup: e.getAttribute("aria-haspopup"), svgOnly: !c(e.innerText) && !!e.querySelector("svg"), w: Math.round(e.getBoundingClientRect().width), x: Math.round(e.getBoundingClientRect().left), y: Math.round(e.getBoundingClientRect().top) });
    const near = [];
    let a = search;
    for (let i = 0; i < 6 && a; i++, a = a.parentElement) {
      const bs = [...a.querySelectorAll("button,[role=button],[role=tab],a[role=button],[aria-haspopup]")].filter(vis).filter((b) => !b.closest("nav") && !b.closest("aside")).map(describe);
      near.push({ level: i, count: bs.length, items: bs.slice(0, 12) });
      if (bs.length >= 3) break;
    }
    const popups = [...document.querySelectorAll("[aria-haspopup]")].filter(vis).filter((b) => !b.closest("nav") && !b.closest("aside")).map(describe).slice(0, 10);
    return { viewport: [innerWidth, innerHeight], searchFound: !!search, near, popups };
  });
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
