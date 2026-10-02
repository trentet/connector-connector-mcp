// Read-only: find how claude.ai renders the user's connector list (names + status only).
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
const out = {};
try {
  for (const url of ["https://claude.ai/customize/connectors/yours", "https://claude.ai/customize/connectors"]) {
    await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await s.page.waitForTimeout(4000);
    out[url] = await s.page.evaluate(() => {
      const clip = (t) => (t || "").trim().replace(/\s+/g, " ").slice(0, 90);
      const rows = [...document.querySelectorAll("tr")].map((r) => clip(r.innerText));
      const roleRows = [...document.querySelectorAll('[role=row],[role=listitem]')].map((r) => clip(r.innerText)).slice(0, 40);
      const headings = [...document.querySelectorAll("h1,h2,h3")].map((h) => clip(h.innerText)).slice(0, 15);
      const tabs = [...document.querySelectorAll('[role=tab],a')].map((a) => clip(a.innerText)).filter((t) => /yours|discover|connectors|skills|plugins/i.test(t)).slice(0, 10);
      return { finalUrl: location.pathname, headings, tabs, trCount: rows.length, tr: rows.slice(0, 40), roleRowCount: roleRows.length, roleRows: roleRows.slice(0, 25) };
    });
  }
} catch (e) { out.error = String(e.message).split("\n")[0]; }
finally { await s.close(); }
console.log(JSON.stringify(out, null, 1));
