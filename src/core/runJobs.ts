// @reqs REQ-D003 REQ-D005 REQ-D008 REQ-D009
/**
 * Long cc_run work (anything that opens a browser) lives in a job that is not tied to one MCP HTTP request.
 * A client timeout or disconnect does not cancel it. One run at a time per account: a second start in this
 * process returns the in-flight job; a second start in another process is refused (file lock in cc's data dir).
 *
 * REQ-D008: the job's status follows the work, not the browser cleanup. Each finished item is visible at once,
 * and when the work is done (ok or failed, with the exact error) op=status says so right away, even while the
 * browser is still being shut down. Cleanup is bounded: after CC_JOB_CLEANUP_MS the job's own recorded PIDs are
 * killed and its lock is released, so a wedged shutdown can never leave a job "running" or block the next run.
 * REQ-D009: the job records the PID and OS start time of every process it launched; at the end each is confirmed
 * exited or exactly that PID is killed.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tryAcquireAccountLock, ccDataDir, type HeldLock } from "./runLock.js";
import { runInJob, settleProcesses, defaultProcDeps, type JobProcess, type ProcDeps } from "./jobProcs.js";
import type { ItemResult, Platform, RunRequest, RunResult } from "./types.js";

export type JobStatus = "running" | "ok" | "error";
/** work: adapters are acting; cleanup: work is done, the browser is being shut down; done: everything ended; cleanup-timeout: shutdown overran, recorded PIDs were settled and the lock released. */
export type JobPhase = "work" | "cleanup" | "done" | "cleanup-timeout";

export interface RunJob {
  id: string;
  account: string;
  op: string;
  connectors: string[];
  platforms: string[];
  startedAt: string;
  finishedAt?: string;
  status: JobStatus;
  phase: JobPhase;
  result?: RunResult;
  detail?: string;
  /** Items finished so far (REQ-D008), shown while the job is still running. */
  items: ItemResult[];
  /** The cc server (or CLI) process that runs this job. */
  serverPid: number;
  /** Every process this job launched (REQ-D009). */
  processes: JobProcess[];
}

type Internal = RunJob & { done: Promise<RunResult> };

const jobs = new Map<string, Internal>();
const inflight = new Map<string, string>();

export const DEFAULT_CLEANUP_MS = 90_000;
let procDeps: ProcDeps = defaultProcDeps;
/** Tests inject fake process probes. */
export function setJobProcDeps(d: ProcDeps | undefined): void { procDeps = d ?? defaultProcDeps; }

export function resetRunJobs(): void {
  jobs.clear();
  inflight.clear();
}

export function getRunJob(id: string): RunJob | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  const { done: _done, ...pub } = j;
  return { ...pub, connectors: [...pub.connectors], platforms: [...pub.platforms], items: [...pub.items], processes: pub.processes.map((p) => ({ ...p })) };
}

export function listRunJobs(): RunJob[] {
  return [...jobs.keys()].map((id) => getRunJob(id)!);
}

function runLogDir(): string | undefined {
  if (process.env.CC_RUN_LOG_DIR) return process.env.CC_RUN_LOG_DIR;
  try { return path.join(ccDataDir(), "logs", "runs"); } catch { return undefined; }
}

function logLine(job: RunJob, event: string, extra?: string): void {
  // Account ids, ops, statuses and pids only: never emails, URLs, tokens or passwords.
  const line = `${new Date().toISOString()} ${job.id} account=${job.account || "-"} op=${job.op} ${event}${extra ? " " + extra : ""}\n`;
  try {
    const dir = runLogDir();
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${job.id}.log`), line);
  } catch { /* a log write must never fail a run */ }
}

const procSummary = (ps: JobProcess[]) => ps.map((p) => `${p.kind}:pid=${p.pid}${p.port ? `:port=${p.port}` : ""}${p.lane !== undefined ? `:lane=${p.lane}` : ""}${p.endState ? `:${p.endState}` : ""}`).join(",") || "none";

function accountKey(account: string | undefined): string | undefined {
  const a = account?.trim().toLowerCase();
  return a || undefined;
}

function refusedOtherProcess(req: RunRequest, holderPid?: number): { job: RunJob; started: false } {
  const who = typeof holderPid === "number" ? ` (pid ${holderPid})` : "";
  const detail = `a run is already in progress for this account in another process${who}; this start is refused so browsers are not stacked`;
  const platform = (req.platforms[0] ?? "grok") as Platform;
  const items: ItemResult[] = [{ connector: req.connectors.join(",") || "*", platform, op: req.op, status: "error", detail, account: req.account }];
  const job: RunJob = {
    id: "",
    account: accountKey(req.account) ?? "",
    op: req.op,
    connectors: [...req.connectors],
    platforms: [...(req.platforms as string[])],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "error",
    phase: "done",
    detail,
    items,
    serverPid: process.pid,
    processes: [],
    result: { ok: false, items },
  };
  return { job, started: false };
}

const itemsDetail = (items: ItemResult[]) => items.map((i) => `${i.op} ${i.connector}@${i.platform} ${i.status}${i.status === "error" && i.detail ? `: ${i.detail}` : ""}`).join("; ");

export function enqueueRun(req: RunRequest, fn: () => Promise<RunResult>, opts: { cleanupMs?: number } = {}): { job: RunJob; started: boolean } {
  const key = accountKey(req.account);
  if (key) {
    const existingId = inflight.get(key);
    if (existingId) {
      const ex = jobs.get(existingId);
      if (ex && ex.phase !== "done" && ex.phase !== "cleanup-timeout") return { job: getRunJob(existingId)!, started: false };
    }
  }
  let fileLock: HeldLock | undefined;
  if (key) {
    const claim = tryAcquireAccountLock(key, req.op);
    if (!claim.ok) return refusedOtherProcess(req, claim.holder?.pid);
    fileLock = claim.lock;
  }
  const cleanupMs = opts.cleanupMs ?? (Number(process.env.CC_JOB_CLEANUP_MS) || DEFAULT_CLEANUP_MS);
  const id = "run_" + randomBytes(8).toString("hex");
  const job: Internal = {
    id,
    account: key ?? "",
    op: req.op,
    connectors: [...req.connectors],
    platforms: [...req.platforms],
    startedAt: new Date().toISOString(),
    status: "running",
    phase: "work",
    items: [],
    serverPid: process.pid,
    processes: [],
    done: Promise.resolve({ ok: false, items: [] } as RunResult),
  };
  jobs.set(id, job);
  if (key) inflight.set(key, id);
  logLine(job, "started", `connectors=${job.connectors.join(",") || "*"} platforms=${job.platforms.join(",")} serverPid=${process.pid}`);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (key && inflight.get(key) === id) inflight.delete(key);
    try { fileLock?.release(); } catch { /* best effort */ }
  };
  const finish = (result: RunResult, how: string) => {
    if (job.status !== "running") return;
    job.result = result;
    job.status = result.ok ? "ok" : "error";
    job.finishedAt = new Date().toISOString();
    job.detail = itemsDetail(result.items);
    logLine(job, how, `ok=${result.ok} ${job.detail}`);
  };
  let cleanupTimer: NodeJS.Timeout | undefined;
  const settle = async (phase: JobPhase) => {
    if (job.phase === "done" || job.phase === "cleanup-timeout") return;
    job.phase = phase;
    await settleProcesses(job.processes, procDeps).catch(() => undefined);
    logLine(job, phase === "done" ? "ended" : "cleanup-timeout", `processes=${procSummary(job.processes)}`);
    release();
  };
  const hooks = {
    jobId: id,
    processes: job.processes,
    onItem: (item: unknown) => { job.items.push(item as ItemResult); logLine(job, "item", itemsDetail([item as ItemResult])); },
    onWorkDone: (result: unknown) => {
      finish(result as RunResult, "work-done");
      if (job.phase === "work") job.phase = "cleanup";
      cleanupTimer = setTimeout(() => { void settle("cleanup-timeout"); }, cleanupMs);
      cleanupTimer.unref?.();
    },
  };
  job.done = (async () => {
    try {
      const result = await runInJob(hooks, fn);
      finish(result, "finished");
      return job.result ?? result;
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const platform = (req.platforms[0] ?? "grok") as Platform;
      finish({ ok: false, items: [{ connector: req.connectors.join(",") || "*", platform, op: req.op, status: "error", detail: msg, account: req.account }] }, "failed");
      return job.result!;
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      await settle("done");
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
  const extra = { job_id: job.id || undefined, phase: job.phase, serverPid: job.serverPid, processes: job.processes };
  if (job.status === "running") {
    return {
      ok: true,
      ...extra,
      jobStatus: "running",
      items: [...job.items],
      detail: `run started as ${job.id}; poll cc_run op=status job_id=${job.id}. The run is not cancelled if this client disconnects.`,
    };
  }
  const base = job.result ?? { ok: job.status === "ok", items: job.items };
  return { ...base, ...extra, jobStatus: job.status, detail: base.detail ?? job.detail };
}
