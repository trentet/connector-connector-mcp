// Read-only: lists visible buttons/links/headings/dialogs on grok.com/connectors (no page text dump, no clicks).
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
try {
  await page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  const out = await page.evaluate(() => {
    const c = (t) => (t || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const vis = (e) => e.offsetWidth || e.offsetHeight;
    const pick = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => ({ tag: e.tagName, role: e.getAttribute("role"), aria: e.getAttribute("aria-label"), text: c(e.innerText) }));
    return {
      url: location.pathname,
      dialogs: pick("[role=dialog],[role=alertdialog]"),
      headings: pick("h1,h2,h3"),
      links: pick("a").filter((x) => !x.text || /connect|add|new|custom|mcp/i.test(x.text + x.aria)),
      buttons: pick("button").filter((x) => !/^(Added|Connected)/i.test(x.text) && x.text.length < 40),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally { await s.close(); }
