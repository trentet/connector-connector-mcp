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
  out.tagged = await page.evaluate((n) => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => e.innerText.trim() === "Installed");
    const sec = hd.closest("section") ?? hd.parentElement.parentElement;
    for (const e of sec.querySelectorAll("button,a,li,[role=listitem],div")) {
      if (((e.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0]) !== n) continue;
      for (let a = e, i = 0; a && i < 5; a = a.parentElement, i++) {
        const more = a.querySelector('button[aria-label="More actions"]');
        if (more && a.querySelectorAll('button[aria-label="More actions"]').length === 1) { more.setAttribute("data-cc-target", "1"); return { tag: a.tagName.toLowerCase(), level: i }; }
      }
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
