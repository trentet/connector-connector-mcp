// @reqs REQ-D008 REQ-D009
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { enqueueRun, getRunJob, jobToResult, resetRunJobs, setJobProcDeps, settleJob, waitForJob } from "../src/core/runJobs.js";
import { currentJob, defaultProcDeps, pidAlive, reportItem, reportWorkDone, settleProcesses, trackChild, type JobProcess, type ProcDeps } from "../src/core/jobProcs.js";
import { tryAcquireAccountLock } from "../src/core/runLock.js";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { BrowserSession } from "../src/browser/chrome.js";
import { loadRegistry } from "../src/core/registry.js";
import { run } from "../src/core/runner.js";
import type { RunRequest, RunResult } from "../src/core/types.js";
import { registryFixture, signedInAsMain } from "./fixtures.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// This file's run locks live in their own temp dir, so other test files running in parallel never hold them.
const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-jobprocs-locks-"));
process.env.CC_RUN_LOCK_DIR = lockDir;
afterAll(() => { delete process.env.CC_RUN_LOCK_DIR; fs.rmSync(lockDir, { recursive: true, force: true }); });
const req = (over: Partial<RunRequest> = {}): RunRequest => ({ op: "update", connectors: ["helm-secret"], platforms: ["grok"], account: "ulostthegamers", ...over });
const failed = (detail: string): RunResult => ({ ok: false, items: [{ connector: "helm-secret", platform: "grok", op: "update", status: "error", detail }] });

/** Fake process table: pid -> start time; kill removes the entry. */
function fakeProcs(table: Record<number, string>): ProcDeps & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    alive: (pid) => pid in table,
    startTime: (pid) => table[pid],
    kill: (pid) => { killed.push(pid); delete table[pid]; },
    sleep: async () => undefined,
  };
}

describe("a job's status follows the work, not the browser cleanup (REQ-D008)", () => {
  beforeEach(() => { resetRunJobs(); setJobProcDeps(fakeProcs({})); });
  afterEach(() => { resetRunJobs(); setJobProcDeps(undefined); });

  it("the 2026-11-15 failure: a failed login is reported as error with the exact message at once, while the browser shutdown still hangs", async () => {
    let releaseClose!: () => void;
    const closeHang = new Promise<void>((r) => { releaseClose = r; });
    const msg = "grok-login failed: page.waitForURL: Timeout 584876ms exceeded";
    const { job } = enqueueRun(req(), async () => {
      reportItem(failed(msg).items[0]);
      reportWorkDone(failed(msg));
      await closeHang; // the session close that kept run_86587827120479fd "running"
      return failed(msg);
    }, { cleanupMs: 60_000 });
    await sleep(20);
    const mid = getRunJob(job.id)!;
    expect(mid.status).toBe("error");
    expect(mid.phase).toBe("cleanup");
    const res = jobToResult(mid);
    expect(res.jobStatus).toBe("error");
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toBe(msg);
    expect(res.detail).toContain(msg);
    releaseClose();
    await waitForJob(job.id);
    expect(getRunJob(job.id)!.phase).toBe("done");
  });

  it("items finished so far are visible while the job runs", async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const { job } = enqueueRun(req(), async () => {
      reportItem({ connector: "helm-secret", platform: "grok", op: "remove", status: "ok" });
      await gate;
      return { ok: true, items: [] };
    });
    await sleep(10);
    const r = jobToResult(getRunJob(job.id)!);
    expect(r.jobStatus).toBe("running");
    expect(r.items).toHaveLength(1);
    expect(r.phase).toBe("work");
    go();
    await waitForJob(job.id);
  });

  it("a cleanup that overruns is cut off: the job's own PIDs are killed by PID, the lock is released, and a new run can start", async () => {
    const procs = fakeProcs({ 4242: "2026-11-15T16:02:00.000Z" });
    setJobProcDeps(procs);
    const { job } = enqueueRun(req(), async () => {
      currentJob()!.processes.push({ jobId: currentJob()!.jobId, pid: 4242, startedAt: "2026-11-15T16:02:00.000Z", spawnedAt: "2026-11-15T16:02:00.000Z", kind: "chrome", port: 9400, lane: 0, userDataDir: "C:/tmp/cc-run-0-x" });
      reportWorkDone(failed("boom"));
      await new Promise(() => undefined); // never ends
      return failed("boom");
    }, { cleanupMs: 30 });
    await sleep(120);
    const j = getRunJob(job.id)!;
    expect(j.phase).toBe("cleanup-timeout");
    expect(j.status).toBe("error");
    expect(procs.killed).toEqual([4242]);
    expect(j.processes[0].endState).toBe("killed");
    const probe = tryAcquireAccountLock("ulostthegamers", "probe"); // the file lock was released
    expect(probe.ok).toBe(true);
    if (probe.ok) probe.lock.release();
    const next = enqueueRun(req(), async () => ({ ok: true, items: [] }));
    expect(next.started).toBe(true);
    await waitForJob(next.job.id);
  });

  it("the real runner reports the work as done before it closes the browser session", async () => {
    const reg = loadRegistry(path.resolve("registry", "connectors.json"));
    const { deps } = registryFixture(reg);
    const id = reg.connectors.find((c) => c.tier !== "test" && c.platforms.includes("grok"))!.id;
    let closeStarted = false;
    let releaseClose!: () => void;
    const closeHang = new Promise<void>((r) => { releaseClose = r; });
    const sessionFactory = async (): Promise<BrowserSession> => ({ touched: new Set<string>(), close: async () => { closeStarted = true; await closeHang; } }) as unknown as BrowserSession;
    const failing: PlatformAdapter = {
      platform: "grok",
      probe: async () => ({ status: "ok" }), list: async () => ({ names: [] }), add: async () => ({ status: "ok" }), remove: async () => ({ status: "ok" }), verify: async () => ({ status: "ok" }),
      update: async (ctx) => { await ctx.session(); throw new Error("grok-login failed: exact reason"); },
    };
    const { job } = enqueueRun({ op: "update", connectors: [id], platforms: ["grok"], account: "main" }, () =>
      run(reg, { op: "update", connectors: [id], platforms: ["grok"], account: "main" }, { readIdentity: signedInAsMain, deps, adapters: { grok: failing }, sessionFactory }), { cleanupMs: 60_000 });
    await sleep(50);
    const mid = getRunJob(job.id)!;
    expect(closeStarted).toBe(true);
    expect(mid.status).toBe("error");
    expect(mid.items[0].detail).toMatch(/grok-login failed: exact reason/);
    releaseClose();
    await waitForJob(job.id);
  });
});

describe("every process a job launches is recorded by PID and settled by PID (REQ-D009)", () => {
  afterEach(() => { resetRunJobs(); setJobProcDeps(undefined); });

  it("settleProcesses: exited stays exited, ours is killed by PID, a reused PID or an unread start time is left alone", async () => {
    const procs = fakeProcs({ 2: "2026-11-15T16:00:00.000Z", 3: "2026-11-15T17:30:00.000Z", 4: "2026-11-15T16:00:00.000Z", 5: "2026-11-15T16:00:00.000Z" });
    const base = { jobId: "run_0000000000000001", spawnedAt: "2026-11-15T16:00:00.000Z", kind: "chrome" };
    const list: JobProcess[] = [
      { ...base, pid: 1, startedAt: "2026-11-15T16:00:00.000Z" },          // gone already
      { ...base, pid: 2, startedAt: "2026-11-15T16:00:00.500Z" },          // still ours (same start within 2 s)
      { ...base, pid: 3, startedAt: "2026-11-15T16:00:00.000Z" },          // pid now belongs to a later process
      { ...base, pid: 4 },                                                 // start never read
      { ...base, pid: 5, startedAt: "2026-11-15T16:00:00.000Z", exitedAt: "2026-11-15T16:05:00.000Z" }, // exit seen by cc
    ];
    await settleProcesses(list, procs);
    expect(list.map((p) => p.endState)).toEqual(["exited", "killed", "pid-reused", "start-unknown", "exited"]);
    expect(procs.killed).toEqual([2]);
  });

  it("a real child launched inside a job is recorded (pid, OS start time, port, user-data-dir, lane, job id), returned by status, and killed by PID at the end", { timeout: 60_000 }, async () => {
    resetRunJobs();
    setJobProcDeps(undefined);
    let childPid = 0;
    const { job } = enqueueRun(req({ account: "pid-test" }), async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
      childPid = child.pid!;
      const rec = trackChild(child, { kind: "chrome", port: 9400, userDataDir: "/tmp/cc-run-0-test", cacheDir: "/tmp/cache/lane-0", lane: 0 });
      expect(rec?.jobId).toBe(currentJob()!.jobId);
      reportWorkDone({ ok: true, items: [] });
      return { ok: true, items: [] };
    });
    await waitForJob(job.id);
    const j = getRunJob(job.id)!;
    expect(j.processes).toHaveLength(1);
    const p = j.processes[0];
    expect(p).toMatchObject({ jobId: job.id, pid: childPid, kind: "chrome", port: 9400, userDataDir: "/tmp/cc-run-0-test", lane: 0 });
    expect(p.startedAt).toBeTruthy();
    expect(p.endState).toBe("killed");
    for (let i = 0; i < 20 && pidAlive(childPid); i++) await sleep(100);
    expect(pidAlive(childPid)).toBe(false);
    const status = jobToResult(j);
    expect(status.serverPid).toBe(process.pid);
    expect(status.processes?.[0].pid).toBe(childPid);
  });

  it("outside a job nothing is recorded (the page-backups tool and the CLI's seed/sign-in are not attributed to a job)", () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    expect(trackChild(child, { kind: "chrome" })).toBeUndefined();
    expect(currentJob()).toBeUndefined();
  });

  it("the default process probes read this process's own start time", { timeout: 30_000 }, () => {
    expect(defaultProcDeps.alive(process.pid)).toBe(true);
    expect(defaultProcDeps.startTime(process.pid)).toBeTruthy();
  });
});

describe("op=status over HTTP returns the job's processes and phase (REQ-D009, REQ-D008)", () => {
  const TOKEN = "t".repeat(40);
  let base = "";
  let close: () => void = () => {};
  beforeEach(async () => {
    resetRunJobs();
    setJobProcDeps(fakeProcs({}));
    process.env.CC_RUN_WAIT_MS = "20";
    const app = buildApp({
      token: TOKEN, registryPath: "registry/connectors.json", allowedHosts: ["localhost", "127.0.0.1"],
      runFn: async () => {
        currentJob()!.processes.push({ jobId: currentJob()!.jobId, pid: 777001, startedAt: "2026-11-15T16:00:00.000Z", spawnedAt: "2026-11-15T16:00:00.000Z", kind: "chrome", port: 9401, lane: 1, userDataDir: "C:/t/cc-run-1-a" });
        return failed("grok-login failed: exact");
      },
    });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => srv.close();
  });
  afterEach(() => { close(); resetRunJobs(); setJobProcDeps(undefined); delete process.env.CC_RUN_WAIT_MS; });

  it("status carries pid, port, lane and user-data-dir of the job's browser and the exact error", async () => {
    const rpc = async (args: Record<string, unknown>) => {
      const r = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": TOKEN }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cc_run", arguments: args } }) });
      const t = await r.text(); const m = /data: (.*)/.exec(t); return JSON.parse(JSON.parse(m ? m[1] : t).result.content[0].text);
    };
    const started = await rpc({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] });
    await settleJob(started.job_id, 500);
    const st = await rpc({ op: "status", job_id: started.job_id });
    expect(st.jobStatus).toBe("error");
    expect(st.phase).toBe("done");
    expect(st.items[0].detail).toBe("grok-login failed: exact");
    expect(st.processes[0]).toMatchObject({ pid: 777001, port: 9401, lane: 1, userDataDir: "C:/t/cc-run-1-a", jobId: started.job_id, endState: "exited" });
    expect(typeof st.serverPid).toBe("number");
  });
});
