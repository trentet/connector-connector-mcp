// @reqs REQ-D005
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STALE_MS, runLockPath, tryAcquireAccountLock, type LockHolder } from "../src/core/runLock.js";
import { enqueueRun, resetRunJobs, waitForJob } from "../src/core/runJobs.js";
import type { RunRequest, RunResult } from "../src/core/types.js";

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  op: "update",
  connectors: ["helm-secret"],
  platforms: ["grok"],
  account: "ulostthegamers",
  ...over,
});

const okResult = (): RunResult => ({
  ok: true,
  items: [{ connector: "helm-secret", platform: "grok", op: "update", status: "ok", detail: "done", account: "ulostthegamers" }],
});

describe("cross-process account run lock (REQ-D005)", () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-run-lock-"));
    previous = process.env.CC_RUN_LOCK_DIR;
    process.env.CC_RUN_LOCK_DIR = dir;
    resetRunJobs();
  });
  afterEach(() => {
    resetRunJobs();
    if (previous === undefined) delete process.env.CC_RUN_LOCK_DIR;
    else process.env.CC_RUN_LOCK_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a second claim for the same account is refused while the first is held", () => {
    const first = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 111 });
    expect(first.ok).toBe(true);
    const second = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 222, pidAlive: (p) => p === 111 || p === 222 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.holder?.pid).toBe(111);
      expect(second.holder?.account).toBe("ulostthegamers");
      expect(second.holder?.op).toBe("update");
    }
    if (first.ok) first.lock.release();
  });

  it("after release, a second claim is allowed", () => {
    const first = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 111 });
    expect(first.ok).toBe(true);
    if (first.ok) first.lock.release();
    const second = tryAcquireAccountLock("ulostthegamers", "list", { dir, pid: 222, pidAlive: (p) => p === 222 });
    expect(second.ok).toBe(true);
    if (second.ok) second.lock.release();
  });

  it("a lock whose pid is dead is recovered and can be claimed", () => {
    const stale: LockHolder = { pid: 999001, at: Date.now(), account: "ulostthegamers", op: "update" };
    fs.writeFileSync(runLockPath("ulostthegamers", { dir }), JSON.stringify(stale));
    const claim = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 333, pidAlive: (p) => p === 333 });
    expect(claim.ok).toBe(true);
    if (claim.ok) claim.lock.release();
  });

  it("a lock older than STALE_MS is recovered even if the pid looks alive", () => {
    const now = 10_000_000;
    const stale: LockHolder = { pid: 444, at: now - STALE_MS - 1, account: "ulostthegamers", op: "update" };
    fs.writeFileSync(runLockPath("ulostthegamers", { dir }), JSON.stringify(stale));
    const claim = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 555, now: () => now, pidAlive: () => true });
    expect(claim.ok).toBe(true);
    if (claim.ok) claim.lock.release();
  });

  it("the lock file records only pid, at, account id and op", () => {
    const first = tryAcquireAccountLock("ulostthegamers", "update", { dir, pid: 111 });
    expect(first.ok).toBe(true);
    const raw = fs.readFileSync(runLockPath("ulostthegamers", { dir }), "utf8");
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["account", "at", "op", "pid"]);
    expect(raw).not.toMatch(/@|token|password|http/i);
    if (first.ok) first.lock.release();
  });

  it("enqueueRun in a second process-style start is refused while a file lock is held, and does not call runFn", async () => {
    const held = tryAcquireAccountLock("ulostthegamers", "update", { dir });
    expect(held.ok).toBe(true);
    let calls = 0;
    const second = enqueueRun(req(), async () => { calls += 1; return okResult(); });
    expect(second.started).toBe(false);
    expect(second.job.status).toBe("error");
    expect(second.job.result?.ok).toBe(false);
    expect(second.job.result?.items[0].detail).toMatch(/already in progress/);
    expect(calls).toBe(0);
    if (held.ok) held.lock.release();
    const after = enqueueRun(req(), async () => { calls += 1; return okResult(); });
    expect(after.started).toBe(true);
    await waitForJob(after.job.id);
    expect(calls).toBe(1);
  });

  it("dry_run does not take the file lock (enqueue is not used for dry_run; a live lock is left alone)", () => {
    const first = tryAcquireAccountLock("ulostthegamers", "update", { dir });
    expect(first.ok).toBe(true);
    expect(fs.existsSync(runLockPath("ulostthegamers", { dir }))).toBe(true);
    if (first.ok) first.lock.release();
  });
});
