// Read-only: show the DOM shape of rows in grok.com's "Connected" section (names + structure only).
import { openSession } from "../../dist/browser/chrome.js";
const probeName = process.argv[2] ?? "Gmail";
const s = await openSession();
const out = {};
try {
  await s.page.goto("https://grok.com/connectors", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 6000));
  const rej = s.page.getByRole("button", { name: /reject all/i });
  if (await rej.count()) await rej.first().click().catch(() => {});
  out.rows = await s.page.evaluate((n) => {
    const c = (t) => (t || "").trim().replace(/\s+/g, " ");
    const small = [...document.querySelectorAll("*")].filter((e) => c(e.innerText).startsWith(n) && c(e.innerText).length < 120 && (e.offsetWidth || e.offsetHeight));
    const smallest = small.sort((a, b) => c(a.innerText).length - c(b.innerText).length)[0];
    if (!smallest) return "not found";
    const chain = []; let a = smallest;
    for (let i = 0; i < 4 && a; i++) { chain.push({ tag: a.tagName.toLowerCase(), role: a.getAttribute("role"), lines: (a.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean), leafTexts: [...a.querySelectorAll("*")].filter((e) => e.children.length === 0 && c(e.textContent)).map((e) => e.tagName.toLowerCase() + ":" + c(e.textContent).slice(0, 30)).slice(0, 8) }); a = a.parentElement; }
    return chain;
  }, probeName);
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
