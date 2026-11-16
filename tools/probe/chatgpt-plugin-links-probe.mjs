// Read-only: prints, for the plugin links of the Installed section on chatgpt.com/plugins and for the entries of
// chatgpt.com/settings/plugins-settings, the link path (id part shortened to its last 6 characters) next to the plugin name,
// so the two pages' ids can be compared. Clicks nothing.
// Usage: node tools/probe/chatgpt-plugin-links-probe.mjs
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
const short = (h) => (h || "").split("?")[0].replace(/(plugin_[a-z]+_[a-z]+_)([0-9a-f]+)/g, (_m, a, b) => a + "..." + b.slice(-6));
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000, polling: 500 });
  await new Promise((r) => setTimeout(r, 3000));
  out.pluginsPage = await page.evaluate(() => {
    const hd = [...document.querySelectorAll("h1,h2,h3,[role=heading]")].find((e) => e.innerText.trim() === "Installed");
    const sec = hd.closest("section") ?? hd.parentElement?.parentElement;
    return [...sec.querySelectorAll("a")].map((a) => ({ name: a.innerText.split("\n").map((l) => l.trim()).filter(Boolean)[0], href: a.getAttribute("href") }));
  });
  out.pluginsPage = out.pluginsPage.map((x) => ({ name: x.name, href: short(x.href) }));
  await page.goto("https://chatgpt.com/settings/plugins-settings", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => /Search installed plugins/i.test(document.body.innerText), null, { timeout: 25000, polling: 500 });
  await new Promise((r) => setTimeout(r, 3500));
  out.settingsPage = (await page.evaluate(() => [...document.querySelectorAll("a[href*='/settings/plugins-settings/']")].map((a) => ({ name: a.innerText.split("\n").map((l) => l.trim()).filter(Boolean)[0], href: a.getAttribute("href") })))).map((x) => ({ name: x.name, href: short(x.href) }));
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
