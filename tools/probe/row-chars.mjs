// Diagnostic: dump char codes of one claude.ai connector row to find invisible characters. Read-only.
import { openSession } from "../../dist/browser/chrome.js";
const s = await openSession();
try {
  await s.page.goto("https://claude.ai/customize/connectors/yours", { waitUntil: "domcontentloaded" });
  await s.page.waitForSelector("tr", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 5000));
  const rows = await s.page.$$eval("tr", (rs) => rs.map((r) => r.innerText));
  const nonAscii = new Set();
  for (const t of rows) for (const c of t) if (c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32) nonAscii.add(c.charCodeAt(0).toString(16));
  const pick = rows.find((t) => /^Gmail/.test(t)) ?? rows[2];
  console.log(JSON.stringify({ rowCount: rows.length, nonAsciiOrControlCodesSeen: [...nonAscii], sample: pick, sampleCodes: [...(pick ?? "")].map((c) => c.charCodeAt(0).toString(16)).join(" ") }, null, 1));
} finally { await s.close(); }
