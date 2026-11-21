// @reqs REQ-G003
// The check behind the cc/req-gate status (scripts/change-gate.mjs): traceability through req_gate.py, the full suite,
// changed-line coverage of at least 90%, and real passing tests for the test cases of added or changed requirements.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded at run time so that each test fails on its own while the module does not exist yet (spec-first, REQ-G003).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g: any = await import("../scripts/change-gate.mjs").catch(() => ({}));

type R = { status: number; stdout: string; stderr: string };
const ok = (stdout = ""): R => ({ status: 0, stdout, stderr: "" });
const MB = "a".repeat(40);
const HEAD = "b".repeat(40);
const ROOT = "C:\\work\\wt";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,0 +2,3 @@",
  "+x", "+y", "+z",
  "@@ -9 +12 @@",
  "-old", "+new",
  "@@ -20,2 +22,0 @@",
  "-gone", "-gone",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- /dev/null",
  "+++ b/src/b.ts",
  "@@ -0,0 +1,2 @@",
  "+a", "+b",
  "diff --git a/src/c.ts b/src/c.ts",
  "--- a/src/c.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-a", "-b",
].join("\n");

const covOf = (file: string, lines: number[], ran: number[]) => ({
  [file]: {
    path: file,
    statementMap: Object.fromEntries(lines.map((l, i) => [String(i), { start: { line: l, column: 0 }, end: { line: l, column: 9 } }])),
    s: Object.fromEntries(lines.map((l, i) => [String(i), ran.includes(l) ? 1 : 0])),
  },
});

const results = (tests: { file: string; title: string; status?: string }[], root = ROOT) => ({
  numTotalTests: tests.length,
  numPassedTests: tests.filter((t) => (t.status ?? "passed") === "passed").length,
  numFailedTests: tests.filter((t) => t.status === "failed").length,
  testResults: [...new Set(tests.map((t) => t.file))].map((f) => ({
    name: root === ROOT ? `${ROOT}\\${f.replace(/\//g, "\\")}` : join(root, f),
    status: tests.some((t) => t.file === f && t.status === "failed") ? "failed" : "passed",
    assertionResults: tests.filter((t) => t.file === f).map((t) => ({ title: t.title, fullName: `suite ${t.title}`, status: t.status ?? "passed" })),
  })),
});

const ledger = (reqs: unknown[]) => ({ requirements: reqs });
const req = (id: string, tcs: { id: string; test: string }[], text = "t") => ({ id, kind: "derived", status: "decided", text, test_cases: tcs });

/** A fake exec for runCheck: answers git and python, and writes vitest's JSON and coverage where vitest was told to. */
function fakeExec(o: { gate?: R; hidden?: R; vitestStatus?: number; vitestResults?: unknown; cov?: unknown; diff?: string; baseLedger?: unknown; headLedger?: unknown }) {
  const calls: { cmd: string; args: string[]; opts: { cwd?: string; input?: string } }[] = [];
  const exec = (cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): R => {
    calls.push({ cmd, args, opts });
    if (cmd === "git" && args[0] === "merge-base") return ok(MB + "\n");
    if (cmd === "git" && args[0] === "diff") return ok(o.diff ?? "");
    if (cmd === "git" && args[0] === "show") return o.baseLedger === undefined ? { status: 128, stdout: "", stderr: "no" } : ok("base");
    if (args.includes("pre-push")) return o.gate ?? ok("req_gate pre-push: OK");
    if (args[0] === "-c") return ok(JSON.stringify(opts.input === "base" ? o.baseLedger : o.headLedger ?? ledger([])));
    if (args[0] === "scripts/check-hidden-launch.mjs") return o.hidden ?? ok("nothing refused");
    if (String(args[0]).endsWith("vitest.mjs")) {
      const out = args.find((a) => a.startsWith("--outputFile.json="))!.split("=")[1];
      const dir = args.find((a) => a.startsWith("--coverage.reportsDirectory="))!.split("=")[1];
      if (o.vitestResults !== null) writeFileSync(out, JSON.stringify(o.vitestResults ?? results([{ file: "test/x.test.ts", title: "works" }])));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "coverage-final.json"), JSON.stringify(o.cov ?? {}));
      return { status: o.vitestStatus ?? 0, stdout: "Tests done", stderr: "" };
    }
    return ok();
  };
  return { exec, calls };
}

function repoDir(files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), "cg-repo-"));
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(d, p, ".."), { recursive: true }); writeFileSync(join(d, p), t); }
  return d;
}
const tmp = () => mkdtempSync(join(tmpdir(), "cg-tmp-"));

describe("REQ-G003 change gate", () => {
  it("TC-G003-01 runs the pinned req_gate.py pre-push in the head's worktree and a clean result adds no problem", () => {
    const repo = repoDir();
    const f = fakeExec({});
    const r = g.runCheck({ repo, base: "origin/main", head: HEAD, pinned: "/pinned", exec: f.exec, tmp: tmp(), py: "py" });
    const call = f.calls.find((c) => c.args.includes("pre-push"))!;
    expect(call.cmd).toBe("py");
    expect(call.args[0]).toBe(join("/pinned", "scripts", "req_gate.py"));
    expect(call.opts.cwd).toBe(repo);
    expect(r.problems.filter((p: string) => p.startsWith("traceability"))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("TC-G003-02 a req_gate.py refusal fails the check with its problem lines", () => {
    const f = fakeExec({ gate: { status: 1, stdout: "req_gate pre-push: REFUSED (2 problem(s))\n  - bbbbbbb: commit message cites no requirement id\n  - REQ-X: unknown\n", stderr: "" } });
    const r = g.runCheck({ repo: repoDir(), base: "origin/main", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("traceability: bbbbbbb: commit message cites no requirement id");
    expect(r.problems).toContain("traceability: REQ-X: unknown");
    expect(g.traceResult({ status: 2, out: "Traceback: boom" }).problems).toEqual(["traceability: Traceback: boom"]);
    expect(g.traceResult({ status: 2, out: "" }).problems).toEqual(["traceability: exit 2"]);
  });

  it("TC-G003-03 the pushed range starts at the merge-base of main and the head, not at main's tip", () => {
    const f = fakeExec({});
    g.runCheck({ repo: repoDir(), base: "origin/main", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" });
    expect(f.calls.find((c) => c.args[0] === "merge-base")!.args).toEqual(["merge-base", "origin/main", HEAD]);
    expect(f.calls.find((c) => c.args.includes("pre-push"))!.opts.input).toBe(`refs/heads/check ${HEAD} refs/heads/main ${MB}\n`);
    expect(f.calls.find((c) => c.args[0] === "diff")!.args).toEqual(["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", MB, HEAD]);
    const bad = (cmd: string, args: string[]) => (args[0] === "merge-base" ? { status: 1, stdout: "", stderr: "fatal: no merge base" } : ok());
    const r = g.runCheck({ repo: repoDir(), base: "x", head: HEAD, exec: bad, tmp: tmp(), py: "py" });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/no merge-base/);
  });

  it("TC-G003-04 a suite whose tests all pass adds no problem and reports the count", () => {
    const s = g.suiteResult({ hidden: { status: 0, out: "" }, vitest: { status: 0, out: "" }, results: results([{ file: "test/a.test.ts", title: "a" }, { file: "test/b.test.ts", title: "b" }]) });
    expect(s.problems).toEqual([]);
    expect(s.passed).toBe(2);
    const f = fakeExec({});
    const r = g.runCheck({ repo: repoDir(), base: "m", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" });
    expect(r.tests).toEqual({ passed: 1, failed: 0, total: 1 });
    expect(r.verdict).toMatch(/1 tests passed/);
  });

  it("TC-G003-05 a failed test fails the check and is named", () => {
    const s = g.suiteResult({ hidden: { status: 0, out: "" }, vitest: { status: 1, out: "" }, results: results([{ file: "test/a.test.ts", title: "a" }, { file: "test/a.test.ts", title: "breaks", status: "failed" }]) });
    expect(s.problems).toEqual(["1 test(s) failed: suite breaks"]);
    const fileFail = { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [{ name: "x", status: "failed", message: "SyntaxError", assertionResults: [{ title: "t", status: "passed" }] }] };
    expect(g.suiteResult({ hidden: { status: 0, out: "" }, vitest: { status: 1, out: "" }, results: fileFail }).problems[0]).toBe("1 test(s) failed: x: SyntaxError");
  });

  it("TC-G003-06 no test, no result file, a failed run or a failed check:hidden-launch each fail the check", () => {
    const none = { hidden: { status: 0, out: "" }, vitest: { status: 0, out: "" }, results: { numTotalTests: 0, testResults: [] } };
    expect(g.suiteResult(none).problems).toEqual(["test suite ran no test"]);
    expect(g.suiteResult({ ...none, vitest: { status: 1, out: "crash\nError: config broken\n" }, results: null }).problems).toEqual(["test suite gave no result (exit 1): Error: config broken"]);
    expect(g.suiteResult({ ...none, vitest: { status: 1, out: "Unhandled error" }, results: results([{ file: "t", title: "a" }]) }).problems).toEqual(["test suite run failed (exit 1): Unhandled error"]);
    expect(g.suiteResult({ ...none, hidden: { status: 1, out: "REFUSED x.ps1" }, results: results([{ file: "t", title: "a" }]) }).problems).toEqual(["check:hidden-launch failed (exit 1): REFUSED x.ps1"]);
    const f = fakeExec({ vitestResults: null, vitestStatus: 1 });
    expect(g.runCheck({ repo: repoDir(), base: "m", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" }).ok).toBe(false);
  });

  it("TC-G003-07 reads the added and changed lines of every file from a zero-context diff", () => {
    const h = g.parseHunks(DIFF);
    expect(h.get("src/a.ts")).toEqual([2, 3, 4, 12]);
    expect(h.get("src/b.ts")).toEqual([1, 2]);
    expect(h.has("src/c.ts")).toBe(false);
    expect(g.parseHunks("+++ b/x.ts\r\n@@ -1 +1 @@\r\n").get("x.ts")).toEqual([1]);
    expect(g.ranges([9, 3, 4, 5, 11, 12])).toBe("3-5, 9, 11-12");
  });

  it("TC-G003-08 changed lines run at 90% or more pass, exactly 90% included", () => {
    const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const changed = new Map([["src/a.ts", lines]]);
    const nine = g.coverageResult({ changed, cov: covOf(`${ROOT}\\src\\a.ts`, lines, lines.slice(0, 9)), root: ROOT, readFile: () => null });
    expect(nine.problems).toEqual([]);
    expect(nine.percent).toBe(90);
    const all = g.coverageResult({ changed, cov: covOf(`${ROOT}\\src\\a.ts`, lines, lines), root: ROOT, readFile: () => null });
    expect(all.percent).toBe(100);
  });

  it("TC-G003-09 below 90% fails naming each file and its lines not run", () => {
    const changed = new Map([["src/a.ts", [1, 2, 3, 4, 5]], ["scripts/t.mjs", [7, 8]]]);
    const cov = { ...covOf(`${ROOT}\\src\\a.ts`, [1, 2, 3, 4, 5], [1, 2]), ...covOf(`${ROOT}\\scripts\\t.mjs`, [7, 8], [7]) };
    const r = g.coverageResult({ changed, cov, root: ROOT, readFile: () => null });
    expect(r.problems).toEqual(["changed-line coverage 42.9% (3/7) is below 90%; not run: src/a.ts lines 3-5; scripts/t.mjs lines 8"]);
    const f = fakeExec({ diff: "+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n", cov: covOf("src/a.ts", [1, 2], []) });
    const rc = g.runCheck({ repo: repoDir(), base: "m", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" });
    expect(rc.ok).toBe(false);
    expect(rc.problems[0]).toMatch(/^changed-line coverage 0\.0% \(0\/2\)/);
  });

  it("TC-G003-10 a changed code file the suite never loads counts its changed non-blank non-comment lines as not run", () => {
    const text = ["const a = 1;", "", "// note", "/* block", " * more", "export const b = a;"].join("\r\n");
    const r = g.coverageResult({ changed: new Map([["src/n.ts", [1, 2, 3, 4, 5, 6]]]), cov: {}, root: ROOT, readFile: () => text });
    expect(r.total).toBe(2);
    expect(r.run).toBe(0);
    expect(r.missing).toEqual(["src/n.ts (never loaded by a test) lines 1, 6"]);
    expect(g.coverageResult({ changed: new Map([["src/gone.ts", [1]]]), cov: {}, root: ROOT, readFile: () => null }).total).toBe(0);
  });

  it("TC-G003-11 tests, docs, tools and .d.ts files and lines no statement starts on are not counted; no changed code line passes", () => {
    for (const p of ["test/a.test.ts", "docs/requirements.yaml", "tools/probe/p.mjs", "src/types.d.ts", "README.md", "scripts/x.ps1"]) expect(g.isCode(p)).toBe(false);
    for (const p of ["src/a.ts", "scripts/change-gate.mjs", "bin/cc.mjs", "src/x.mts", "src/y.js"]) expect(g.isCode(p)).toBe(true);
    const changed = new Map([["test/a.test.ts", [1]], ["src/a.ts", [1, 2, 3]]]);
    const r = g.coverageResult({ changed, cov: covOf(`${ROOT}\\src\\a.ts`, [2], [2]), root: ROOT, readFile: () => "" });
    expect([r.run, r.total, r.problems]).toEqual([1, 1, []]);
    const none = g.coverageResult({ changed: new Map([["docs/x.md", [1]]]), cov: {}, root: ROOT, readFile: () => "" });
    expect([none.total, none.percent, none.problems]).toEqual([0, 100, []]);
  });

  it("TC-G003-12 coverage keys given as Windows absolute paths map to the repository's paths", () => {
    expect(g.relPath("C:\\Work\\WT\\src\\a.ts", "c:\\work\\wt")).toBe("src/a.ts");
    expect(g.relPath("/r/wt/src/a.ts", "/r/wt/")).toBe("src/a.ts");
    expect(g.relPath("src/a.ts", "/r")).toBe("src/a.ts");
    expect(g.relPath("/elsewhere/src/a.ts", "/r/wt")).toBe("../../elsewhere/src/a.ts");
    expect([...g.lineCoverage(covOf("C:\\work\\wt\\scripts\\p.mjs", [3], [3]), ROOT).keys()]).toEqual(["scripts/p.mjs"]);
    expect(g.lineCoverage({ "x.ts": { statementMap: { 0: { start: { line: 4 } } } } }, ROOT).get("x.ts").run.size).toBe(0);
  });

  it("TC-G003-13 test cases of a changed requirement whose tests passed add no problem", () => {
    const head = ledger([req("REQ-Z100", [{ id: "TC-D100-01", test: "test/a.test.ts > TC-D100-01 does it" }])]);
    const r = g.testCaseResult({ baseLedger: ledger([]), headLedger: head, results: results([{ file: "test/a.test.ts", title: "TC-D100-01 does it" }]), root: ROOT });
    expect(r).toEqual({ problems: [], checked: 1 });
    const repo = repoDir({ "docs/requirements.yaml": "x" });
    const f = fakeExec({ baseLedger: ledger([]), headLedger: head, vitestResults: results([{ file: "test/a.test.ts", title: "TC-D100-01 does it" }], repo) });
    const rc = g.runCheck({ repo, base: "m", head: HEAD, exec: f.exec, tmp: tmp(), py: "py" });
    expect(rc.problems).toEqual([]);
    expect(rc.verdict).toMatch(/1 test cases/);
  });

  it("TC-G003-14 a test case whose test is missing, failed or in another file fails the check naming it", () => {
    const head = ledger([req("REQ-Z100", [
      { id: "TC-D100-01", test: "test/a.test.ts > TC-D100-01 x" },
      { id: "TC-D100-02", test: "test/a.test.ts > TC-D100-02 y" },
      { id: "TC-D100-03", test: "test/b.test.ts > TC-D100-03 z" },
      { id: "TC-D100-04", test: "" },
    ])]);
    const res = results([{ file: "test/a.test.ts", title: "TC-D100-01 x" }, { file: "test/a.test.ts", title: "TC-D100-02 y", status: "failed" }, { file: "test/a.test.ts", title: "TC-D100-03 z" }]);
    const r = g.testCaseResult({ baseLedger: null, headLedger: head, results: res, root: ROOT });
    expect(r.problems).toEqual([
      "test case TC-D100-02 (REQ-Z100): its test did not pass",
      "test case TC-D100-03 (REQ-Z100): no test in test/b.test.ts holds TC-D100-03",
      "test case TC-D100-04 (REQ-Z100): no test in (no file named) holds TC-D100-04",
    ]);
    const f = fakeExec({ headLedger: null as unknown as undefined });
    const bad = (cmd: string, args: string[], o: { input?: string } = {}) => (args[0] === "-c" ? { status: 1, stdout: "", stderr: "yaml error" } : f.exec(cmd, args, o));
    expect(g.runCheck({ repo: repoDir(), base: "m", head: HEAD, exec: bad, tmp: tmp(), py: "py" }).problems).toContain("docs/requirements.yaml: could not be read");
  });

  it("TC-G003-15 test cases of requirements the pull request leaves unchanged are not re-checked", () => {
    const same = req("REQ-Z001", [{ id: "TC-D001-01", test: "test/gone.test.ts > TC-D001-01 old" }]);
    const r = g.testCaseResult({ baseLedger: ledger([same]), headLedger: ledger([same]), results: results([]), root: ROOT });
    expect(r).toEqual({ problems: [], checked: 0 });
    const changedText = g.testCaseResult({ baseLedger: ledger([same]), headLedger: ledger([{ ...same, text: "new" }]), results: results([]), root: ROOT });
    expect(changedText.checked).toBe(1);
  });

  it("TC-G003-16 a passing report becomes a success status starting with pass, at most 140 characters", () => {
    const s = g.statusFromReport({ ok: true, verdict: "x".repeat(300), problems: [] });
    expect(s.state).toBe("success");
    expect(s.context).toBe("cc/req-gate");
    expect(s.description.startsWith("pass: ")).toBe(true);
    expect(s.description.length).toBe(140);
    expect(g.statusFromReport({ ok: true }).description).toBe("pass: all checks passed");
  });

  it("TC-G003-17 a failing report becomes a failure status naming the count and the first problem, at most 140 characters", () => {
    const s = g.statusFromReport({ ok: false, problems: ["changed-line coverage 40.0% (2/5) is below 90%; not run: " + "y".repeat(200), "second"] });
    expect(s.state).toBe("failure");
    expect(s.description.startsWith("2 problem(s): changed-line coverage 40.0% (2/5) is below 90%")).toBe(true);
    expect(s.description.length).toBe(140);
    expect(g.statusFromReport({ ok: false, problems: [] }).description).toBe("0 problem(s): check failed");
  });

  it("main prints usage without its arguments and runs the check with them, writing the report", () => {
    const lines: string[] = [];
    expect(g.main([], { log: (l: string) => lines.push(l) })).toBe(2);
    expect(lines[0]).toMatch(/^usage:/);
    const out = join(tmp(), "r.json");
    const f = fakeExec({});
    expect(g.main(["--repo", repoDir(), "--base", "m", "--head", HEAD, "--out", out, "--pinned", "/p"], { exec: f.exec, log: () => {} })).toBe(0);
    const f2 = fakeExec({ gate: { status: 1, stdout: "  - nope\n", stderr: "" } });
    const msgs: string[] = [];
    expect(g.main(["--repo", repoDir(), "--base", "m", "--head", HEAD], { exec: f2.exec, log: (l: string) => msgs.push(l) })).toBe(1);
    expect(msgs[0]).toMatch(/^FAIL b{12}: traceability: nope/);
    expect(g.python({ HELM_REQ_GATE_PYTHON: "/x/py" })).toBe("/x/py");
    expect(g.python({}, () => true)).toBe("C:/ProgramData/HELM/req-gate/venv/Scripts/python.exe");
    expect(["python", "python3"]).toContain(g.python({}, () => false));
    const r = g.sh(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0,'utf8'))"], { input: "hi" });
    expect([r.status, r.stdout]).toEqual([0, "hi"]);
    expect(g.sh("definitely-not-a-program-cc", []).status).toBe(-1);
  });
});
