import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "patchright";
import { dismissInterstitials } from "../src/adapters/grok.js";

// Fixture of the grok.com/connectors UI as seen 2026-10-16: the page itself is a dialog, and a "Meet your Bot" modal on top makes it inert
// (aria-hidden), so "New Connector" has no accessible button until the modal is closed.
const PAGE = (modal: "esc" | "button" | "none") => `<!doctype html><body>
<div id="app" role="dialog"><button aria-label="New Connector">New Connector Skill Bot</button></div>
${modal === "none" ? "" : `<div id="m" role="dialog" aria-modal="true"><h2>Meet your Bot</h2><p>Same Bots, same work, synced.</p><button id="go">Let’s go</button></div>
<script>
  document.getElementById("app").setAttribute("aria-hidden","true");
  const close = () => { document.getElementById("m").remove(); document.getElementById("app").removeAttribute("aria-hidden"); };
  document.getElementById("go").onclick = close;
  ${modal === "esc" ? 'addEventListener("keydown", (e) => e.key === "Escape" && close());' : ""}
</script>`}</body>`;

const CHROME = process.env.CC_TEST_CHROME ?? (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] }); }, 60000);
afterAll(async () => { await browser?.close(); });

async function open(modal: "esc" | "button" | "none"): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(PAGE(modal));
  return page;
}

describe("grok interstitial dismissal (UI captured live 2026-10-16)", () => {
  it("the modal really hides the New Connector button until dismissed (fixture sanity)", async () => {
    const page = await open("esc");
    expect(await page.getByRole("button", { name: /new connector/i }).count()).toBe(0);
    await page.close();
  });
  it("closes the modal with Escape and exposes the button", async () => {
    const page = await open("esc");
    expect(await dismissInterstitials(page)).toBe(1);
    expect(await page.getByRole("button", { name: /new connector/i }).count()).toBe(1);
    await page.close();
  });
  it("falls back to the modal's own button when Escape does nothing", async () => {
    const page = await open("button");
    expect(await dismissInterstitials(page)).toBe(1);
    expect(await page.getByRole("button", { name: /new connector/i }).count()).toBe(1);
    await page.close();
  });
  it("does nothing when no modal is present", async () => {
    const page = await open("none");
    expect(await dismissInterstitials(page)).toBe(0);
    await page.close();
  });
});
