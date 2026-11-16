// Read-only: opens chatgpt.com/plugins, finds the "Installed" section and prints what it holds: every button and link text
// (connector names only: the section holds no chat titles) and any control whose text mentions "more"/"show"/"all". Clicks nothing.
// Usage: node tools/probe/chatgpt-installed-probe.mjs
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>");
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000, polling: 500 });
  await new Promise((r) => setTimeout(r, 3000));
  out.section = await page.evaluate(() => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => e.innerText.trim() === "Installed");
    const sec = hd.closest("section") ?? hd.parentElement?.parentElement;
    const t = (e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 100);
    return {
      tag: sec.tagName, textLines: sec.innerText.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 80),
      buttons: [...sec.querySelectorAll("button")].map((b) => ({ text: t(b), expanded: b.getAttribute("aria-expanded") })),
      links: [...sec.querySelectorAll("a")].map(t),
    };
  });
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
