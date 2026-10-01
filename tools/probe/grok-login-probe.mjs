// Exploratory: log in to grok.com with the vault credential; snapshot each step (redacted). No connector changes.
import fs from "node:fs";
import { openSession, snapshot } from "../../dist/browser/chrome.js";
import { getCredential } from "../../dist/core/vaultClient.js";
import { Redactor } from "../../dist/core/redact.js";

const sel = JSON.parse(fs.readFileSync("data/selectors/grok.json", "utf8"));
const label = "Grok (grok.com email login)";
const cred = await getCredential(label);
const red = new Redactor();
if (!cred?.username || !cred?.password) { console.log(JSON.stringify({ error: "vault entry missing username and/or password", hasUsername: !!cred?.username, hasPassword: !!cred?.password })); process.exit(1); }
red.add(cred.username); red.add(cred.password);
const R = (s) => red.redact(s);
const rx = (p) => new RegExp(p, "i");
const out = [];
const s = await openSession();
try {
  await s.page.goto(sel.signInUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await s.page.waitForTimeout(2500);
  const rej = s.page.getByRole(sel.login.rejectCookies.role, { name: rx(sel.login.rejectCookies.name) });
  if (await rej.count()) { await rej.first().click(); await s.page.waitForTimeout(500); }
  await s.page.locator(sel.login.emailInput).fill(cred.username);
  await s.page.getByRole(sel.login.next.role, { name: rx(sel.login.next.name) }).first().click();
  await s.page.waitForTimeout(3000);
  out.push({ step: "after email+next", ...(await snapshot(s.page, R)) });
  const pw = s.page.locator(sel.login.passwordInput);
  if (await pw.count()) {
    await pw.first().fill(cred.password);
    await s.page.getByRole(sel.login.submit.role, { name: rx(sel.login.submit.name) }).first().click();
    await s.page.waitForTimeout(6000);
    out.push({ step: "after password submit", ...(await snapshot(s.page, R)) });
  } else out.push({ note: "no password field appeared" });
} catch (e) { out.push({ error: R(String(e.message).split("\n")[0]) }); }
finally { await s.close(); }
console.log(R(JSON.stringify(out, null, 1)));
