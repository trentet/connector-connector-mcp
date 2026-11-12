// @reqs REQ-G001 REQ-G002
// The requirement gate: its own self-test (throwaway repositories, every refusal kind) and the static check of this
// repository's ledger, code, tools and tests.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const VENV = "C:/ProgramData/HELM/req-gate/venv/Scripts/python.exe";
const python = () => process.env.HELM_REQ_GATE_PYTHON || (existsSync(VENV) ? VENV : process.platform === "win32" ? "python" : "python3");
const run = (...args: string[]) => spawnSync(python(), args, { cwd: ROOT, encoding: "utf8" });

describe("REQ-G001 REQ-G002 requirement gate", () => {
  it("refuses every kind of gap in throwaway repositories", () => {
    const r = run(join("scripts", "req_gate_selftest.py"));
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120000);
  it("passes the static gate on this repository", () => {
    const r = run(join("scripts", "req_gate.py"), "static");
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 60000);
});
