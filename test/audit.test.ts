import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { audit } from "../src/audit.js";

describe("cc audit", () => {
  it("flags registrar look-alikes, ignores node_modules / browser-profile / unrelated code", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-audit-"));
    const w = (rel: string, body: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w("scripts/register-connector/register-connector.mjs", "const x = 1;");
    w("scripts/other.mjs", 'await page.goto("https://claude.ai/customize/connectors?modal=add-custom-connector");');
    w("tools/chatty.ts", 'goto("https://chatgpt.com/plugins"); click("Create MCP App")');
    w("src/index.ts", "export const hello = 'world';");
    w("node_modules/pkg/register-connector.js", "x");
    w("tools/browser-profile/Default/register-connector.js", "x");
    const hits = audit(root).map((h) => path.relative(root, h.file).replace(/\\/g, "/")).sort();
    expect(hits).toEqual(["scripts/other.mjs", "scripts/register-connector/register-connector.mjs", "tools/chatty.ts"]);
    expect(audit(root).find((h) => h.file.endsWith("chatty.ts"))!.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("flags Google OAuth renewal look-alikes (cc reauth replaces them), not ordinary OAuth client code", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-audit-"));
    const w = (rel: string, body: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
    w("scripts/weekly-reauth.ts", "export {};");
    w("scripts/renew-google-login.ps1", "# renew");
    w("scripts/consent-driver.ts", 'import { chromium } from "patchright"; await page.goto("https://accounts.google.com/o/oauth2/v2/auth?x=1");');
    w("src/auth.ts", "const client = new OAuth2Client({ clientId, clientSecret }); export const SCOPES = ['drive'];");
    w("scripts/unrelated.ts", "console.log('hi');");
    const hits = audit(root).map((h) => path.relative(root, h.file).replace(/\\/g, "/")).sort();
    expect(hits).toEqual(["scripts/consent-driver.ts", "scripts/renew-google-login.ps1", "scripts/weekly-reauth.ts"]);
    expect(audit(root).find((h) => h.file.endsWith("consent-driver.ts"))!.reasons.join(" ")).toMatch(/Google's OAuth consent screen/);
  });
});
