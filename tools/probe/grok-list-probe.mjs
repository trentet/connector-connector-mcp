// Read-only: find where grok.com lists the user's connectors and whether `name` (default cc-selftest) is there.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
const s = await openSession();
const out = {};
try {
  await s.page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 5000));
  const rej = s.page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) { await rej.first().click().catch(() => {}); await new Promise((r) => setTimeout(r, 500)); }
  out.signedOutButtons = await s.page.getByRole("button", { name: /^sign in$/i }).count();
  out.found = await s.page.evaluate((n) => {
    const clip = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
    const hits = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && clip(e.textContent) === n);
    return hits.slice(0, 3).map((h) => {
      let a = h; const chain = [];
      for (let i = 0; i < 5 && a.parentElement; i++) { a = a.parentElement; chain.push({ tag: a.tagName.toLowerCase(), role: a.getAttribute("role"), text: clip(a.innerText).slice(0, 160), buttons: [...a.querySelectorAll("button,[role=button],[role=switch],a")].map((b) => clip(b.getAttribute("aria-label") || b.innerText).slice(0, 40)).filter(Boolean).slice(0, 8) }); }
      return chain;
    });
  }, name);
  out.pageHeadings = await s.page.evaluate(() => [...document.querySelectorAll("main h1,main h2,main h3,[role=heading]")].map((h) => h.innerText.trim().replace(/\s+/g, " ")).slice(0, 12));
  out.mainText = await s.page.evaluate(() => (document.querySelector("main")?.innerText ?? "").replace(/[-]/g, "").replace(/\s+/g, " ").slice(0, 500));
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
