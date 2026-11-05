#!/usr/bin/env node
// Read-only, scoped ChatGPT plugin detail survey. Refs #83.
// No page text, secrets, chats, or tokenized URLs appear in output.
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { openSession, masterDir } from '../dist/browser/chrome.js';
import { accountMaster, loadAccounts, pickAccount } from '../dist/core/accounts.js';

const id = process.argv[2];
const registry = JSON.parse(readFileSync('registry/connectors.json', 'utf8'));
const target = registry.connectors.find((c) => c.id === id);
if (!target) { console.error('unknown registry connector id'); process.exit(2); }
const name = target.name;
const acc = pickAccount(loadAccounts(), 'main');
const session = await openSession({ master: accountMaster(acc, masterDir()) });
let code = 0;
try {
  await session.page.goto('https://chatgpt.com/plugins', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await session.page.waitForTimeout(5000);
  const landing = new URL(session.page.url()); console.log("LANDING "+JSON.stringify({host:landing.hostname,path:landing.pathname,title:(await session.page.title()).slice(0,80)}));
  if (landing.hostname === "chatgpt.com" && landing.pathname === "/auth/login") {
    const out = path.join(process.env.PROGRAMDATA || "C:/ProgramData", "HELM", "logs", "cc-refresh-issue83");
    mkdirSync(out, { recursive: true });
    const file = path.join(out, "login-required-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
    await session.page.screenshot({ path: file }).catch(() => {});
    console.log("AUTH_BLOCK_SCREENSHOT " + file);
  }
  const listing = await session.page.evaluate((name) => {
    if (location.hostname !== 'chatgpt.com' || !location.pathname.startsWith('/plugins')) return { signedIn: false, reason: 'wrong-origin' };
    const main = document.querySelector('main');
    if (!main) return { signedIn: false, reason: 'no-main' };
    const links = [...main.querySelectorAll('a')];
    const matches = links.filter((e) => e.innerText.trim().split('\n').map(x=>x.trim()).some(x => x === name));
    const namedHeadings = [...main.querySelectorAll('h1,h2,h3,[role=heading]')].map(e => e.textContent?.trim().slice(0, 60)).filter(Boolean);
    return { signedIn: true, matched: matches.length, paths: matches.map(x=>new URL(x.href).pathname), headings: namedHeadings.slice(0, 15) };
  }, name);
  console.log('LISTING '+JSON.stringify(listing));
  if (!listing.signedIn || listing.matched !== 1 || !listing.paths[0].startsWith('/plugins/')) {
    code = 3;
  } else {
    await session.page.goto('https://chatgpt.com'+listing.paths[0], { waitUntil: 'domcontentloaded', timeout: 45000 });
    await session.page.waitForTimeout(3000);
    const detail = await session.page.evaluate((name) => {
      if (location.hostname !== 'chatgpt.com' || !location.pathname.startsWith('/plugins/')) return { reason: 'wrong-origin' };
      const main = document.querySelector('main');
      if (!main) return { reason: 'no-main' };
      const headings=[...main.querySelectorAll('h1,h2,h3,[role=heading]')].map(e => e.innerText?.trim().slice(0, 80)).filter(Boolean);
      const buttons=[...main.querySelectorAll('button,[role=button],a,[role=menuitem]')].map(e => ({tag:e.tagName, role:e.getAttribute('role'),label:(e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\s+/g,' ').slice(0,80)})).filter(x=>x.label);
      return { nameSeen:headings.includes(name), headings:headings.slice(0,20), controls:buttons.slice(0,45), path:location.pathname };
    }, name);
    console.log('DETAIL '+JSON.stringify(detail));
  }
} catch (e) {
  console.error('SURVEY_FAILURE '+String(e.message || e).split('\n')[0].slice(0,300));
  code=1;
} finally {
  await session.close().catch(()=>{});
}
process.exitCode=code;
