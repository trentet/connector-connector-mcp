// Throwaway-only: open an Installed plugin's own page and list controls that could remove it. Clicks nothing destructive.
import { openSession } from "../../dist/browser/chrome.js";
const name = process.argv[2] ?? "cc-selftest";
if (!/^cc-selftest/.test(name)) { console.error("refusing: throwaway only"); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
const surface = () => page.evaluate(() => {
  const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
  const vis = (e) => e.offsetWidth || e.offsetHeight;
  const re = /delete|remove|uninstall|disconnect|disable|manage|edit|settings|more|actions|configure|refresh|menu|options/i;
  return {
    url: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}|[A-Za-z0-9_-]{20,}/g, "<id>"),
    headings: [...document.querySelectorAll("h1,h2,h3")].filter(vis).map((h) => c(h.innerText)).filter(Boolean).slice(0, 8),
    controls: [...document.querySelectorAll("button,[role=button],[role=menuitem],a[role=button]")].filter(vis).map((b) => ({ t: c(b.getAttribute("aria-label") || b.innerText).slice(0, 40), popup: b.getAttribute("aria-haspopup") || undefined })).filter((x) => x.t && re.test(x.t) && !/Project actions|New chat in|Unpin|sidebar|Chat sidebar/i.test(x.t)).slice(0, 15),
    dialogs: [...document.querySelectorAll("[role=dialog],[role=alertdialog]")].filter(vis).map((d) => c(d.innerText).slice(0, 150)),
  };
});
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => [...document.querySelectorAll("h1,h2,h3,[role=heading]")].some((e) => e.innerText.trim() === "Installed"), null, { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2500));
  const link = page.locator("section a", { hasText: new RegExp("^\\s*" + name + "\\s*$") }).first();
  out.linkFound = (await link.count()) > 0;
  if (out.linkFound) {
    await link.click();
    await new Promise((r) => setTimeout(r, 3500));
    out.afterClick = await surface();
    const more = page.locator('button[aria-label="More actions"]');
    out.moreActionsCount = await more.count();
    if (out.moreActionsCount) {
      await more.last().click(); await new Promise((r) => setTimeout(r, 1200));
      out.menu = await page.evaluate(() => [...document.querySelectorAll("[role=menuitem]")].filter((e) => e.offsetWidth || e.offsetHeight).map((e) => e.innerText.trim().replace(/\s+/g, " ")));
      await page.keyboard.press("Escape");
    }
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
