// @reqs REQ-D005
/**
 * A file lock in cc's data dir, shared by the MCP server and the CLI so two processes cannot
 * open a browser for the same account at once. A lock whose pid is dead, or that is older than
 * STALE_MS, is removed and the claim is retried.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STALE_MS = 45 * 60_000;

export interface LockHolder {
  pid: number;
  at: number;
  account: string;
  op?: string;
}

export interface LockDeps {
  dir?: string;
  now?: () => number;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
  staleMs?: number;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** HELM data root + dataDirName, or CC_DATA_DIR when set. Never includes secrets. */
export function ccDataDir(e = process.env, platform = process.platform, home = os.homedir()): string {
  if (e.CC_DATA_DIR) return e.CC_DATA_DIR;
  const app = (JSON.parse(fs.readFileSync(path.resolve("data", "app.json"), "utf8")) as { dataDirName: string }).dataDirName;
  if (e.HELM_DATA_ROOT) return path.join(e.HELM_DATA_ROOT, app);
  if (platform === "win32") return path.join(e.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "HELM", app);
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "HELM", app);
  return path.join(e.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "helm", app);
}

export function accountLockKey(account: string): string {
  const key = account.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "_").replace(/^_+|_+$/g, "");
  return (key || "unknown").slice(0, 64);
}

export function runLockDir(deps: LockDeps = {}): string {
  return deps.dir ?? process.env.CC_RUN_LOCK_DIR ?? path.join(ccDataDir(), "locks");
}

export function runLockPath(account: string, deps: LockDeps = {}): string {
  return path.join(runLockDir(deps), `run-${accountLockKey(account)}.lock`);
}

export interface HeldLock {
  path: string;
  holder: LockHolder;
  release: () => void;
}

function readHolder(file: string): LockHolder | undefined {
  try {
    const cur = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockHolder>;
    if (typeof cur.pid !== "number" || typeof cur.account !== "string") return undefined;
    return { pid: cur.pid, at: typeof cur.at === "number" ? cur.at : 0, account: cur.account, op: typeof cur.op === "string" ? cur.op : undefined };
  } catch { return undefined; }
}

function isStale(file: string, holder: LockHolder | undefined, deps: LockDeps, now: number): boolean {
  const alive = deps.pidAlive ?? pidAlive;
  const staleMs = deps.staleMs ?? STALE_MS;
  if (!holder) {
    try { return now - fs.statSync(file).mtimeMs > 5000; } catch { return true; }
  }
  return !alive(holder.pid) || now - holder.at > staleMs;
}

/**
 * Try to claim the per-account run lock. On success the caller MUST release() (also in a finally).
 * A live lock held by another process returns ok: false and that holder (pid, at, account, op only).
 */
export function tryAcquireAccountLock(account: string, op: string | undefined, deps: LockDeps = {}): { ok: true; lock: HeldLock } | { ok: false; holder?: LockHolder } {
  const key = account.trim();
  if (!key) return { ok: true, lock: { path: "", holder: { pid: deps.pid ?? process.pid, at: (deps.now ?? Date.now)(), account: "" }, release() {} } };
  const file = runLockPath(key, deps);
  const nowFn = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 3; i++) {
    const holder: LockHolder = { pid, at: nowFn(), account: accountLockKey(key), op };
    // Only pid, at, account id, op: never emails, URLs, tokens or passwords.
    try {
      fs.writeFileSync(file, JSON.stringify(holder), { flag: "wx" });
      let released = false;
      return {
        ok: true,
        lock: {
          path: file,
          holder,
          release() {
            if (released) return;
            released = true;
            try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
          },
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const cur = readHolder(file);
      if (!isStale(file, cur, deps, nowFn())) return { ok: false, holder: cur };
      try { fs.rmSync(file, { force: true }); } catch { /* raced */ }
    }
  }
  return { ok: false, holder: readHolder(file) };
}
