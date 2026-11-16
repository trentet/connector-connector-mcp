// Read-only: opens chatgpt.com/settings/plugins-settings and describes how one plugin entry is built (tags, roles, the links and
// buttons inside an entry, link paths only) for the named plugins, so the full Installed list can be read from it. Clicks nothing.
// Usage: node tools/probe/chatgpt-plugins-settings-probe.mjs "Vault MCP" "DSM Connect"
import { openSession } from "../../dist/browser/chrome.js";
const names = process.argv.slice(2);
if (!names.length) { console.error("usage: <plugin name> ..."); process.exit(2); }
const s = await openSession();
const page = s.page;
const out = {};
const clean = (t) => t.replace(/\?[^\s"'<>]*/g, "?<redacted>");
try {
  await page.goto("https://chatgpt.com/settings/plugins-settings", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => /Search installed plugins/i.test(document.body.innerText), null, { timeout: 25000, polling: 500 });
  await new Promise((r) => setTimeout(r, 3500));
  out.entries = await page.evaluate((wanted) => {
    const res = [];
    for (const n of wanted) {
      const hit = [...document.querySelectorAll("main *, [role=dialog] *")].filter((e) => e.children.length === 0 && (e.textContent || "").trim() === n)[0];
      if (!hit) { res.push({ name: n, found: false }); continue; }
      const chain = [];
      let e = hit;
      for (let i = 0; i < 6 && e; i++, e = e.parentElement) chain.push({ tag: e.tagName, role: e.getAttribute("role"), childCount: e.children.length, textLines: e.innerText.split("\n").filter(Boolean).length });
      // the smallest ancestor that holds the permission line is the entry
      let entry = hit;
      while (entry && !/allow (all|low-risk) tools/i.test(entry.innerText || "")) entry = entry.parentElement;
      res.push({
        name: n, found: true, chain,
        entryTag: entry && entry.tagName, entryRole: entry && entry.getAttribute("role"),
        entryLines: entry && entry.innerText.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.slice(0, 50)),
        links: entry && [...entry.querySelectorAll("a")].map((a) => (a.getAttribute("href") || "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").split("?")[0]),
        buttons: entry && [...entry.querySelectorAll("button,[role=combobox],[role=button]")].map((b) => ((b.getAttribute("aria-label") || b.innerText || "").trim().replace(/\s+/g, " ")).slice(0, 60)),
        entryClickable: entry && (entry.tagName === "A" || entry.getAttribute("role") === "link" || entry.getAttribute("tabindex") !== null),
      });
    }
    return res;
  }, names);
  out.allNames = await page.evaluate(() => {
    const perm = [...document.querySelectorAll("main *")].filter((e) => e.children.length === 0 && /^allow (all|low-risk) tools$/i.test((e.textContent || "").trim()));
    return perm.length;
  });
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(clean(JSON.stringify(out, null, 1)));
