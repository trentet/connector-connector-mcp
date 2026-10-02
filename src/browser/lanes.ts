import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Lane slots: the cross-process cap on concurrent cc browsers, and the owner of each browser's CDP port.
 * A lane is a numbered slot (port = base + index) claimed with an exclusive lock file, so the CLI, the MCP server and
 * any number of callers agree on who holds what without sharing memory. A lane lives exactly as long as one run.
 */
export interface Lane {
  index: number;
  port: number;
  release(): void;
}

const DEFAULT_MAX = 6;
const DEFAULT_PORT_BASE = 9400;
const DEFAULT_WAIT_MS = 120_000;
/** A lock older than this is treated as dead even if its pid is alive (pid reuse, wedged run). */
const MAX_LOCK_AGE_MS = 45 * 60_000;

export const lanesDir = () => process.env.CC_LANES_DIR ?? path.join(os.tmpdir(), "cc-lanes");
export const maxLanes = () => Math.max(1, Number(process.env.CC_MAX_CONCURRENCY ?? DEFAULT_MAX) || DEFAULT_MAX);
export const portBase = () => Number(process.env.CC_LANE_PORT_BASE ?? DEFAULT_PORT_BASE) || DEFAULT_PORT_BASE;

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when something accepts connections on the port (a foreign process holding a lane's port). */
export const portInUse = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
  s.setTimeout(800, () => { s.destroy(); resolve(false); });
});

function tryClaim(dir: string, index: number): string | undefined {
  const lock = path.join(dir, `slot-${index}.lock`);
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, body, { flag: "wx" }); return lock; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const cur = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; at?: number };
        stale = typeof cur.pid !== "number" || !pidAlive(cur.pid) || Date.now() - (cur.at ?? 0) > MAX_LOCK_AGE_MS;
      } catch {
        // Unreadable: either the writer is between create and write (fresh file), or the lock is garbage (old file).
        try { stale = Date.now() - fs.statSync(lock).mtimeMs > 5000; } catch { stale = true; }
      }
      if (!stale) return undefined;
      try { fs.rmSync(lock, { force: true }); } catch { return undefined; }
    }
  }
  return undefined;
}

const held = new Set<string>();
let exitHook = false;

/**
 * Claim an idle lane, waiting (and saying so) when all are busy. Never returns a lane another caller holds.
 * Throws a clear error when no lane frees up within `waitMs`.
 */
export async function acquireLane(opts: { waitMs?: number } = {}): Promise<Lane> {
  const dir = lanesDir();
  fs.mkdirSync(dir, { recursive: true });
  const max = maxLanes(), base = portBase();
  const waitMs = opts.waitMs ?? (Number(process.env.CC_LANE_WAIT_MS) || DEFAULT_WAIT_MS);
  if (!exitHook) { exitHook = true; process.on("exit", () => { for (const l of held) { try { fs.rmSync(l, { force: true }); } catch { /* best effort */ } } }); }
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (let i = 0; i < max; i++) {
      const lock = tryClaim(dir, i);
      if (!lock) continue;
      if (await portInUse(base + i)) { try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ } continue; } // a foreign process owns that port: skip the slot
      held.add(lock);
      let released = false;
      return { index: i, port: base + i, release() { if (released) return; released = true; held.delete(lock); try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ } } };
    }
    if (Date.now() > deadline) throw new Error(`all ${max} cc browser lanes are busy (waited ${Math.round(waitMs / 1000)}s); another cc run is using them. Retry shortly, or raise CC_MAX_CONCURRENCY.`);
    await sleep(500);
  }
}
