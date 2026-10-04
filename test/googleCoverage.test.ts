import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { coverage, formatReport, repoFromOrigin, scanGithub, scanLocal, verdict, type GhRun } from "../src/googleCoverage.js";
import { loadRegistry, validateRegistry } from "../src/core/registry.js";
import type { Registry } from "../src/core/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-gcov-"));
const put = (root: string, rel: string, body: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
/** A fake git checkout: a folder with .git/config naming its origin. */
const checkout = (root: string, name: string, origin: string, files: Record<string, string>) => {
  put(root, `${name}/.git/config`, `[remote "origin"]\n\turl = ${origin}\n`);
  for (const [k, v] of Object.entries(files)) put(root, `${name}/${k}`, v);
};
const googleAuthTs = "import { google } from 'googleapis'; const t = fs.readFileSync('token.json'); const c = 'credentials.json'; // refresh_token";

const entry = (id: string, repo: string | undefined, google: boolean) => ({
  id, name: id, ...(repo ? { repo } : {}), url: { type: "literal" as const, value: "https://x.example/mcp" }, auth: { mode: "none" as const }, platforms: ["claude" as const],
  ...(google ? { googleOAuth: { secretsDir: "C:\\s", scopes: ["https://www.googleapis.com/auth/drive"], account: { vaultLabel: "acct" } } } : {}),
});
const reg = (over: Partial<Registry> = {}, ...cs: ReturnType<typeof entry>[]): Registry => ({ version: 1, connectors: cs as never, ...over });

describe("verdict", () => {
  it("a Google client library in a manifest is proof; generic OAuth words alone are only 'maybe'; nothing is none", () => {
    expect(verdict({ manifestTerms: ["googleapis"], sourceTerms: [] })).toBe("uses-google");
    expect(verdict({ manifestTerms: ["google-auth-library"], sourceTerms: [] })).toBe("uses-google");
    expect(verdict({ manifestTerms: [], sourceTerms: ["token.json", "credentials.json", "refresh_token"] })).toBe("uses-google");
    expect(verdict({ manifestTerms: [], sourceTerms: ["refresh_token"] })).toBe("maybe");
    expect(verdict({ manifestTerms: [], sourceTerms: ["client_secret", "GOOGLE_CLIENT"] })).toBe("maybe");
    expect(verdict({ manifestTerms: [], sourceTerms: [] })).toBe("none");
  });
  it("origin URLs in https and ssh form give owner/name", () => {
    expect(repoFromOrigin("https://github.com/trentet/TT-MCP.git")).toBe("trentet/TT-MCP");
    expect(repoFromOrigin("git@github-helm-vision-mcp:trentet/helm-vision-mcp.git")).toBe("trentet/helm-vision-mcp");
    expect(repoFromOrigin("https://example.com/x")).toBeUndefined();
  });
});

describe("scanLocal", () => {
  it("finds checkouts, reads manifests and interesting sources, ignores node_modules", () => {
    const root = tmp();
    checkout(root, "a", "https://github.com/o/a.git", { "package.json": '{"dependencies":{"googleapis":"1"}}', "src/auth.ts": googleAuthTs, "node_modules/googleapis/index.js": "googleapis" });
    checkout(root, "b", "https://github.com/o/b.git", { "package.json": '{"dependencies":{"express":"1"}}', "src/server.ts": "export {}" });
    const f = scanLocal([root]);
    expect(f.map((x) => x.repo).sort()).toEqual(["o/a", "o/b"]);
    const a = f.find((x) => x.repo === "o/a")!;
    expect(a.manifestTerms).toContain("googleapis"); expect(a.files.some((p) => p.includes("node_modules"))).toBe(false);
    expect(verdict(f.find((x) => x.repo === "o/b")!)).toBe("none");
  });
});

describe("scanGithub (fake gh)", () => {
  it("lists repos, skips archived, reads trees and files through the API", () => {
    const repos: Record<string, Record<string, string>> = { good: { "package.json": '{"x":"google-auth-library"}' }, plain: { "package.json": "{}" }, old: { "package.json": "googleapis" } };
    const gh: GhRun = (args) => {
      if (args[0] === "repo") return { ok: true, out: JSON.stringify([{ name: "good", isArchived: false }, { name: "plain", isArchived: false }, { name: "old", isArchived: true }]) };
      const url = args.find((a) => a.startsWith("repos/"))!;       // repos/<owner>/<name>/git/trees/HEAD?... or repos/<owner>/<name>/contents/<path>
      const [, , name, kind, ...rest] = url.split("/");
      if (kind === "git") return { ok: true, out: Object.entries(repos[name]).map(([p, c]) => `${p}\t${c.length}`).join("\n") };
      return { ok: true, out: repos[name][decodeURIComponent(rest.join("/"))] };
    };
    const { findings, errors } = scanGithub("o", gh);
    expect(errors).toEqual([]);
    expect(findings.map((f) => f.repo).sort()).toEqual(["o/good", "o/plain"]); // archived "old" skipped
    expect(verdict(findings.find((f) => f.repo === "o/good")!)).toBe("uses-google");
  });
  it("reports a gh failure instead of pretending everything is covered", () => {
    expect(scanGithub("o", () => ({ ok: false, out: "" })).errors[0]).toMatch(/could not list/);
  });
});

describe("coverage", () => {
  const f = (repo: string, manifestTerms: string[], sourceTerms: string[] = []) => ({ repo, manifestTerms, sourceTerms, files: ["package.json"] });
  it("splits repos into covered, uncovered, pending, exempt and review; only uncovered/problems fail", () => {
    const r = coverage(
      [f("o/drive", ["googleapis"]), f("o/vision", ["googleapis"]), f("o/new", ["google-auth-library"]), f("o/cc", ["googleapis"]), f("o/oauthsrv", [], ["refresh_token"]), f("o/plain", [])],
      reg({ googleOAuthExemptions: [{ repo: "o/vision", kind: "pending", reason: "not deployed yet, add the block when it is" }, { repo: "o/cc", kind: "exempt", reason: "it is the renewer itself" }] }, entry("drive", "o/drive", true), entry("other", "o/other", false)),
    );
    expect(r.covered).toEqual([{ repo: "o/drive", connectors: ["drive"] }]);
    expect(r.uncovered.map((x) => x.repo)).toEqual(["o/new"]);
    expect(r.pending.map((x) => x.repo)).toEqual(["o/vision"]);
    expect(r.exempt.map((x) => x.repo)).toEqual(["o/cc"]);
    expect(r.review.map((x) => x.repo)).toEqual(["o/oauthsrv"]);
    expect(formatReport(r).join("\n")).toMatch(/UNCOVERED {2}o\/new/);
  });
  it("matches repos case-insensitively and a bare folder name against owner/name", () => {
    const r = coverage([f("TT-MCP", ["googleapis"]), f("O/Drive", ["googleapis"])], reg({}, entry("a", "o/TT-MCP", true), entry("b", "o/drive", true)));
    expect(r.uncovered).toEqual([]); expect(r.covered).toHaveLength(2);
  });
  it("flags a stale exemption (a block now covers the repo) and a googleOAuth entry with no repo", () => {
    const r = coverage([f("o/drive", ["googleapis"])], reg({ googleOAuthExemptions: [{ repo: "o/drive", kind: "exempt", reason: "was exempt before it got a block" }] }, entry("drive", "o/drive", true), entry("norepo", undefined, true)));
    expect(r.problems.join("\n")).toMatch(/stale/); expect(r.problems.join("\n")).toMatch(/norepo.*no "repo"/);
  });
  it("notes (without failing) an exemption that matched nothing in the scan", () => {
    const r = coverage([f("o/plain", [])], reg({ googleOAuthExemptions: [{ repo: "o/gone", kind: "exempt", reason: "this repo was cleaned up already" }] }));
    expect(r.notes.join("\n")).toMatch(/o\/gone.*may be stale/); expect(r.uncovered).toEqual([]);
  });
});

describe("registry validation of the new fields", () => {
  it("googleOAuth needs repo; exemptions need repo, kind and a reason", () => {
    const bad = { version: 1, googleOAuthExemptions: [{ repo: "nope", kind: "maybe", reason: "x" }], connectors: [entry("g", undefined, true)] };
    const msg = validateRegistry(bad).errors.join("\n");
    expect(msg).toMatch(/repo: required when googleOAuth/); expect(msg).toMatch(/Exemptions\[0\]\.repo/); expect(msg).toMatch(/kind/); expect(msg).toMatch(/reason/);
  });
  it("every shipped googleOAuth entry names its repo, and every shipped exemption has a reason", () => {
    const r = loadRegistry(path.resolve("registry", "connectors.json"));
    for (const c of r.connectors.filter((x) => x.googleOAuth)) expect(c.repo, c.id).toBeTruthy();
    expect((r.googleOAuthExemptions ?? []).length).toBeGreaterThan(0);
  });
});

describe("cc audit --google (CLI)", () => {
  const run = async (args: string[]) => { const out: string[] = []; const orig = console.log; console.log = (...a: unknown[]) => { out.push(a.join(" ")); }; try { return { code: await main(args), out: out.join("\n") }; } finally { console.log = orig; } };
  it("exits 1 and names the uncovered repo; exits 0 once a registry entry covers it", async () => {
    const root = tmp();
    checkout(root, "vis", "https://github.com/o/vis.git", { "package.json": '{"dependencies":{"googleapis":"1"}}' });
    const regFile = path.join(root, "reg.json");
    fs.writeFileSync(regFile, JSON.stringify(reg({}, entry("x", "o/x", false))));
    const bad = await run(["audit", "--google", "--root", root, "--registry", regFile]);
    expect(bad.code).toBe(1); expect(bad.out).toMatch(/UNCOVERED {2}o\/vis/);
    fs.writeFileSync(regFile, JSON.stringify(reg({}, entry("vis", "o/vis", true))));
    const ok = await run(["audit", "--google", "--root", root, "--registry", regFile]);
    expect(ok.code).toBe(0); expect(ok.out).toMatch(/covered {4}o\/vis/);
  });
  it("needs a root or an owner", async () => {
    const err = console.error; console.error = () => {}; try { expect((await run(["audit", "--google"])).code).toBe(2); } finally { console.error = err; }
  });
});
