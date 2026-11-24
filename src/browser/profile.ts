import fs from "node:fs";
import path from "node:path";

/**
 * The cold master profile and per-run clones of it.
 *
 * Every cc run gets its OWN Chrome process on its OWN copy of the master's sign-in state, so concurrent runs cannot touch
 * each other's tabs or contexts. The master is never opened by a browser while runs clone from it (a Chrome running on it
 * holds locks that make a copy unreliable). Sign-in cookies a run rotated are merged back cookie by cookie (chrome.ts) by a
 * short-lived Chrome that holds the master lock, so a clone never sees a half-written master.
 */

/** Sign-in state copied into every run's profile (paths relative to the user-data-dir). Caches, extensions and history stay behind. */
const CLONE_ENTRIES = [
  "Local State",
  "First Run",
  "Default/Preferences",
  "Default/Secure Preferences",
  "Default/Network/Cookies", // Chrome on Windows/macOS
  "Default/Network/Cookies-journal",
  "Default/Cookies", // some Chromium builds (e.g. Linux) keep the cookie DB here
  "Default/Cookies-journal",
  "Default/Network/Network Persistent State",
  "Default/Local Storage",
  "Default/Session Storage",
  "Default/IndexedDB",
  "Default/Web Data",
];
const LOCK_FILE = "cc-master.lock";
const LOCK_STALE_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** True when a Chrome is running on this user-data-dir (so it is not a cold master). */
export function profileInUse(dir: string): boolean {
  try {
    if (process.platform === "win32") {
      // Chrome keeps <dir>\lockfile open for as long as it runs and deletes it on exit. Some Chrome versions (157 on the W540) share it for reading, so
      // a read-only open succeeds while Chrome runs; every version refuses an open for writing (EBUSY), so that is the test (REQ-D015).
      const f = path.join(dir, "lockfile");
      if (!fs.existsSync(f)) return false;
      try { fs.closeSync(fs.openSync(f, "r+")); return false; } catch { return true; }
    }
    const link = path.join(dir, "SingletonLock"); // symlink "<host>-<pid>"
    const target = fs.readlinkSync(link);
    const pid = Number(target.split("-").pop());
    return Number.isFinite(pid) && pidAlive(pid);
  } catch { return false; }
}

/** Serialize master reads/writes across processes (clones and write-backs are short). */
export async function withMasterLock<T>(master: string, fn: () => T | Promise<T>, waitMs = 60_000): Promise<T> {
  fs.mkdirSync(master, { recursive: true });
  const lock = path.join(master, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" }); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const cur = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; at?: number };
        if (typeof cur.pid !== "number" || !pidAlive(cur.pid) || Date.now() - (cur.at ?? 0) > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
      } catch { try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { force: true }); } catch { /* raced */ } }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the master profile lock (${lock})`);
      await sleep(200);
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(lock, { force: true }); } catch { /* best effort */ } }
}

function copyEntry(from: string, to: string): boolean {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
  return true;
}

/** Copy the master's sign-in state into a fresh user-data-dir (under the master lock, so no merge is mid-write). */
export async function cloneProfile(master: string, dest: string): Promise<void> {
  if (!fs.existsSync(master)) throw new Error(`master profile ${master} does not exist; run "cc browser seed" first (README "Full walkthrough, step 1 to done")`);
  await withMasterLock(master, () => {
    if (profileInUse(master)) throw new Error(`master profile ${master} is in use by a running Chrome. cc needs a COLD master (nothing running on it); use cc's own master profile (CC_BROWSER_MASTER, default <helm base>/browser-master); see README "Full walkthrough, step 1 to done"`);
    for (const e of CLONE_ENTRIES) copyEntry(path.join(master, e), path.join(dest, e));
  });
}

/** Remove a run's temp profile (files are released a moment after Chrome exits on Windows, so retry). */
export function removeProfile(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 }); } catch { /* leftovers are in the OS temp dir */ }
}
