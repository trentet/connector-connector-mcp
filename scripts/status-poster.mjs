// status-poster.mjs (REQ-G003): the W540 service that posts the cc/req-gate commit status on pull request heads.
//   node scripts/status-poster.mjs --home <state folder> [--once] [--interval <seconds>]
// Every interval: refresh this copy of main (the pinned gate), list every open pull request, whatever its base, and for each head:
//   same-repository head without a final cc/req-gate status -> pending, run change-gate.mjs on a worktree, success/failure;
//   fork head (or head repository gone) -> failure "not run" once; its code is never fetched or run (REQ-G003.AC6).
// GitHub is reached through gh (logged in on the W540); the token never leaves gh. One log line per check (AC9).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTEXT, sh, statusFromReport } from "./change-gate.mjs";

export const REPO = "trentet/connector-connector-mcp";
export const STALE_MS = 30 * 60 * 1000;
export const FORK_DESCRIPTION = "not run: fork pull requests never run on the self-hosted W540 gate; push the branch to trentet/connector-connector-mcp";
const HERE = dirname(fileURLToPath(import.meta.url));

/** The GitHub API through gh, without a window (E13). */
export function ghApi(path, { method = "GET", body = null } = {}, run = execFileSync) {
  const args = ["api", "-X", method, path, ...(body ? ["--input", "-"] : [])];
  const out = run("gh", args, { encoding: "utf8", input: body ? JSON.stringify(body) : undefined, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return out.trim() ? JSON.parse(out) : {};
}

/** "same" when the head is a branch of this repository, else "fork" (also when the head repository is gone). */
export function classify(pr, repo = REPO) {
  return pr && pr.head && pr.head.repo && pr.head.repo.full_name === repo ? "same" : "fork";
}

/** What to do with each open pull request (REQ-G003.AC6, AC8). statusesOf(sha) lists the head's statuses, newest first. */
export function plan(prs, statusesOf, now = Date.now(), repo = REPO) {
  const out = [];
  for (const pr of prs) {
    const sha = pr.head.sha;
    const st = (statusesOf(sha) || []).find((s) => s.context === CONTEXT) || null;
    const kind = classify(pr, repo);
    if (kind === "fork") {
      out.push({ pr: pr.number, sha, action: st ? "skip" : "fork" });
      continue;
    }
    if (!st) out.push({ pr: pr.number, sha, action: "check" });
    else if (st.state === "pending" && now - Date.parse(st.updated_at || st.created_at) > STALE_MS) out.push({ pr: pr.number, sha, action: "check" });
    else out.push({ pr: pr.number, sha, action: "skip" });
  }
  return out;
}

/** Checks one same-repository head on a worktree (REQ-G003.AC7). Returns the change-gate report; never throws. */
export function checkCommit({ pr, home, pinned, exec = sh, npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), repo = REPO }) {
  const work = join(home, "work");
  const sha = pr.head.sha;
  const wt = join(home, "wt", sha.slice(0, 12));
  const out = join(home, "wt", `${sha.slice(0, 12)}.json`);
  const fail = (step, r) => ({ ok: false, head: sha, problems: [`setup: ${step} failed (exit ${r.status}): ${String(r.stderr || r.stdout).trim().split(/\r?\n/).pop() || ""}`.slice(0, 300)] });
  const git = (...a) => exec("git", a, { cwd: work });
  try {
    if (!existsSync(join(work, ".git"))) {
      mkdirSync(home, { recursive: true });
      const c = exec("git", ["clone", "--quiet", "-c", "core.autocrlf=false", `https://github.com/${repo}.git`, work], { cwd: home });
      if (c.status !== 0) return fail("clone", c);
    }
    // The committed bytes are checked as they are: no CRLF conversion (check:hidden-launch pins its own hash).
    git("config", "core.autocrlf", "false");
    // Only this repository's own branches are fetched: never refs/pull/*, so a fork's code never reaches the W540.
    const f = git("fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", `+refs/heads/${pr.head.ref}:refs/remotes/origin/${pr.head.ref}`);
    if (f.status !== 0) return fail("fetch", f);
    const has = git("cat-file", "-e", `${sha}^{commit}`);
    if (has.status !== 0) return { ok: false, head: sha, problems: [`setup: head ${sha.slice(0, 12)} is not on branch ${pr.head.ref} any more`] };
    rmSync(wt, { recursive: true, force: true });
    git("worktree", "prune");
    const w = git("worktree", "add", "--detach", "--force", wt, sha);
    if (w.status !== 0) return fail("worktree", w);
    const ci = exec("node", [npmCli, "ci", "--no-audit", "--no-fund"], { cwd: wt });
    if (ci.status !== 0) return fail("npm ci", ci);
    const vfile = join(wt, "node_modules", "vitest", "package.json");
    const ver = existsSync(vfile) ? JSON.parse(readFileSync(vfile, "utf8")).version : null;
    if (!ver) return { ok: false, head: sha, problems: ["setup: vitest is not installed by the head's package-lock.json"] };
    const cov = exec("node", [npmCli, "install", "--no-save", "--no-audit", "--no-fund", `@vitest/coverage-v8@${ver}`], { cwd: wt });
    if (cov.status !== 0) return fail("coverage tool install", cov);
    const r = exec("node", [join(pinned, "scripts", "change-gate.mjs"), "--repo", wt, "--base", "origin/main", "--head", sha, "--out", out, "--pinned", pinned], { cwd: wt });
    if (!existsSync(out)) return fail("change-gate", r);
    return JSON.parse(readFileSync(out, "utf8"));
  } finally {
    git("worktree", "remove", "--force", wt);
    rmSync(wt, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
}

/** One poll: refresh the pinned copy, then check or mark every open pull request head. Returns what it did. */
export function cycle({ api = ghApi, exec = sh, home, pinned = resolve(HERE, ".."), now = Date.now, log = () => {}, check = checkCommit, repo = REPO }) {
  exec("git", ["fetch", "--quiet", "origin", "main"], { cwd: pinned });
  exec("git", ["checkout", "--quiet", "--detach", "origin/main"], { cwd: pinned });
  const prs = api(`repos/${repo}/pulls?state=open&per_page=100`);
  const steps = plan(prs, (sha) => api(`repos/${repo}/commits/${sha}/statuses?per_page=100`), now(), repo);
  const done = [];
  for (const s of steps) {
    const pr = prs.find((p) => p.number === s.pr);
    if (s.action === "skip") continue;
    if (s.action === "fork") {
      api(`repos/${repo}/statuses/${s.sha}`, { method: "POST", body: { state: "failure", context: CONTEXT, description: FORK_DESCRIPTION.slice(0, 140) } });
      log(`PR #${s.pr} ${s.sha.slice(0, 12)} fork: failure, not run`);
      done.push({ ...s, state: "failure" });
      continue;
    }
    api(`repos/${repo}/statuses/${s.sha}`, { method: "POST", body: { state: "pending", context: CONTEXT, description: "checking on the W540: req_gate, full test suite, changed-line coverage" } });
    const report = check({ pr, home, pinned, exec, repo });
    const status = statusFromReport(report);
    api(`repos/${repo}/statuses/${s.sha}`, { method: "POST", body: status });
    log(`PR #${s.pr} ${s.sha.slice(0, 12)} ${status.state}: ${status.description}${report.problems && report.problems.length > 1 ? ` | all: ${report.problems.join(" | ")}` : ""}`);
    done.push({ ...s, state: status.state, description: status.description });
  }
  return done;
}

export function writeState(home, state) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "state.json"), JSON.stringify(state, null, 2));
}

export function logTo(home) {
  const dir = join(home, "logs");
  mkdirSync(dir, { recursive: true });
  return (line) => appendFileSync(join(dir, "poster.log"), `${new Date().toISOString()} ${line}\n`);
}

/** The service: state file, then cycles forever (or once). sleep is injected for tests. */
export async function main(argv, { cycleFn = cycle, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pid = process.pid, now = () => new Date() } = {}) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const home = opt("--home");
  if (!home) { console.error("usage: node scripts/status-poster.mjs --home <state folder> [--once] [--interval <seconds>]"); return 2; }
  const interval = Number(opt("--interval") || 60) * 1000;
  const log = logTo(home);
  writeState(home, { pid, startedAt: now().toISOString(), context: CONTEXT, repo: REPO });
  log(`poster started pid ${pid}`);
  for (;;) {
    try {
      cycleFn({ home, log });
    } catch (e) {
      log(`cycle error: ${String(e && e.message ? e.message : e).split(/\r?\n/)[0].slice(0, 300)}`);
    }
    if (argv.includes("--once")) return 0;
    await sleep(interval);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
