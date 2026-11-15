// @reqs REQ-D003 REQ-D010
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import {
  enqueueRun,
  getRunJob,
  jobToResult,
  listRunJobs,
  resetRunJobs,
  settleJob,
  waitForJob,
} from "../src/core/runJobs.js";
import type { RunRequest, RunResult } from "../src/core/types.js";

const TOKEN = "t".repeat(40);

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  op: "update",
  connectors: ["helm-secret"],
  platforms: ["grok"],
  account: "ulostthegamers",
  ...over,
});

const okResult = (over: Partial<RunResult["items"][0]> = {}): RunResult => ({
  ok: true,
  items: [{ connector: "helm-secret", platform: "grok", op: "update", status: "ok", detail: "done", account: "ulostthegamers", ...over }],
});

describe("run jobs (REQ-D003)", () => {
  beforeEach(() => {
    resetRunJobs();
    delete process.env.CC_RUN_WAIT_MS;
    delete process.env.CC_RUN_LOG_DIR;
  });
  afterEach(() => resetRunJobs());

  it("a second start for the same account returns the in-flight job and does not call runFn again", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = enqueueRun(req(), async () => { calls += 1; await gate; return okResult(); });
    expect(first.started).toBe(true);
    const second = enqueueRun(req(), async () => { calls += 1; return okResult(); });
    expect(second.started).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(calls).toBe(1);
    release();
    const result = await waitForJob(first.job.id);
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(getRunJob(first.job.id)?.status).toBe("ok");
  });

  it("after the first run finishes, a second start for the same account is allowed", async () => {
    let calls = 0;
    const a = enqueueRun(req(), async () => { calls += 1; return okResult(); });
    await waitForJob(a.job.id);
    const b = enqueueRun(req(), async () => { calls += 1; return okResult({ detail: "second" }); });
    expect(b.started).toBe(true);
    expect(b.job.id).not.toBe(a.job.id);
    const result = await waitForJob(b.job.id);
    expect(result.items[0].detail).toBe("second");
    expect(calls).toBe(2);
  });

  it("runs for different accounts do not share a lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = enqueueRun(req({ account: "acct-a" }), async () => { await gate; return okResult({ account: "acct-a" }); });
    const b = enqueueRun(req({ account: "acct-b" }), async () => okResult({ account: "acct-b" }));
    expect(a.started && b.started).toBe(true);
    expect(a.job.id).not.toBe(b.job.id);
    await waitForJob(b.job.id);
    release();
    await waitForJob(a.job.id);
  });

  it("settleJob returns the running snapshot before the work finishes, then the result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { job } = enqueueRun(req(), async () => { await gate; return okResult(); });
    const mid = await settleJob(job.id, 20);
    expect(mid.status).toBe("running");
    expect(jobToResult(mid).job_id).toBe(job.id);
    expect(jobToResult(mid).jobStatus).toBe("running");
    expect(jobToResult(mid).detail).toMatch(/poll cc_run op=status/);
    release();
    const end = await settleJob(job.id, 200);
    expect(end.status).toBe("ok");
    expect(jobToResult(end).ok).toBe(true);
    expect(jobToResult(end).items[0].detail).toBe("done");
  });

  it("a thrown runFn becomes a finished error job and releases the lock", async () => {
    const { job } = enqueueRun(req(), async () => { throw new Error("boom-test"); });
    const result = await waitForJob(job.id);
    expect(result.ok).toBe(false);
    expect(result.items[0].detail).toBe("boom-test");
    expect(getRunJob(job.id)?.status).toBe("error");
    const again = enqueueRun(req(), async () => okResult());
    expect(again.started).toBe(true);
    await waitForJob(again.job.id);
  });
});

describe("cc_run jobs over HTTP (REQ-D003)", () => {
  const prevWait = process.env.CC_RUN_WAIT_MS;
  let base = "";
  let close: () => void = () => {};
  let finished = 0;
  let releases: Array<() => void> = [];

  const rpc = (body: unknown, init: RequestInit = {}) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": TOKEN, ...(init.headers as Record<string, string> | undefined) },
      body: JSON.stringify(body),
      signal: init.signal,
    });
  const parse = async (r: Response) => { const t = await r.text(); const m = /data: (.*)/.exec(t); return JSON.parse(m ? m[1] : t); };
  const call = (args: Record<string, unknown>, init: RequestInit = {}) =>
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cc_run", arguments: args } }, init);

  beforeEach(async () => {
    resetRunJobs();
    finished = 0;
    releases = [];
    process.env.CC_RUN_WAIT_MS = "30";
    const app = buildApp({
      token: TOKEN,
      registryPath: "registry/connectors.json",
      allowedHosts: ["localhost", "127.0.0.1"],
      runFn: async (_reg, request) => {
        if (request.dryRun) return { ok: true, items: [{ connector: request.connectors[0] ?? "*", platform: request.platforms[0], op: request.op, status: "dry-run", detail: "stub" }] };
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        releases.push(release);
        await gate;
        finished += 1;
        return { ok: true, items: [{ connector: request.connectors[0] ?? "*", platform: request.platforms[0], op: request.op, status: "ok", detail: "finished" }] };
      },
    });
    const srv = app.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    close = () => srv.close();
  });
  afterEach(() => {
    close();
    resetRunJobs();
    if (prevWait === undefined) delete process.env.CC_RUN_WAIT_MS;
    else process.env.CC_RUN_WAIT_MS = prevWait;
  });

  it("a non-dry-run returns a job_id quickly, and status reports running then the result", async () => {
    const started = await parse(await call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] }));
    expect(started.result.isError).toBeFalsy();
    const body = JSON.parse(started.result.content[0].text) as { job_id: string; jobStatus: string; detail: string };
    expect(body.jobStatus).toBe("running");
    expect(body.job_id).toMatch(/^run_[a-f0-9]{16}$/);
    expect(body.detail).toMatch(/poll cc_run op=status/);
    const mid = await parse(await call({ op: "status", job_id: body.job_id }));
    expect(JSON.parse(mid.result.content[0].text).jobStatus).toBe("running");
    expect(finished).toBe(0);
    releases[0]();
    await waitForJob(body.job_id);
    const end = await parse(await call({ op: "status", job_id: body.job_id }));
    const done = JSON.parse(end.result.content[0].text) as { jobStatus: string; ok: boolean; items: Array<{ detail: string }> };
    expect(done.jobStatus).toBe("ok");
    expect(done.ok).toBe(true);
    expect(done.items[0].detail).toBe("finished");
    expect(finished).toBe(1);
  });

  it("a second cc_run for the same account returns the existing job_id and does not start another run", async () => {
    const a = JSON.parse((await parse(await call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] }))).result.content[0].text);
    const b = JSON.parse((await parse(await call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] }))).result.content[0].text);
    expect(b.job_id).toBe(a.job_id);
    expect(listRunJobs()).toHaveLength(1);
    releases[0]();
    await waitForJob(a.job_id);
  });

  it("dry_run stays synchronous and does not take the long-run lock", async () => {
    const r = await parse(await call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"], dry_run: true }));
    const body = JSON.parse(r.result.content[0].text) as { items: Array<{ status: string }>; job_id?: string };
    expect(body.items[0].status).toBe("dry-run");
    expect(body.job_id).toBeUndefined();
    expect(listRunJobs()).toHaveLength(0);
    const live = await parse(await call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] }));
    const job = JSON.parse(live.result.content[0].text) as { job_id: string };
    expect(job.job_id).toMatch(/^run_/);
    releases[0]();
    await waitForJob(job.job_id);
  });

  it("status with an unknown or missing job_id is refused", async () => {
    const missing = await parse(await call({ op: "status" }));
    expect(missing.result.isError).toBeTruthy();
    expect(missing.result.content[0].text).toMatch(/job_id/);
    const unknown = await parse(await call({ op: "status", job_id: "run_0123456789abcdef" }));
    expect(unknown.result.isError).toBeTruthy();
    expect(unknown.result.content[0].text).toMatch(/unknown job_id/);
  });

  it("closing the MCP HTTP request does not cancel a running job", async () => {
    const ac = new AbortController();
    const pending = call({ op: "update", account: "ulostthegamers", connectors: ["helm-secret"], platforms: ["grok"] }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    await pending.catch(() => undefined);
    expect(listRunJobs()).toHaveLength(1);
    expect(listRunJobs()[0].status).toBe("running");
    expect(finished).toBe(0);
    releases[0]();
    const result = await waitForJob(listRunJobs()[0].id);
    expect(result.ok).toBe(true);
    expect(finished).toBe(1);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportStep } from "../src/core/jobProcs.js";

describe("REQ-D010 AC7: a login's step line reaches the job's run log", () => {
  beforeEach(() => resetRunJobs());
  afterEach(() => { resetRunJobs(); delete process.env.CC_RUN_LOG_DIR; });

  it("TC-D010-25 inside a job, reportStep writes a step line to logs/runs/<job>.log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-d010-"));
    process.env.CC_RUN_LOG_DIR = dir;
    try {
      const { job } = enqueueRun(req({ op: "verify", account: "tc-d010-25" }), async () => {
        reportStep("grok-login mode=headful human-check=auto-solved clicks=0");
        return okResult();
      });
      await waitForJob(job.id);
      const log = fs.readFileSync(path.join(dir, `${job.id}.log`), "utf8");
      expect(log).toMatch(new RegExp(`${job.id} account=tc-d010-25 op=verify step grok-login mode=headful human-check=auto-solved clicks=0`));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("TC-D010-26 outside a job, reportStep writes nothing and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-d010-"));
    process.env.CC_RUN_LOG_DIR = dir;
    try {
      expect(() => reportStep("grok-login mode=headful human-check=none")).not.toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
