// Throwaway-only: open the "More actions" menu of an Installed plugin and list its items. Clicks nothing destructive.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
if (!/^cc-selftest/.test(name)) { console.error("refusing: throwaway only"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2500));
  out.chain = await page.evaluate((n) => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => e.innerText.trim() === "Installed");
    const sec = hd.closest("section") ?? hd.parentElement.parentElement;
    const hit = [...sec.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.innerText?.trim() === n)[0];
    if (!hit) return "no leaf element with exact text in Installed section";
    const rows = [];
    for (let a = hit, i = 0; a && i < 8; a = a.parentElement, i++) {
      rows.push({ level: i, tag: a.tagName.toLowerCase(), role: a.getAttribute("role"), textLen: (a.innerText || "").length, buttons: [...a.querySelectorAll("button,[role=button]")].map((b) => b.getAttribute("aria-label") || (b.innerText || "").trim().slice(0, 25)).slice(0, 6) });
    }
    return rows;
  }, name);
  out.tagged = await page.evaluate((n) => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => e.innerText.trim() === "Installed");
    const sec = hd.closest("section") ?? hd.parentElement.parentElement;
    const hit = [...sec.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.innerText?.trim() === n)[0];
    for (let a = hit, i = 0; a && i < 8; a = a.parentElement, i++) {
      const mores = a.querySelectorAll('button[aria-label="More actions"]');
      if (mores.length === 1) { mores[0].setAttribute("data-cc-target", "1"); return { tag: a.tagName.toLowerCase(), level: i }; }
    }
    return null;
  }, name);
  if (out.tagged) {
    await page.locator('[data-cc-target="1"]').click();
    await new Promise((r) => setTimeout(r, 1200));
    out.menu = await page.evaluate(() => [...document.querySelectorAll("[role=menu] [role=menuitem],[role=menuitem]")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => e.innerText.trim().replace(/\s+/g, " ")));
    await page.keyboard.press("Escape");
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
