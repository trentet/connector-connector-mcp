// @reqs REQ-D003
/**
 * Long cc_run work (anything that opens a browser) lives in a job that is not tied to one MCP HTTP request.
 * A client timeout or disconnect does not cancel it. One run at a time per account: a second start returns the
 * in-flight job instead of opening another browser.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Platform, RunRequest, RunResult } from "./types.js";

export type JobStatus = "running" | "ok" | "error";

export interface RunJob {
  id: string;
  account: string;
  op: string;
  connectors: string[];
  platforms: string[];
  startedAt: string;
  finishedAt?: string;
  status: JobStatus;
  result?: RunResult;
  detail?: string;
}

type Internal = RunJob & { done: Promise<RunResult> };

const jobs = new Map<string, Internal>();
const inflight = new Map<string, string>();

export function resetRunJobs(): void {
  jobs.clear();
  inflight.clear();
}

export function getRunJob(id: string): RunJob | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  const { done: _done, ...pub } = j;
  return { ...pub, connectors: [...pub.connectors], platforms: [...pub.platforms] };
}

export function listRunJobs(): RunJob[] {
  return [...jobs.keys()].map((id) => getRunJob(id)!);
}

function logLine(job: RunJob, event: string, extra?: string): void {
  // Account ids, ops and statuses only: never emails, URLs, tokens or passwords.
  const line = `${new Date().toISOString()} ${job.id} account=${job.account || "-"} op=${job.op} ${event}${extra ? " " + extra : ""}\n`;
  try {
    const dir = process.env.CC_RUN_LOG_DIR ?? (fs.existsSync(path.resolve("logs")) ? path.resolve("logs", "runs") : undefined);
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${job.id}.log`), line);
  } catch { /* a log write must never fail a run */ }
}

function accountKey(account: string | undefined): string | undefined {
  const a = account?.trim().toLowerCase();
  return a || undefined;
}

export function enqueueRun(req: RunRequest, fn: () => Promise<RunResult>): { job: RunJob; started: boolean } {
  const key = accountKey(req.account);
  if (key) {
    const existingId = inflight.get(key);
    if (existingId) {
      const ex = jobs.get(existingId);
      if (ex && ex.status === "running") return { job: getRunJob(existingId)!, started: false };
    }
  }
  const id = "run_" + randomBytes(8).toString("hex");
  const job: Internal = {
    id,
    account: key ?? "",
    op: req.op,
    connectors: [...req.connectors],
    platforms: [...req.platforms],
    startedAt: new Date().toISOString(),
    status: "running",
    done: Promise.resolve({ ok: false, items: [] } as RunResult),
  };
  jobs.set(id, job);
  if (key) inflight.set(key, id);
  logLine(job, "started", `connectors=${job.connectors.join(",") || "*"} platforms=${job.platforms.join(",")}`);
  job.done = (async () => {
    try {
      const result = await fn();
      job.result = result;
      job.status = result.ok ? "ok" : "error";
      job.finishedAt = new Date().toISOString();
      job.detail = result.items.map((i) => `${i.op} ${i.connector}@${i.platform} ${i.status}`).join("; ");
      logLine(job, "finished", `ok=${result.ok} ${job.detail ?? ""}`);
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      job.status = "error";
      job.finishedAt = new Date().toISOString();
      job.detail = msg;
      const platform = (req.platforms[0] ?? "grok") as Platform;
      job.result = { ok: false, items: [{ connector: req.connectors.join(",") || "*", platform, op: req.op, status: "error", detail: msg, account: req.account }] };
      logLine(job, "failed", msg);
      return job.result;
    } finally {
      if (key && inflight.get(key) === id) inflight.delete(key);
    }
  })();
  return { job: getRunJob(id)!, started: true };
}

export function waitForJob(id: string): Promise<RunResult> {
  const j = jobs.get(id);
  if (!j) {
    return Promise.resolve({ ok: false, items: [{ connector: "*", platform: "grok", op: "verify", status: "error", detail: `unknown job_id` }] });
  }
  return j.done;
}

export async function settleJob(id: string, waitMs: number): Promise<RunJob> {
  const j = jobs.get(id);
  if (!j) throw new Error("unknown job_id");
  if (j.status === "running") await Promise.race([j.done, new Promise<void>((r) => setTimeout(r, Math.max(0, waitMs)))]);
  return getRunJob(id)!;
}

export function jobToResult(job: RunJob): RunResult {
  if (job.status === "running") {
    return {
      ok: true,
      job_id: job.id,
      jobStatus: "running",
      items: [],
      detail: `run started as ${job.id}; poll cc_run op=status job_id=${job.id}. The run is not cancelled if this client disconnects.`,
    };
  }
  const base = job.result ?? { ok: job.status === "ok", items: [] };
  return { ...base, job_id: job.id, jobStatus: job.status, detail: base.detail ?? job.detail };
}
