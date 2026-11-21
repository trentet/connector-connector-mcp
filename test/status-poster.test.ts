// @reqs REQ-G003
// The W540 service that posts cc/req-gate (scripts/status-poster.mjs): same-repository heads only, each head once, the
// pinned gate on a worktree, and its process record; plus the hidden scheduled task and watchdog that keep it running.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded at run time so that each test fails on its own while the module does not exist yet (spec-first, REQ-G003).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await import("../scripts/status-poster.mjs").catch(() => ({}));

const REPO = "trentet/connector-connector-mcp";
const SHA = "c".repeat(40);
const pr = (n: number, repo: string | null, sha = SHA, ref = "feat/x") => ({ number: n, head: { sha, ref, repo: repo ? { full_name: repo } : null } });
const st = (state: string, minutesAgo = 0, context = "cc/req-gate") => ({ context, state, updated_at: new Date(Date.parse("2026-11-21T20:00:00Z") - minutesAgo * 60000).toISOString() });
const NOW = Date.parse("2026-11-21T20:00:00Z");
type R = { status: number; stdout: string; stderr: string };
const ok = (stdout = ""): R => ({ status: 0, stdout, stderr: "" });

/** A fake GitHub API: open pull requests, statuses per commit, and every call recorded. */
function fakeApi(prs: unknown[], statuses: Record<string, unknown[]> = {}) {
  const calls: { path: string; method: string; body: { state?: string; description?: string; context?: string } | null }[] = [];
  const api = (path: string, o: { method?: string; body?: { state?: string } | null } = {}) => {
    calls.push({ path, method: o.method ?? "GET", body: (o.body ?? null) as never });
    if (path.startsWith(`repos/${REPO}/pulls?`)) return prs;
    const m = /commits\/([0-9a-f]+)\/statuses/.exec(path);
    if (m) return statuses[m[1]] ?? [];
    return {};
  };
  return { api, calls, posts: () => calls.filter((c) => c.method === "POST") };
}

/** A fake exec for checkCommit: git, npm and the pinned change-gate.mjs, which writes the report where it was told to. */
function fakeExec(o: { fail?: string; report?: unknown; vitest?: boolean } = {}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const exec = (cmd: string, args: string[], opts: { cwd?: string } = {}): R => {
    calls.push({ cmd, args, cwd: opts.cwd });
    const step = cmd === "git" ? args[0] : String(args[1] ?? "").replace(/^--.*/, "") || String(args[0]);
    if (o.fail && (step === o.fail || args[0].endsWith(o.fail))) return { status: 1, stdout: "", stderr: `boom ${o.fail}\nlast line` };
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      const wt = args[4];
      if (o.vitest !== false) { mkdirSync(join(wt, "node_modules", "vitest"), { recursive: true }); writeFileSync(join(wt, "node_modules", "vitest", "package.json"), '{"version":"2.1.9"}'); }
    }
    if (String(args[0]).endsWith("change-gate.mjs") && o.report !== null) {
      writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(o.report ?? { ok: true, verdict: "fine", problems: [] }));
    }
    return ok();
  };
  return { exec, calls };
}

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "poster-"));
  mkdirSync(join(h, "work", ".git"), { recursive: true });
  return h;
};

describe("REQ-G003 status poster", () => {
  it("TC-G003-18 a same-repository pull request head without a status is checked", () => {
    expect(p.classify(pr(1, REPO))).toBe("same");
    expect(p.plan([pr(1, REPO)], () => [], NOW)).toEqual([{ pr: 1, sha: SHA, action: "check" }]);
    expect(p.plan([pr(1, REPO)], () => [st("success", 0, "other/ctx")], NOW)[0].action).toBe("check");
  });

  it("TC-G003-19 a fork pull request is never fetched or run and gets the not run failure once", () => {
    const f = fakeApi([pr(7, "someone/fork")]);
    const ex = fakeExec();
    let checked = 0;
    const done = p.cycle({ api: f.api, exec: ex.exec, home: home(), pinned: "/pinned", now: () => NOW, check: () => { checked++; return { ok: true }; } });
    expect(checked).toBe(0);
    expect(done).toEqual([{ pr: 7, sha: SHA, action: "fork", state: "failure" }]);
    expect(f.posts()[0].body).toEqual({ state: "failure", context: "cc/req-gate", description: p.FORK_DESCRIPTION.slice(0, 140) });
    expect(ex.calls.filter((c) => c.cwd !== "/pinned")).toEqual([]);
    expect(p.plan([pr(7, "someone/fork")], () => [st("failure")], NOW)[0].action).toBe("skip");
  });

  it("TC-G003-20 a pull request whose head repository is gone is treated as a fork", () => {
    expect(p.classify(pr(3, null))).toBe("fork");
    expect(p.classify({ number: 4 })).toBe("fork");
    expect(p.plan([pr(3, null)], () => [], NOW)[0].action).toBe("fork");
  });

  it("TC-G003-21 the check runs the pinned change-gate.mjs on a worktree of the head with coverage-v8 at the head's vitest version, not saved", () => {
    const h = home();
    const ex = fakeExec({ report: { ok: true, verdict: "v", problems: [] } });
    const r = p.checkCommit({ pr: pr(5, REPO), home: h, pinned: "/pinned", exec: ex.exec, npmCli: "/npm-cli.js" });
    expect(r).toEqual({ ok: true, verdict: "v", problems: [] });
    const fetch = ex.calls.find((c) => c.args[0] === "fetch")!;
    expect(fetch.args).toEqual(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/heads/feat/x:refs/remotes/origin/feat/x"]);
    expect(fetch.args.join(" ")).not.toMatch(/refs\/pull/);
    const wt = join(h, "wt", SHA.slice(0, 12));
    expect(ex.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add")!.args).toEqual(["worktree", "add", "--detach", "--force", wt, SHA]);
    expect(ex.calls.find((c) => c.args[1] === "ci")).toMatchObject({ cmd: "node", args: ["/npm-cli.js", "ci", "--no-audit", "--no-fund"], cwd: wt });
    expect(ex.calls.find((c) => c.args[1] === "install")!.args).toEqual(["/npm-cli.js", "install", "--no-save", "--no-audit", "--no-fund", "@vitest/coverage-v8@2.1.9"]);
    const gate = ex.calls.find((c) => String(c.args[0]).endsWith("change-gate.mjs"))!;
    expect(gate.args[0]).toBe(join("/pinned", "scripts", "change-gate.mjs"));
    expect(gate.args.slice(1, 7)).toEqual(["--repo", wt, "--base", "origin/main", "--head", SHA]);
    expect(ex.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it("TC-G003-22 the worktree is removed after a failed install or a failed check, and the head gets failure", () => {
    for (const step of ["clone", "fetch", "worktree", "ci", "install", "change-gate.mjs", "cat-file"]) {
      const h = step === "clone" ? mkdtempSync(join(tmpdir(), "poster-")) : home();
      const ex = fakeExec({ fail: step, report: step === "change-gate.mjs" ? null : undefined });
      const r = p.checkCommit({ pr: pr(5, REPO), home: h, pinned: "/pinned", exec: ex.exec, npmCli: "/npm-cli.js" });
      expect(r.ok, step).toBe(false);
      expect(r.problems[0], step).toMatch(/^setup: /);
      expect(existsSync(join(h, "wt", SHA.slice(0, 12))), step).toBe(false);
    }
    const nov = p.checkCommit({ pr: pr(5, REPO), home: home(), pinned: "/pinned", exec: fakeExec({ vitest: false }).exec, npmCli: "/n" });
    expect(nov.problems).toEqual(["setup: vitest is not installed by the head's package-lock.json"]);
    const f = fakeApi([pr(2, REPO)]);
    p.cycle({ api: f.api, exec: fakeExec().exec, home: home(), pinned: "/pinned", now: () => NOW, check: () => ({ ok: false, problems: ["setup: npm ci failed (exit 1): x"] }) });
    expect(f.posts().map((c) => c.body!.state)).toEqual(["pending", "failure"]);
  });

  it("TC-G003-23 a head with a final status is not checked again", () => {
    for (const s of ["success", "failure", "error"]) expect(p.plan([pr(1, REPO)], () => [st(s, 500)], NOW)[0].action).toBe("skip");
    const f = fakeApi([pr(1, REPO)], { [SHA]: [st("success")] });
    expect(p.cycle({ api: f.api, exec: fakeExec().exec, home: home(), pinned: "/p", now: () => NOW, check: () => { throw new Error("must not run"); } })).toEqual([]);
    expect(f.posts()).toEqual([]);
  });

  it("TC-G003-24 a pending status older than 30 minutes is checked again and a fresh one is left alone", () => {
    expect(p.plan([pr(1, REPO)], () => [st("pending", 31)], NOW)[0].action).toBe("check");
    expect(p.plan([pr(1, REPO)], () => [st("pending", 29)], NOW)[0].action).toBe("skip");
    expect(p.plan([pr(1, REPO)], () => [{ context: "cc/req-gate", state: "pending", created_at: "2026-11-21T19:00:00Z" }], NOW)[0].action).toBe("check");
    expect(p.plan([pr(1, REPO)], () => null, NOW)[0].action).toBe("check");
  });

  it("TC-G003-25 a cycle posts pending and then the final cc/req-gate status on the same head", () => {
    const f = fakeApi([pr(9, REPO)]);
    const ex = fakeExec();
    const lines: string[] = [];
    const done = p.cycle({ api: f.api, exec: ex.exec, home: home(), pinned: "/pinned", now: () => NOW, log: (l: string) => lines.push(l), check: () => ({ ok: false, problems: ["traceability: a", "b"] }) });
    expect(f.posts().map((c) => [c.path, c.body!.state, c.body!.context])).toEqual([[`repos/${REPO}/statuses/${SHA}`, "pending", "cc/req-gate"], [`repos/${REPO}/statuses/${SHA}`, "failure", "cc/req-gate"]]);
    expect(f.posts()[1].body!.description).toBe("2 problem(s): traceability: a");
    expect(done[0]).toMatchObject({ pr: 9, state: "failure" });
    expect(ex.calls.slice(0, 2).map((c) => [c.args[0], c.cwd])).toEqual([["fetch", "/pinned"], ["checkout", "/pinned"]]);
    expect(lines[0]).toBe(`PR #9 ${SHA.slice(0, 12)} failure: 2 problem(s): traceability: a | all: traceability: a | b`);
    const ok1 = fakeApi([pr(9, REPO)]);
    p.cycle({ api: ok1.api, exec: ex.exec, home: home(), pinned: "/pinned", now: () => NOW, check: () => ({ ok: true, verdict: "fine", problems: [] }) });
    expect(ok1.posts()[1].body).toEqual({ state: "success", context: "cc/req-gate", description: "pass: fine" });
  });

  it("TC-G003-26 the service writes its PID and start time and one log line per check without any token", async () => {
    const h = mkdtempSync(join(tmpdir(), "poster-home-"));
    const at = new Date("2026-11-21T20:00:00Z");
    let cycles = 0;
    const code = await p.main(["--home", h, "--once"], { pid: 4242, now: () => at, cycleFn: ({ log }: { log: (l: string) => void }) => { cycles++; log("PR #1 cccccccccccc success: pass: fine"); } });
    expect(code).toBe(0);
    expect(cycles).toBe(1);
    expect(JSON.parse(readFileSync(join(h, "state.json"), "utf8"))).toEqual({ pid: 4242, startedAt: "2026-11-21T20:00:00.000Z", context: "cc/req-gate", repo: REPO });
    const log = readFileSync(join(h, "logs", "poster.log"), "utf8");
    expect(log).toMatch(/poster started pid 4242/);
    expect(log).toMatch(/PR #1 cccccccccccc success/);
    expect(log).not.toMatch(/gh[pousr]_|github_pat_|token/i);
    // A failing cycle is logged and the loop goes on; without --home it prints usage.
    let n = 0;
    const slept: number[] = [];
    await expect(p.main(["--home", h, "--interval", "5"], { pid: 1, cycleFn: () => { n++; if (n === 1) throw new Error("gh: HTTP 502\nmore"); }, sleep: async (ms: number) => { slept.push(ms); if (n >= 2) throw new Error("stop"); } })).rejects.toThrow("stop");
    expect(slept).toEqual([5000, 5000]);
    expect(readFileSync(join(h, "logs", "poster.log"), "utf8")).toMatch(/cycle error: gh: HTTP 502$/m);
    expect(await p.main([], {})).toBe(2);
    const run = (cmd: string, args: string[], o: { input?: string }) => { expect(cmd).toBe("gh"); return args.includes("--input") ? JSON.stringify({ posted: JSON.parse(o.input!) }) : ""; };
    expect(p.ghApi("repos/x/statuses/1", { method: "POST", body: { state: "success" } }, run)).toEqual({ posted: { state: "success" } });
    expect(p.ghApi("repos/x", {}, run)).toEqual({});
  });

  it("TC-G003-27 the scheduled task starts the watchdog hidden through run-hidden.vbs at logon and the watchdog restarts the service", () => {
    const inst = readFileSync("scripts/install-req-gate-poster.ps1", "utf8");
    expect(inst).toMatch(/run-hidden\.vbs/);
    expect(inst).toMatch(/-Execute "wscript\.exe"/);
    expect(inst).toMatch(/New-ScheduledTaskTrigger -AtLogOn/);
    expect(inst).toMatch(/"cc-req-gate Status Poster"/);
    const dog = readFileSync("scripts/run-req-gate-poster.ps1", "utf8");
    expect(dog).toMatch(/while \(\$true\)/);
    expect(dog).toMatch(/-WindowStyle Hidden/);
    expect(dog).toMatch(/poster started pid \$\(\$proc\.Id\) at \$\(\$proc\.StartTime/);
    expect(dog).toMatch(/status-poster\.mjs/);
  });
});
