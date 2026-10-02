import fs from "node:fs";
import path from "node:path";

export interface AuditHit { file: string; reasons: string[] }

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "logs", "browser-profile", "artifacts", ".next", "coverage"]);
const CODE_EXT = /\.(mjs|cjs|js|ts|ps1|py|bat|cmd|sh)$/i;
const NAME_RX = /(register-?connectors?|chatgpt-register|register-?mcp|add-?connector)/i;
// Strong signatures of code that drives a platform's add-connector UI.
const SIGNATURES: [RegExp, string][] = [
  [/claude\.ai\/customize\/connectors/i, "drives claude.ai connector UI"],
  [/add-custom-connector/i, "claude.ai add-custom-connector flow"],
  [/chatgpt\.com\/plugins/i, "drives ChatGPT plugins UI"],
  [/Create MCP App/i, "ChatGPT 'Create MCP App' flow"],
  [/grok\.com\/connectors/i, "drives grok.com connectors UI"],
];

/** Find files in `root` that look like per-repo connector registration scripts (which cc replaces). */
export function audit(root: string, maxFiles = 20000): AuditHit[] {
  const hits: AuditHit[] = [];
  let seen = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen > maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!e.isFile() || !CODE_EXT.test(e.name)) continue;
      seen++;
      const reasons: string[] = [];
      if (NAME_RX.test(e.name) || NAME_RX.test(path.basename(dir))) reasons.push("file/folder name looks like a registrar");
      try {
        if (fs.statSync(full).size <= 2_000_000) {
          const text = fs.readFileSync(full, "utf8");
          for (const [rx, why] of SIGNATURES) if (rx.test(text)) reasons.push(why);
        }
      } catch { /* unreadable: skip */ }
      if (reasons.length) hits.push({ file: full, reasons: [...new Set(reasons)] });
    }
  };
  walk(path.resolve(root));
  return hits;
}
