import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { capacityByHardware, hasHeadroom, headroomLimits } from "./hostload.js";
import { waitForScreenFree, type HoldDeps } from "./screenHold.js";

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

const DEFAULT_MAX = 4;
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
  const body = JSON.stringify({ pid: process.pid, at: Date.now(), admitted: false });
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

/** Locks of lanes that are ADMITTED (running a browser) and held by live processes, not counting `except`, with when each was admitted. Lanes still waiting at the gate do not count. */
function activeLocks(dir: string, except: string): { at: number }[] {
  const out: { at: number }[] = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^slot-\d+\.lock$/.test(f) || path.join(dir, f) === except) continue;
    try { const cur = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { pid?: number; at?: number; admitted?: boolean }; if (typeof cur.pid === "number" && cur.admitted !== false && pidAlive(cur.pid)) out.push({ at: cur.at ?? Date.now() }); } catch { /* half-written lock: its owner has not been admitted yet */ }
  }
  return out;
}

const trace = (m: string) => { if (process.env.CC_TRACE) console.error(`[trace] ${m}`); };

/**
 * Politeness gate. A browser that is NOT the only one running is admitted only when ALL of these hold:
 *  1. hardware capacity: running browsers + 1 is within what the CPU can carry (cores x CC_ADMIT_MAX_CPU / ~1.7 cores per cc Chrome);
 *  2. settle time: the most recently started browser has been running at least CC_ADMIT_SETTLE_MS (default 8 s), because a browser's load
 *     only appears after it has launched and loaded its pages, and measuring CPU before that admits a whole herd at once (measured, it did);
 *  3. measured headroom: host CPU is below CC_ADMIT_MAX_CPU (default 60%) and free memory above CC_ADMIT_MIN_FREE_GB (1.5), which also
 *     accounts for everything else on the shared host.
 * The first browser is never held back, and a gate closed for CC_ADMIT_WAIT_MS (120 s) lets the browser through anyway: slow beats failed.
 * On a weak host this makes runs effectively sequential, on a strong one they overlap, with no configuration. Waiting costs no CPU.
 */
async function admit(dir: string, lock: string): Promise<void> {
  const markAdmitted = () => { try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), admitted: true })); } catch { /* the lock vanished; the run will fail loudly later */ } };
  if (process.env.CC_ADMIT === "off" || activeLocks(dir, lock).length === 0) { markAdmitted(); return; }
  // Decisions are made one browser at a time (a mutex), so two waiters cannot both see "room for one more" and both go.
  const mutex = path.join(dir, "admit.lock");
  const deadline = Date.now() + (Number(process.env.CC_ADMIT_WAIT_MS) || 120_000);
  for (;;) {
    try { fs.writeFileSync(mutex, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { const cur = JSON.parse(fs.readFileSync(mutex, "utf8")) as { pid?: number; at?: number }; if (typeof cur.pid !== "number" || !pidAlive(cur.pid) || Date.now() - (cur.at ?? 0) > 150_000) fs.rmSync(mutex, { force: true }); } catch { try { if (Date.now() - fs.statSync(mutex).mtimeMs > 5000) fs.rmSync(mutex, { force: true }); } catch { /* raced */ } }
      if (Date.now() > deadline) { trace("admission queue still busy after the wait limit; starting browser anyway"); markAdmitted(); return; }
      await sleep(300);
    }
  }
  try {
    const limits = headroomLimits();
    const capacity = capacityByHardware(limits);
    const settleMs = process.env.CC_ADMIT_SETTLE_MS === undefined ? 8000 : Number(process.env.CC_ADMIT_SETTLE_MS);
    let said = "";
    const say = (m: string) => { if (said !== m) { said = m; trace(m); } };
    for (;;) {
      const others = activeLocks(dir, lock);
      if (others.length === 0) return markAdmitted(); // everyone else finished while we waited
      if (Date.now() > deadline) { trace("host still busy after the wait limit; starting browser anyway"); return markAdmitted(); }
      const newest = Math.max(...others.map((o) => o.at));
      if (others.length + 1 > capacity) say(`waiting: ${others.length} browser(s) running, this hardware carries ${capacity}`);
      else if (Date.now() - newest < settleMs) say("waiting for the newest browser to settle before judging host load");
      else {
        const h = await hasHeadroom(limits);
        if (h.ok) { if (said) trace("host has headroom; starting browser"); return markAdmitted(); }
        say(`waiting for host headroom (cpu ${Math.round(h.cpu)}% of ${limits.maxCpuPercent}%, free ${h.freeGB.toFixed(1)} GB of ${limits.minFreeGB} GB)`);
      }
      await sleep(1000);
    }
  } finally { try { fs.rmSync(mutex, { force: true }); } catch { /* best effort */ } }
}

const held = new Set<string>();
let exitHook = false;

/**
 * Claim an idle lane, waiting (and saying so) when all are busy. Never returns a lane another caller holds.
 * Throws a clear error when no lane frees up within `waitMs`.
 */
export async function acquireLane(opts: { waitMs?: number; hold?: HoldDeps } = {}): Promise<Lane> {
  const dir = lanesDir();
  fs.mkdirSync(dir, { recursive: true });
  // REQ-D015: the screen hold. Every browser start passes here, so a screen in use (a screen-control session on this host, or a manual hold) stops it
  // BEFORE a lane is claimed and before any Chrome starts. Only starts are held; a run that already has its lane is not touched.
  await waitForScreenFree(dir, opts.hold);
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
      const lane: Lane = { index: i, port: base + i, release() { if (released) return; released = true; held.delete(lock); try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ } } };
      try { await admit(dir, lock); } catch (e) { lane.release(); throw e; }
      return lane;

    }
    if (Date.now() > deadline) throw new Error(`all ${max} cc browser lanes are busy (waited ${Math.round(waitMs / 1000)}s); another cc run is using them. Retry shortly, or raise CC_MAX_CONCURRENCY.`);
    await sleep(500);
  }
}
