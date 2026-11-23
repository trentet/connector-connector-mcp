// change-gate.mjs (REQ-G003): the check behind the cc/req-gate commit status of a pull request head.
//   node scripts/change-gate.mjs --repo <worktree of the head> --base <main commit> --head <commit> [--out report.json]
// Runs, on the head's worktree: (1) scripts/req_gate.py pre-push over merge-base..head (REQ-G001, REQ-G002);
// (2) check:hidden-launch and the whole vitest suite with v8 coverage; (3) changed-line coverage of code files, at least
// FLOOR percent; (4) the test cases of every requirement the pull request adds or changes name a real test that passed.
// The rules mirror the change gate of the Forgejo repositories (merge-base diff, 90% floor, a file never loaded counts as
// not run, real tests); its code is not copied (RULE-233, RULE-280). This copy runs from the poster's copy of main
// (REQ-G003.AC7): req_gate.py is taken from next to this file, never from the head.
// Exit 0 when the check passed, 1 when it found problems, 2 on wrong usage.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTEXT = "cc/req-gate";
export const FLOOR = 90;
export const LEDGER = "docs/requirements.yaml";
const CODE = /^(?:src|scripts|bin)\/.+\.(?:ts|mts|js|mjs)$/;
const VENV = "C:/ProgramData/HELM/req-gate/venv/Scripts/python.exe";
const HERE = dirname(fileURLToPath(import.meta.url));

/** True for a code file whose changed lines are measured (REQ-G003.AC3). */
export function isCode(path) {
  return CODE.test(path) && !/\.d\.ts$/.test(path);
}

/** Added or changed lines (new-side numbers) per file, from `git diff -U0` output (REQ-G003.AC3). */
export function parseHunks(diff) {
  const out = new Map();
  let file = null;
  for (const line of String(diff).replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (!out.has(file)) out.set(file, []);
      for (let n = start; n < start + count; n++) out.get(file).push(n);
    }
  }
  return out;
}

/** Repository-relative path with forward slashes for a coverage key (absolute, possibly a Windows path). */
export function relPath(key, root) {
  const k = String(key).replace(/\\/g, "/");
  const r = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  if (k.toLowerCase().startsWith(r.toLowerCase() + "/")) return k.slice(r.length + 1);
  return isAbsolute(key) ? relative(root, key).replace(/\\/g, "/") : k;
}

/** Lines a statement starts on, and those of them that ran, per file of an istanbul coverage-final.json. */
export function lineCoverage(cov, root) {
  const out = new Map();
  for (const [key, f] of Object.entries(cov || {})) {
    const exec = new Set();
    const run = new Set();
    for (const [id, loc] of Object.entries(f.statementMap || {})) {
      const line = loc.start.line;
      exec.add(line);
      if ((f.s || {})[id] > 0) run.add(line);
    }
    out.set(relPath(f.path || key, root), { exec, run });
  }
  return out;
}

const blankOrComment = (t) => {
  const s = String(t ?? "").trim();
  return s === "" || s.startsWith("//") || s.startsWith("/*") || s.startsWith("*") || s.startsWith("#!");
};

/** Compresses [3,4,5,9] to "3-5, 9". */
export function ranges(lines) {
  const s = [...lines].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(", ");
}

/** Changed-line coverage (REQ-G003.AC3). readFile(path) gives the head's text of a file (for files never loaded). */
export function coverageResult({ changed, cov, root, readFile, floor = FLOOR }) {
  const lc = lineCoverage(cov, root);
  let total = 0;
  let run = 0;
  const missing = [];
  for (const [file, lines] of changed) {
    if (!isCode(file)) continue;
    const c = lc.get(file);
    let counted;
    let ran;
    if (c) {
      counted = lines.filter((n) => c.exec.has(n));
      ran = counted.filter((n) => c.run.has(n));
    } else {
      const text = (readFile(file) ?? "").replace(/\r\n/g, "\n").split("\n");
      counted = lines.filter((n) => !blankOrComment(text[n - 1]));
      ran = [];
    }
    total += counted.length;
    run += ran.length;
    const notRun = counted.filter((n) => !ran.includes(n));
    if (notRun.length) missing.push(`${file} ${c ? "" : "(never loaded by a test) "}lines ${ranges(notRun)}`);
  }
  const percent = total === 0 ? 100 : (100 * run) / total;
  const problems = [];
  if (total > 0 && percent < floor) {
    problems.push(`changed-line coverage ${percent.toFixed(1)}% (${run}/${total}) is below ${floor}%; not run: ${missing.join("; ")}`);
  }
  return { problems, run, total, percent, missing };
}

/** Test suite result (REQ-G003.AC2): the check:hidden-launch run, the vitest run, and vitest's JSON results (or null). */
export function suiteResult({ hidden, vitest, results }) {
  const problems = [];
  if (hidden.status !== 0) problems.push(`check:hidden-launch failed (exit ${hidden.status}): ${lastLine(hidden.out)}`);
  if (!results) {
    problems.push(`test suite gave no result (exit ${vitest.status}): ${lastLine(vitest.out)}`);
    return { problems, passed: 0, failed: 0, total: 0 };
  }
  const failedNames = [];
  for (const f of results.testResults || []) {
    for (const a of f.assertionResults || []) if (a.status === "failed") failedNames.push(a.fullName || a.title);
    if (f.status === "failed" && !(f.assertionResults || []).some((a) => a.status === "failed")) failedNames.push(`${f.name}: ${f.message || "file failed"}`);
  }
  const passed = results.numPassedTests || 0;
  const failed = results.numFailedTests || 0;
  const total = results.numTotalTests || 0;
  if (failedNames.length) problems.push(`${failedNames.length} test(s) failed: ${failedNames.join(" | ")}`);
  else if (vitest.status !== 0) problems.push(`test suite run failed (exit ${vitest.status}): ${lastLine(vitest.out)}`);
  if (total === 0) problems.push("test suite ran no test");
  return { problems, passed, failed, total };
}

/** req_gate.py pre-push result (REQ-G003.AC1): its problem lines, prefixed. */
export function traceResult({ status, out }) {
  if (status === 0) return { problems: [] };
  const lines = String(out).replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
  const items = lines.length ? lines.map((l) => l.slice(2)) : [lastLine(out) || `exit ${status}`];
  return { problems: items.map((l) => `traceability: ${l}`) };
}

/** Test cases of requirements added or changed between two ledgers (REQ-G003.AC4), checked against vitest results. */
export function testCaseResult({ baseLedger, headLedger, results, root }) {
  const before = new Map(((baseLedger && baseLedger.requirements) || []).map((r) => [String(r.id), JSON.stringify(r)]));
  const problems = [];
  let checked = 0;
  const files = new Map();
  for (const f of (results && results.testResults) || []) files.set(relPath(f.name, root), f.assertionResults || []);
  for (const r of (headLedger && headLedger.requirements) || []) {
    if (before.get(String(r.id)) === JSON.stringify(r)) continue;
    for (const tc of r.test_cases || []) {
      checked++;
      const file = String(tc.test || "").split(" > ")[0].trim();
      const tests = files.get(file);
      const hit = (tests || []).filter((a) => `${a.fullName || ""} ${a.title || ""}`.includes(String(tc.id)));
      if (!tests || hit.length === 0) problems.push(`test case ${tc.id} (${r.id}): no test in ${file || "(no file named)"} holds ${tc.id}`);
      else if (!hit.every((a) => a.status === "passed")) problems.push(`test case ${tc.id} (${r.id}): its test did not pass`);
    }
  }
  return { problems, checked };
}

/** The commit status for a report (REQ-G003.AC5), in helm-rules' statusFromReport form. */
export function statusFromReport(report) {
  const ok = report.ok === true;
  const p = report.problems || [];
  const description = (ok ? `pass: ${report.verdict || "all checks passed"}` : `${p.length} problem(s): ${p[0] || report.verdict || "check failed"}`).slice(0, 140);
  return { state: ok ? "success" : "failure", context: CONTEXT, description };
}

function lastLine(s) {
  const l = String(s ?? "").replace(/\r\n/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean);
  return (l[l.length - 1] || "").slice(0, 200);
}

/** Runs a program without a window (E13); never through a shell. */
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, env: opts.env || process.env, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout || 45 * 60 * 1000 });
  return { status: r.status === null ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

export function python(env = process.env, exists = existsSync) {
  return env.HELM_REQ_GATE_PYTHON || (exists(VENV) ? VENV : process.platform === "win32" ? "python" : "python3");
}

const LEDGER_JSON = "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))";

/** The whole check on one head (REQ-G003.AC1-AC4). exec(cmd, args, opts) -> {status, stdout, stderr}. */
export function runCheck({ repo, base, head, pinned = resolve(HERE, ".."), exec = sh, tmp, py = python() }) {
  const problems = [];
  const git = (...a) => exec("git", a, { cwd: repo });
  const mbr = git("merge-base", base, head);
  if (mbr.status !== 0) return { ok: false, head, base, problems: [`no merge-base of ${base} and ${head}: ${lastLine(mbr.stderr)}`] };
  const mb = mbr.stdout.trim();
  // (1) traceability: the pinned req_gate.py, over the pull request's own commits.
  const tr = exec(py, [join(pinned, "scripts", "req_gate.py"), "pre-push"], { cwd: repo, input: `refs/heads/check ${head} refs/heads/main ${mb}\n` });
  const trace = traceResult({ status: tr.status, out: tr.stdout + tr.stderr });
  problems.push(...trace.problems);
  // (2) the suite, as npm test runs it, with coverage.
  const hidden = exec("node", ["scripts/check-hidden-launch.mjs", "--pinned", "scripts/check-hidden-launch.sha256", "."], { cwd: repo });
  const out = join(tmp, "vitest.json");
  const covDir = join(tmp, "coverage");
  const vt = exec("node", [join(repo, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`,
    "--coverage.enabled=true", "--coverage.provider=v8", "--coverage.reporter=json", `--coverage.reportsDirectory=${covDir}`, "--coverage.all=false", "--coverage.reportOnFailure=true",
    "--coverage.include=src/**", "--coverage.include=scripts/**", "--coverage.include=bin/**"], { cwd: repo });
  const results = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const suite = suiteResult({ hidden: { status: hidden.status, out: hidden.stdout + hidden.stderr }, vitest: { status: vt.status, out: vt.stdout + vt.stderr }, results });
  problems.push(...suite.problems);
  // (3) changed-line coverage.
  const diff = git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", mb, head);
  const covFile = join(covDir, "coverage-final.json");
  const cov = existsSync(covFile) ? JSON.parse(readFileSync(covFile, "utf8")) : {};
  const readFile = (p) => { const f = join(repo, p); return existsSync(f) ? readFileSync(f, "utf8") : null; };
  const coverage = coverageResult({ changed: parseHunks(diff.stdout), cov, root: repo, readFile });
  problems.push(...coverage.problems);
  // (4) test cases of added or changed requirements.
  const led = (text) => { const r = exec(py, ["-c", LEDGER_JSON], { input: text }); return r.status === 0 ? JSON.parse(r.stdout) : null; };
  const baseText = git("show", `${mb}:${LEDGER}`);
  const headLedger = led(readFile(LEDGER) ?? "");
  if (!headLedger) problems.push(`${LEDGER}: could not be read`);
  const tcs = testCaseResult({ baseLedger: baseText.status === 0 ? led(baseText.stdout) : null, headLedger, results, root: repo });
  problems.push(...tcs.problems);
  const verdict = `traceability ok, ${suite.passed} tests passed, changed-line coverage ${coverage.percent.toFixed(1)}% (${coverage.run}/${coverage.total}), ${tcs.checked} test cases`;
  return { ok: problems.length === 0, head, base: mb, verdict, problems, tests: { passed: suite.passed, failed: suite.failed, total: suite.total }, coverage: { run: coverage.run, total: coverage.total, percent: coverage.percent, missing: coverage.missing } };
}

export function main(argv, { exec = sh, log = console.log } = {}) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = opt("--repo");
  const base = opt("--base");
  const head = opt("--head");
  if (!repo || !base || !head) { log("usage: node scripts/change-gate.mjs --repo <worktree> --base <main commit> --head <commit> [--out report.json]"); return 2; }
  const tmp = mkdtempSync(join(tmpdir(), "cc-req-gate-"));
  try {
    const report = runCheck({ repo: resolve(repo), base, head, exec, tmp, pinned: opt("--pinned") ? resolve(opt("--pinned")) : undefined });
    if (opt("--out")) writeFileSync(opt("--out"), JSON.stringify(report, null, 2));
    log(`${report.ok ? "PASS" : "FAIL"} ${head.slice(0, 12)}: ${report.ok ? report.verdict : report.problems.join("\n  - ")}`);
    return report.ok ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Live proof of REQ-G003 (throwaway branch, never merged): a small helper.
export function coverageLabel(run, total) {
  if (!Number.isInteger(run) || !Number.isInteger(total) || total <= 0) {
    return "no changed code lines";
  }
  const pct = Math.floor((run * 1000) / total) / 10;
  return `${pct}% (${run}/${total})`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
