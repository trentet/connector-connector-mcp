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
});
