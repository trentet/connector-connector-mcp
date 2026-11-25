// @reqs REQ-D013
// REQ-D013 AC2: scripts/run-reauth.ps1 is RUN (real PowerShell) against a stub in place of cc, not read as text: the log line, the --run-failed flag and the
// exit codes are checked for the four situations of the run. Windows only (the script is PowerShell for the scheduled task).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "..", "scripts", "run-reauth.ps1");

const STUB = `import fs from "node:fs";
import path from "node:path";
import url from "node:url";
const here = path.dirname(url.fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(here, "stub-config.json"), "utf8"));
const a = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.log"), a.join(" ") + "\\n");
const kind = a[0] === "audit" ? "audit" : a.includes("--status") ? "status" : "reauth";
console.log("stub " + kind);
process.exit(cfg[kind]);
`;

interface Run { exit: number | null; stdout: string; stderr: string; calls: string[]; log: string }

/** Runs run-reauth.ps1 for real with a fake LOCALAPPDATA that holds a stub bin\cc.mjs (unless deployed is false); `codes` are the exit codes the stub returns. */
function runScript(codes: { reauth: number; audit: number; status: number }, deployed = true): Run {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-run-reauth-"));
  const base = path.join(root, "HELM", "connector-connector-mcp");
  const bin = path.join(base, "deploy", "production", "bin");
  fs.mkdirSync(bin, { recursive: true });
  if (deployed) {
    fs.writeFileSync(path.join(bin, "cc.mjs"), STUB);
    fs.writeFileSync(path.join(bin, "stub-config.json"), JSON.stringify(codes));
  }
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Environment", "production"], {
    encoding: "utf8", windowsHide: true, timeout: 90_000, env: { ...process.env, LOCALAPPDATA: root, CC_CHROME_DESKTOP: "own" },
  });
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, calls: read(path.join(bin, "calls.log")).split(/\r?\n/).filter(Boolean), log: read(path.join(base, "logs", "scheduled-reauth.log")) };
}

describe.skipIf(process.platform !== "win32")("REQ-D013 run-reauth.ps1 run for real with a stub in place of cc", () => {
  it("TC-D013-09 renewal fine: the finished line is logged with exit 0, the status call has no --run-failed, exit 0, no PowerShell error", () => {
    const r = runScript({ reauth: 0, audit: 0, status: 0 });
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(0);
    expect(r.log).toMatch(/=== scheduled cc reauth finished \(exit 0\) ===/);
    expect(r.calls).toEqual(["reauth --all", "audit --google --github trentet", "reauth --all --status"]);
  });
  it("TC-D013-10 renewal failed: the finished line carries exit 1, the status call has --run-failed, exit 1", () => {
    const r = runScript({ reauth: 1, audit: 0, status: 1 });
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(1);
    expect(r.log).toMatch(/=== scheduled cc reauth finished \(exit 1\) ===/);
    expect(r.calls).toContain("reauth --all --status --run-failed");
  });
  it("TC-D013-11 coverage gap only: exit 3, the status call has no --run-failed, the gap is logged", () => {
    const r = runScript({ reauth: 0, audit: 1, status: 0 });
    expect(r.stderr).toBe("");
    expect(r.exit).toBe(3);
    expect(r.log).toMatch(/=== scheduled cc reauth finished \(exit 0\) ===/);
    expect(r.log).toMatch(/GOOGLE COVERAGE GAP/);
    expect(r.calls).toContain("reauth --all --status");
    expect(r.calls.join("\n")).not.toMatch(/--run-failed/);
  });
  it("TC-D013-12 not deployed: exit 2, nothing is called", () => {
    const r = runScript({ reauth: 0, audit: 0, status: 0 }, false);
    expect(r.exit).toBe(2);
    expect(r.log).toMatch(/not deployed/);
    expect(r.calls).toEqual([]);
  });
});