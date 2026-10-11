import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRegistry } from "../src/core/registry.js";

const google = { secretsDir: "/s", scopes: ["https://www.googleapis.com/auth/drive"], account: { vaultLabel: "Google Account" } };
const robot = (over: Record<string, unknown> = {}) => ({ id: "robot", name: "Robot", repo: "o/robot", auth: { mode: "none" }, googleOAuth: google, ...over });
const errors = (c: unknown) => validateRegistry({ version: 1, connectors: [c] }).errors.join("\n");

describe("Google-only registry entries (#44)", () => {
  it("accepts a googleOAuth entry with platforms absent and normalises it to []", () => {
    const { registry, errors: e } = validateRegistry({ version: 1, connectors: [robot()] });
    expect(e).toEqual([]);
    expect(registry!.connectors[0].platforms).toEqual([]);
  });
  it("still accepts an explicit [] and no url", () => {
    expect(errors(robot({ platforms: [] }))).toBe("");
  });
  it("platforms absent WITHOUT googleOAuth is still an error", () => {
    expect(errors(robot({ googleOAuth: undefined }))).toMatch(/platforms must be a non-empty subset/);
  });
  it("a non-Google-only entry without url gets an explicit 'url required' message", () => {
    expect(errors(robot({ googleOAuth: undefined, platforms: ["claude"] }))).toMatch(/\.url: required/);
    expect(errors(robot({ platforms: ["claude"] }))).toMatch(/\.url: required/);
  });
  it("a Google-only entry may still carry a url, which is then checked", () => {
    expect(errors(robot({ platforms: [], url: { type: "bogus" } }))).toMatch(/invalid source type/);
  });
});

describe("reauth script input checks (#44)", () => {
  const install = fs.readFileSync("scripts/install-reauth-task.ps1", "utf8");
  const run = fs.readFileSync("scripts/run-reauth.ps1", "utf8");
  const pattern = (src: string, param: string): RegExp => {
    const m = new RegExp(`ValidatePattern\\('([^']+)'\\)\\]\\[string\\]\\$${param}\\b`).exec(src);
    if (!m) throw new Error(`no ValidatePattern on $${param}`);
    return new RegExp(m[1]);
  };

  it("-DaysInterval is limited to 1..6 (never past Google's 7-day limit) and the age limit to 0..6", () => {
    expect(install).toMatch(/\[ValidateRange\(1, 6\)\]\[int\]\$DaysInterval = 5/);
    expect(install).toMatch(/\[ValidateRange\(0, 6\)\]\[double\]\$OnlyIfOlderThanDays = 0/);
    expect(run).toMatch(/\[ValidateRange\(0, 6\)\]\[double\]\$OnlyIfOlderThanDays = 0/);
  });
  it("the deployed parameter names are unchanged", () => {
    for (const n of ["Connectors", "OnlyIfOlderThanDays", "SkipCoverage", "DaysInterval", "TaskName"]) expect(install).toContain(`$${n}`);
    for (const n of ["Connectors", "OnlyIfOlderThanDays", "SkipCoverage"]) expect(run).toContain(`$${n}`);
    for (const wrong of ["$Ids", "$SkipCoverageCheck", "$IntervalDays"]) { expect(install).not.toContain(wrong); expect(run).not.toContain(wrong); }
  });
  it("-Connectors takes only kebab-case ids (comma or space separated), nothing that could reach a command line", () => {
    for (const src of [install, run]) {
      const re = pattern(src, "Connectors");
      for (const ok of ["", "robot", "a-b,c-d", "a-b, c1", "a b"]) expect(re.test(ok), ok).toBe(true);
      for (const bad of ["a;b", "a\"b", "$(x)", "a`b", "-a", "A", "a&b", "a|b", "a'b", "a\nb"]) expect(re.test(bad), bad).toBe(false);
    }
  });
  it("-TaskName takes letters, digits, space and ()._- only", () => {
    const re = pattern(install, "TaskName");
    for (const ok of ["cc-mcp Google Reauth", "cc-mcp Google Reauth (second)"]) expect(re.test(ok), ok).toBe(true);
    for (const bad of ["", " x", "a\"b", "a;b", "a/b", "a\\b", "x".repeat(81)]) expect(re.test(bad), bad).toBe(false);
  });
});
