#!/usr/bin/env node
// Connector independence check (operator requirement, 2026-11-28 02:24:13Z, rules channel):
// "Every single connector is intended to be independent unless I explicitly say otherwise ...
//  We can have information in the documentation that dictate what a connector is used for,
//  but it must never dictate how other connectors are expected to be used unless again I
//  explicitly override that request."
// Fails when any tracked file in this repository names another connector, except entries in
// connector-independence.json "allow" (each one held for the operator's decision, with its reason).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CONNECTORS = {
  shell: String.raw`HELM[ -]?Shell|helm-shell|mcp__HELM_Shell|\bshell_exec\b|\bshell_job_\w+|helm-terminal-mcp|terminal-mcp`,
  relay: String.raw`HELM[ -]?Relay|helm-relay|mcp__HELM_Relay`,
  drive: String.raw`HELM[ -]Drive|TT-MCP|Drive Connector|helm-drive-mcp|helm-drive\b|mcp__HELM_Drive|\bhelm_read_document\b|\bhelm_upload_\w+|\bhelm_download_file\b|\bhelm_search_files\b`,
  patchright: String.raw`patchright-mcp|Patchright[ _]MCP|Patchright connector|\bbrowser_open_session\b`,
  vault: String.raw`vault-mcp|Vault[ _]MCP|Vault connector|\bvault_request_\w+|\bvault_list_refs\b|\bvault_get_\w+`,
  dsm: String.raw`dsm-connect|DSM[ _]Connect|dsm-mcp`,
  cc: String.raw`connector-connector|\bcc's\b|\(cc\)|\bcc (?:reauth|add|verify|run|signin)\b|cc-mcp|Connector[ _]Connector|\bcc_run\b|\bcc_signin\b`,
  desktop: String.raw`helm-desktop-control|Desktop[ _]Control`,
  fleet: String.raw`fleet-connect|Fleet[ _]Connect|\bfleet_install_\w+|\bfleet_bootstrap_target\b`,
  monitor: String.raw`helm-thread-monitor|Thread[ _]Monitor|\bmonitor_threads\b|\bmonitor_claim\b`,
  esxi: String.raw`helm-esxi-mcp|ESXi[ _]MCP|ESXi connector`,
  roku: String.raw`roku-mcp|Roku[ _]MCP|Roku connector`,
  audio: String.raw`helm-audio-mcp|Audio Connector|\bhelm_transcribe_audio\b`,
  vision: String.raw`helm-vision-mcp|Vision Connector|\bhelm_read_document_image\b`,
  mail: String.raw`helm-mail-mcp|HELM Mail`,
  arr: String.raw`arr-mcp-connector|arr-mcp|arr connector`,
  itops: String.raw`itops-connect|ITOps[ _]Connect`,
  hub: String.raw`helm-fleet-hub-mcp|fleet hub|fleet-hub`,
  chrome: String.raw`Claude in Chrome|claude-in-chrome`,
  zapier: String.raw`\bZapier\b`,
};
const SKIP = /(^|\/)(package-lock\.json|node_modules\/)|\.(png|jpe?g|gif|ico|lock|pdf|zip|woff2?|exe|dll)$/i;

const cfg = JSON.parse(readFileSync("connector-independence.json", "utf8"));
const self = new Set(cfg.self);
const allow = cfg.allow ?? [];
const files = execFileSync("git", ["ls-files"], { encoding: "utf8", windowsHide: true }).split("\n").filter(Boolean);
const found = [];
for (const f of files) {
  if (SKIP.test(f) || f === "connector-independence.json" || f.endsWith("check-connector-independence.mjs")) continue;
  let text;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    for (const [name, rx] of Object.entries(CONNECTORS)) {
      if (self.has(name) || !new RegExp(rx, "i").test(line)) continue;
      if (allow.some((a) => a.file === f && (!a.contains || line.includes(a.contains)))) continue;
      found.push(`${f}:${i + 1} names ${name}: ${line.trim().slice(0, 160)}`);
    }
  });
}
if (found.length) {
  console.error(`check-connector-independence: ${found.length} line(s) name another connector:\n` + found.join("\n"));
  process.exit(1);
}
console.log(`check-connector-independence: ok (${files.length} files; ${allow.length} held entr${allow.length === 1 ? "y" : "ies"})`);
