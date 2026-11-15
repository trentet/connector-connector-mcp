// @reqs REQ-D009
/**
 * Every process a cc job launches is recorded by PID in that job's state (REQ-D009): the PID, the time the
 * process started (read from the OS, so a reused PID is told apart), what it is, its CDP port, user-data-dir,
 * cache dir and lane, and the job id. On a host shared by dozens of scripts, a process is ours only when its
 * PID AND its start time match a record; names, ports and folder names are never used to decide.
 * At job end each recorded PID is confirmed exited, or exactly that PID (and its tree) is killed. Never by name.
 *
 * The job context rides on AsyncLocalStorage, so launchChrome (deep in src/browser) records into the job that
 * called it without any caller passing it along. Outside a job nothing is recorded.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";

export type ProcEndState = "exited" | "killed" | "still-running" | "pid-reused" | "start-unknown";

export interface JobProcess {
  jobId: string;
  pid: number;
  /** Start time as the OS reports it (ISO). Undefined when it could not be read; such a PID is never killed. */
  startedAt?: string;
  /** When cc spawned it (ISO, this process's clock). */
  spawnedAt: string;
  /** "chrome" (a run's browser root), "chrome-merge" (cookie merge into the master), "desktop-helper" (REQ-D006 launcher). */
  kind: string;
  port?: number;
  userDataDir?: string;
  cacheDir?: string;
  lane?: number;
  exitedAt?: string;
  endState?: ProcEndState;
  endDetail?: string;
}

export interface JobHooks {
  jobId: string;
  processes: JobProcess[];
  onItem?: (item: unknown) => void;
  onWorkDone?: (result: unknown) => void;
}

const als = new AsyncLocalStorage<JobHooks>();

export function runInJob<T>(hooks: JobHooks, fn: () => Promise<T>): Promise<T> {
  return als.run(hooks, fn);
}

export function currentJob(): JobHooks | undefined {
  return als.getStore();
}

/** The runner reports each finished item, and the moment the work (not the browser cleanup) is done. No-ops outside a job. */
export function reportItem(item: unknown): void {
  try { als.getStore()?.onItem?.(item); } catch { /* a report must never fail a run */ }
}
export function reportWorkDone(result: unknown): void {
  try { als.getStore()?.onWorkDone?.(result); } catch { /* a report must never fail a run */ }
}

export interface ProcDeps {
  alive(pid: number): boolean;
  /** OS start time of the pid (ISO), or undefined when it cannot be read. */
  startTime(pid: number): string | undefined;
  /** Kill exactly this pid and its child tree. */
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** OS start time of a pid. Windows: Get-Process StartTime; Linux: /proc/<pid> creation time. Undefined on any failure. */
export function osStartTime(pid: number, platform = process.platform): string | undefined {
  try {
    if (platform === "win32") {
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      const t = (r.stdout ?? "").trim();
      return r.status === 0 && t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined;
    }
    const st = fs.statSync(`/proc/${Math.trunc(pid)}`);
    return new Date(st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs).toISOString();
  } catch { return undefined; }
}

export function killPidTree(pid: number, platform = process.platform): void {
  try {
    if (platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(Math.trunc(pid))], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
}

export const defaultProcDeps: ProcDeps = {
  alive: pidAlive,
  startTime: (pid) => osStartTime(pid),
  kill: (pid) => killPidTree(pid),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Start times are the same process when they agree to within this (OS clocks round differently). */
export const SAME_START_MS = 2000;

function sameStart(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_START_MS;
}

/**
 * Record a process this job launched. Returns the record (or undefined outside a job). The child's exit fills exitedAt.
 * startTime is read once from the OS right after the spawn.
 */
export function trackChild(child: ChildProcess, meta: { kind: string; port?: number; userDataDir?: string; cacheDir?: string; lane?: number }, deps: Pick<ProcDeps, "startTime"> = defaultProcDeps): JobProcess | undefined {
  const job = als.getStore();
  if (!job || !child.pid) return undefined;
  const rec: JobProcess = { jobId: job.jobId, pid: child.pid, spawnedAt: new Date().toISOString(), ...meta };
  job.processes.push(rec);
  const mark = () => { if (!rec.exitedAt) rec.exitedAt = new Date().toISOString(); };
  if (child.exitCode !== null || child.signalCode !== null) mark();
  else { child.once("exit", mark); child.once("error", mark); }
  if (!rec.exitedAt) rec.startedAt = deps.startTime(child.pid);
  return rec;
}

/**
 * At job end: every recorded process is confirmed exited, or exactly that PID is killed and its exit confirmed.
 * A PID now held by a process with another start time is someone else's (pid-reused) and is left alone, as is a
 * PID whose start time was never read (start-unknown). Returns the same records with endState set.
 */
export async function settleProcesses(procs: JobProcess[], deps: ProcDeps = defaultProcDeps, opts: { confirmMs?: number } = {}): Promise<JobProcess[]> {
  const confirmMs = opts.confirmMs ?? 5000;
  for (const p of procs) {
    if (p.endState) continue;
    if (p.exitedAt || !deps.alive(p.pid)) { p.endState = "exited"; p.exitedAt ??= new Date().toISOString(); continue; }
    const now = deps.startTime(p.pid);
    if (!p.startedAt) { p.endState = "start-unknown"; p.endDetail = "start time was never read, so the pid is not killed"; continue; }
    if (!now) { p.endState = "start-unknown"; p.endDetail = `pid ${p.pid} is alive but its start time cannot be read, so it is not killed`; continue; }
    if (!sameStart(now, p.startedAt)) { p.endState = "pid-reused"; p.endDetail = `pid ${p.pid} now belongs to a process started ${now}; left alone`; continue; }
    deps.kill(p.pid);
    let gone = false;
    for (let waited = 0; waited <= confirmMs; waited += 500) {
      if (!deps.alive(p.pid) || !sameStart(deps.startTime(p.pid), p.startedAt)) { gone = true; break; }
      await deps.sleep(500);
    }
    if (gone) { p.endState = "killed"; p.exitedAt = new Date().toISOString(); }
    else { p.endState = "still-running"; p.endDetail = `pid ${p.pid} did not exit after taskkill`; }
  }
  return procs;
}
