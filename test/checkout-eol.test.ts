import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// REQ-D016: the pinned hidden-launch check is checked out with its committed bytes whatever core.autocrlf a machine sets.
const CHECK = "scripts/check-hidden-launch.mjs";
const PIN = "scripts/check-hidden-launch.sha256";
const root = path.resolve(".");
const clones: string[] = [];
afterAll(() => { for (const c of clones) fs.rmSync(c, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); });
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
/** A fresh checkout of the committed tree with core.autocrlf=true (what the W540's global git setting does to every clone). */
function crlfClone(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-eol-")); clones.push(dir);
  const r = spawnSync("git", ["-c", "core.autocrlf=true", "clone", "--quiet", "--no-hardlinks", root, dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`clone failed: ${r.stderr}`);
  return dir;
}

describe("REQ-D016 pinned check checkout", () => {
  it("TC-D016-01 .gitattributes declares the pinned check file text with eol=lf", () => {
    const out = git("check-attr", "text", "eol", "--", CHECK);
    expect(out).toMatch(/: text: set/);
    expect(out).toMatch(/: eol: lf/);
  });
  it("TC-D016-02 a checkout with core.autocrlf=true holds the pinned bytes", () => {
    const dir = crlfClone();
    const want = fs.readFileSync(path.join(dir, PIN), "utf8").match(/\b[0-9a-f]{64}\b/i)![0].toLowerCase();
    const have = createHash("sha256").update(fs.readFileSync(path.join(dir, CHECK))).digest("hex");
    expect(have).toBe(want);
  });
  it("TC-D016-03 the pinned check passes in that checkout", () => {
    const dir = crlfClone();
    const r = spawnSync(process.execPath, [CHECK, "--pinned", PIN, "."], { cwd: dir, encoding: "utf8" });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });
});