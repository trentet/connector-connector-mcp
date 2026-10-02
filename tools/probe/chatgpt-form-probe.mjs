// Read-only: open ChatGPT's Add > Create MCP App form and describe every control in it. Submits nothing.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const page = s.page;
const out = {};
try {
  await page.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
  const add = page.getByRole("button", { name: /^add$/i }).first();
  await add.waitFor({ timeout: 20000 });
  await add.click();
  await page.getByRole("menuitem", { name: /create mcp app/i }).first().click();
  await page.getByRole("dialog").filter({ hasText: /new plugin/i }).first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));
  out.dialog = await page.evaluate(() => {
    const c = (t) => (t || "").trim().replace(/[-]/g, "").replace(/\s+/g, " ");
    const d = [...document.querySelectorAll("[role=dialog]")].find((e) => /new plugin/i.test(e.innerText));
    const vis = (e) => e.offsetWidth || e.offsetHeight;
    const label = (e) => c(e.getAttribute("aria-label") || (e.id && document.querySelector(`label[for="${e.id}"]`)?.innerText) || e.getAttribute("placeholder") || e.closest("label")?.innerText || e.innerText).slice(0, 60);
    return {
      text: c(d.innerText).slice(0, 700),
      controls: [...d.querySelectorAll("input,textarea,select,button,[role=combobox],[role=checkbox],[role=switch],[role=radio],[role=tab],[role=option]")].filter(vis).map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), type: e.getAttribute("type"), label: label(e), required: e.hasAttribute("required") || undefined, disabled: e.disabled || e.getAttribute("aria-disabled") === "true" || undefined })),
    };
  });
  await page.keyboard.press("Escape");
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
