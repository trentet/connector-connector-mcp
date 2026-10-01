// Exploratory: log in to ChatGPT via "Continue with Google" using the vault Google credential (in-process).
// Snapshots every step (redacted). STOPS at any Google challenge (2FA/passkey/verify) and reports; never tries to bypass.
import { openSession, snapshot } from "../../dist/browser/chrome.js";
import { getCredential, waitForCredential, deleteCredential } from "../../dist/core/vaultClient.js";
import { Redactor } from "../../dist/core/redact.js";

const label = "Google Account (trenterrolthomas@gmail.com)";
const cred = await getCredential(label);
if (!cred?.password) { console.log(JSON.stringify({ error: "vault entry missing password", hasUsername: !!cred?.username })); process.exit(1); }
const email = cred.username || "trenterrolthomas@gmail.com";
const red = new Redactor(); red.add(cred.password); red.add(email);
const R = (x) => red.redact(x);
const out = []; const note = async (step, page) => out.push({ step, ...(await snapshot(page, R)) });
const s = await openSession();
let page = s.page;
try {
  await page.goto("https://chatgpt.com/auth/login", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  await note("chatgpt login page", page);
  const popupP = s.context.waitForEvent("page", { timeout: 6000 }).catch(() => null);
  await page.getByRole("button", { name: /continue with google/i }).first().click();
  const popup = await popupP;
  if (popup) { page = popup; out.push({ note: "google opened in a popup" }); }
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3500);
  await note("after Continue with Google", page);
  const chooser = page.getByText(email, { exact: false }).first();
  if (page.url().includes("accounts.google.com")) {
    if (await page.locator('input[type=email]').count()) {
      await page.locator('input[type=email]').fill(email);
      await page.getByRole("button", { name: /^next$/i }).click();
      await page.waitForTimeout(3500);
      await note("after google email+next", page);
    } else if (await chooser.count()) { await chooser.click(); await page.waitForTimeout(3500); await note("after account chooser click", page); }
    if (await page.locator('input[type=password]').count()) {
      await page.locator('input[type=password]').first().fill(cred.password);
      await page.getByRole("button", { name: /^next$/i }).click();
      await page.waitForTimeout(6000);
      await note("after google password+next", page);
    }
  }
  // OpenAI SMS challenge: wait for the operator to submit the code into the vault (one-time entry), enter it, delete it.
  if (/mfa-challenge/.test(page.url()) || (await page.locator('input[name=code]').count())) {
    out.push({ note: "SMS challenge reached; waiting up to 10 min for vault entry 'ChatGPT SMS code'" });
    const c = await waitForCredential("ChatGPT SMS code", 10 * 60 * 1000);
    if (!c) throw new Error("timed out waiting for vault entry 'ChatGPT SMS code'");
    const code = (c.password || c.username || "").replace(/\D/g, "");
    red.add(code);
    await page.locator('input[name=code]').fill(code);
    await page.getByRole("button", { name: /^continue$/i }).click();
    await deleteCredential("ChatGPT SMS code").catch(() => {});
    await page.waitForTimeout(7000);
    await note("after SMS code", page);
  }
  await page.waitForTimeout(3000);
  const finalPage = s.context.pages().find((p) => /chatgpt\.com/.test(p.url())) ?? page;
  await note("final", finalPage);
  if (/chatgpt\.com/.test(finalPage.url())) {
    await finalPage.goto("https://chatgpt.com/plugins", { waitUntil: "domcontentloaded" });
    await finalPage.waitForTimeout(4000);
    const hits = await finalPage.evaluate(() => [...document.querySelectorAll("button,a,[role=button],[role=menuitem]")].map((e) => (e.getAttribute("aria-label") || e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60)).filter((t) => /plugin|connector|custom|create|add|developer|mcp|settings|apps/i.test(t)).slice(0, 25));
    out.push({ step: "plugins page (filtered controls only)", url: finalPage.url(), hits });
  }
} catch (e) { out.push({ error: R(String(e.message).split("\n")[0]) }); }
finally { await s.close(); }
console.log(R(JSON.stringify(out, null, 1)));
