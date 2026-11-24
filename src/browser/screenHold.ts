// REQ-D015 (REQ-U016): the screen hold. cc starts no browser while the screen is in use; a run that meets the hold waits for it to clear.
//
// Two sources, both condition-based (nothing here is decided by a timer):
//  1. A screen-control session on this host. While a session holds control its server process shows overlay windows (classes in
//     data/screen-hold.json). They exist exactly while the session holds control, are removed when it ends, and Windows destroys them
//     when the process dies, so the hold follows the session and a dead session cannot leave it behind. The window is read with a
//     read-only enumeration (no window opened, no focus taken). The on-disk session record is NOT used: its end time is rewritten at
//     every save, so it cannot tell a running, an ended and a dead session apart.
//  2. A manual hold (cc hold set / cc hold clear) for any other use of the screen. It lives in the lanes folder so every cc process
//     (CLI, MCP server, scheduled tasks) sees it. With --owner-pid it ends by itself when that process is gone.
// Used by acquireLane (lanes.ts), the one place every browser start passes through, before a lane is claimed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lanesDir } from "./lanes.js";

export interface OverlayWindow { className: string; pid: number }
export interface HoldSpec { label: string; overlayWindowClasses: string[] }
export interface ManualHold { setAt: string; reason: string; ownerPid?: number; setByPid: number }
export interface HoldStatus { held: boolean; reasons: string[]; notes: string[]; windows: OverlayWindow[]; manual?: ManualHold }
export interface RunResult { code: number | null; stdout: string; stderr: string }
export type RunFn = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** Everything a test (or a caller) may replace. Every field has a real default. */
export interface HoldDeps {
  probe?: (classes: string[]) => Promise<OverlayWindow[]>;
  alive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  env?: Record<string, string | undefined>;
}

const SPEC_FILE = fileURLToPath(new URL("../../data/screen-hold.json", import.meta.url));
const PLAIN_CLASS = /^[A-Za-z0-9_.]+$/;
const DEFAULT_POLL_MS = 5000; // each poll is one window enumeration (about 0.6 s of one core on this laptop), so not faster than this by default
const MIN_POLL_MS = 500;
const STILL_WAITING_MS = 60_000;
const DEFAULT_MAX_WAIT_MS = 2 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_REASON = 200;

const defaultAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const firstLine = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 200);

export function loadHoldSpec(file: string = SPEC_FILE): HoldSpec {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HoldSpec>;
  const classes = j.overlayWindowClasses;
  if (typeof j.label !== "string" || !j.label || !Array.isArray(classes) || classes.length === 0 || !classes.every((c) => typeof c === "string" && PLAIN_CLASS.test(c))) {
    throw new Error(`${path.basename(file)}: needs a label and a list of plain window class names`);
  }
  return { label: j.label, overlayWindowClasses: classes };
}

// ---- the session source: overlay windows ------------------------------------------------------------

/** Lines "Class|pid" from the enumeration; anything else (and a pid that is not a positive integer, or a class not asked for) is ignored. */
export function parseProbeOutput(text: string, classes: string[]): OverlayWindow[] {
  const out: OverlayWindow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.]+)\|(\d+)$/.exec(line.trim());
    if (!m || !classes.includes(m[1]!)) continue;
    const pid = Number(m[2]);
    if (Number.isInteger(pid) && pid > 0) out.push({ className: m[1]!, pid });
  }
  return out;
}

function probeScript(classes: string[]): string {
  const list = classes.map((c) => `'${c}'`).join(",");
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Collections.Generic;",
    "using System.Runtime.InteropServices;",
    "using System.Text;",
    "public static class CcWin {",
    "  delegate bool EnumProc(IntPtr h, IntPtr l);",
    "  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc p, IntPtr l);",
    "  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);",
    "  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
    "  public static List<string> Find(string[] classes) {",
    "    var found = new List<string>();",
    "    EnumWindows((h, l) => {",
    "      var sb = new StringBuilder(256);",
    "      GetClassNameW(h, sb, 256);",
    "      string c = sb.ToString();",
    "      if (Array.IndexOf(classes, c) >= 0) { uint pid; GetWindowThreadProcessId(h, out pid); found.Add(c + \"|\" + pid); }",
    "      return true;",
    "    }, IntPtr.Zero);",
    "    return found;",
    "  }",
    "}",
    "'@",
    `[CcWin]::Find([string[]]@(${list})) | ForEach-Object { $_ }`,
  ].join("\n");
}

function runProcess(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(() => reject(new Error(`the window enumeration did not answer within ${Math.round(timeoutMs / 1000)} s`))); }, timeoutMs);
    if (child.pid) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not permitted: normal priority */ } }
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.once("error", (e) => finish(() => reject(e)));
    child.once("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

/**
 * The windows of this host whose class is one of `classes`, with the id of the process that owns each. Read-only: nothing is opened and
 * no focus is taken. Not Windows: no such windows, nothing started. Throws when the enumeration fails; the caller says so and goes on.
 */
export async function probeOverlayWindows(classes: string[], opts: { platform?: string; run?: RunFn } = {}): Promise<OverlayWindow[]> {
  if ((opts.platform ?? process.platform) !== "win32") return [];
  for (const c of classes) if (!PLAIN_CLASS.test(c)) throw new Error("a window class name must be plain letters, digits, underscore or dot");
  const encoded = Buffer.from(probeScript(classes), "utf16le").toString("base64");
  const r = await (opts.run ?? runProcess)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], PROBE_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`the window enumeration failed (exit ${r.code}): ${firstLine(r.stderr) || "no message"}`);
  return parseProbeOutput(r.stdout, classes);
}

// ---- the manual source: a hold file in the lanes folder ----------------------------------------------

export const holdFilePath = (dir: string) => path.join(dir, "screen-hold.json");

export function setManualHold(dir: string, o: { reason?: string; ownerPid?: number }, now: () => number = Date.now): ManualHold {
  fs.mkdirSync(dir, { recursive: true });
  const hold: ManualHold = {
    setAt: new Date(now()).toISOString(),
    reason: (o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_REASON),
    ...(o.ownerPid !== undefined ? { ownerPid: o.ownerPid } : {}),
    setByPid: process.pid,
  };
  const tmpFile = `${holdFilePath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(hold));
  fs.renameSync(tmpFile, holdFilePath(dir)); // atomic: a reader sees the old file or the whole new one
  return hold;
}

/** True when there was a manual hold to clear. */
export function clearManualHold(dir: string): boolean {
  try { fs.rmSync(holdFilePath(dir)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

function readManualHold(dir: string, alive: (pid: number) => boolean, notes: string[]): ManualHold | undefined {
  const file = holdFilePath(dir);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  let h: ManualHold;
  try {
    h = JSON.parse(raw) as ManualHold;
    if (!h || typeof h !== "object" || typeof h.setAt !== "string" || typeof h.reason !== "string") throw new Error("shape");
    if (h.ownerPid !== undefined && !(Number.isInteger(h.ownerPid) && h.ownerPid > 0)) throw new Error("owner");
  } catch {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    notes.push("removed an unreadable manual hold file");
    return undefined;
  }
  if (h.ownerPid !== undefined && !alive(h.ownerPid)) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
    notes.push(`removed a stale manual hold (process ${h.ownerPid} is gone)`);
    return undefined;
  }
  return h;
}

// ---- the hold -------------------------------------------------------------------------------------

export async function screenHoldStatus(dir: string, deps: HoldDeps = {}): Promise<HoldStatus> {
  const env = deps.env ?? process.env;
  const none: HoldStatus = { held: false, reasons: [], notes: [], windows: [] };
  if (env.CC_SCREEN_HOLD === "off") return none;
  const alive = deps.alive ?? defaultAlive;
  const spec = loadHoldSpec();
  const reasons: string[] = [], notes: string[] = [];
  const manual = readManualHold(dir, alive, notes);
  if (manual) reasons.push(`manual hold${manual.ownerPid !== undefined ? ` of process ${manual.ownerPid}` : ""}, set ${manual.setAt}${manual.reason ? `: ${manual.reason}` : ""}`);
  let windows: OverlayWindow[] = [];
  try {
    const all = await (deps.probe ?? ((c: string[]) => probeOverlayWindows(c)))(spec.overlayWindowClasses);
    windows = all.filter((w) => alive(w.pid)); // a window of a process that is gone is not a session
  } catch (e) {
    notes.push(`could not read the windows of this host (${firstLine((e as Error).message) || "no message"}); the ${spec.label} source is not counted`);
  }
  const byPid = new Map<number, string[]>();
  for (const w of windows) byPid.set(w.pid, [...(byPid.get(w.pid) ?? []), w.className]);
  for (const [pid, classes] of byPid) reasons.push(`${spec.label} holds this screen (window ${[...new Set(classes)].join(", ")}, process ${pid})`); // a session shows one bar per monitor: each class once
  return { held: reasons.length > 0, reasons, notes, windows, ...(manual ? { manual } : {}) };
}

/**
 * Returns when the screen is free (at once when it already is). While held it sleeps and polls (never faster than 500 ms), claims nothing,
 * says on stderr that it waits and why, that it still waits every 60 s, and how long it waited. Gives up with an error after
 * CC_SCREEN_HOLD_MAX_WAIT_MS (default 2 hours): a forgotten hold must not freeze a caller for ever, and starting a browser anyway would defeat the hold.
 */
export async function waitForScreenFree(dir: string, deps: HoldDeps = {}): Promise<{ waitedMs: number }> {
  const env = deps.env ?? process.env;
  if (env.CC_SCREEN_HOLD === "off") return { waitedMs: 0 };
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? defaultSleep, log = deps.log ?? ((m: string) => console.error(m));
  const poll = Math.max(MIN_POLL_MS, Number(env.CC_SCREEN_HOLD_POLL_MS) || DEFAULT_POLL_MS);
  const maxWait = env.CC_SCREEN_HOLD_MAX_WAIT_MS !== undefined && Number(env.CC_SCREEN_HOLD_MAX_WAIT_MS) > 0 ? Number(env.CC_SCREEN_HOLD_MAX_WAIT_MS) : DEFAULT_MAX_WAIT_MS;
  const said = new Set<string>();
  const say = (notes: string[]) => { for (const n of notes) if (!said.has(n)) { said.add(n); log(`screen hold: ${n}`); } };
  let st = await screenHoldStatus(dir, deps);
  say(st.notes);
  if (!st.held) return { waitedMs: 0 };
  const t0 = now();
  log(`screen hold: waiting - ${st.reasons.join("; ")}`);
  let nextStill = STILL_WAITING_MS;
  for (;;) {
    if (now() - t0 >= maxWait) throw new Error(`screen hold still set after ${Math.round((now() - t0) / 1000)} s, not starting a browser: ${st.reasons.join("; ")}`);
    await sleep(poll);
    st = await screenHoldStatus(dir, deps);
    say(st.notes);
    const waited = now() - t0;
    if (!st.held) { log(`screen hold: clear after waiting ${Math.round(waited / 1000)} s; starting the browser`); return { waitedMs: waited }; }
    if (waited >= nextStill) { log(`screen hold: still waiting after ${Math.round(waited / 1000)} s - ${st.reasons.join("; ")}`); nextStill += STILL_WAITING_MS; }
  }
}

// ---- cc hold ---------------------------------------------------------------------------------------

const HOLD_USAGE = "usage: cc hold set [--reason <text>] [--owner-pid <pid>] | cc hold clear | cc hold status [--json]";

/** The `cc hold` command line. Returns the exit code. */
export async function holdCommand(args: string[], deps: HoldDeps = {}, dir: string = lanesDir()): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "set") {
    let reason: string | undefined, ownerPid: number | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--reason") { const v = rest[++i]; if (v === undefined || v.startsWith("--")) { console.error(`${HOLD_USAGE}\n--reason needs a text`); return 2; } reason = v; }
      else if (a === "--owner-pid") { const v = rest[++i]; if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) { console.error(`${HOLD_USAGE}\n--owner-pid needs a process id (a positive whole number)`); return 2; } ownerPid = Number(v); }
      else { console.error(`${HOLD_USAGE}\nunknown argument: ${a}`); return 2; }
    }
    const h = setManualHold(dir, { ...(reason !== undefined ? { reason } : {}), ...(ownerPid !== undefined ? { ownerPid } : {}) });
    console.log(`screen hold: manual hold set${h.reason ? `: ${h.reason}` : ""} (${h.ownerPid !== undefined ? `ends when process ${h.ownerPid} ends, or with cc hold clear` : "stays until cc hold clear"})`);
    return 0;
  }
  if (sub === "clear" && rest.length === 0) {
    console.log(clearManualHold(dir) ? "screen hold: manual hold cleared" : "screen hold: no manual hold to clear");
    return 0;
  }
  if (sub === "status" && rest.every((a) => a === "--json")) {
    const st = await screenHoldStatus(dir, deps);
    if (rest.includes("--json")) { console.log(JSON.stringify({ held: st.held, reasons: st.reasons, notes: st.notes, windows: st.windows, ...(st.manual ? { manual: st.manual } : {}) })); return 0; }
    console.log(st.held ? "screen hold: HELD" : "screen hold: free");
    for (const r of st.reasons) console.log(`  ${r}`);
    for (const n of st.notes) console.log(`  note: ${n}`);
    if (st.held && !st.manual) console.log("  (a session hold ends when the session ends; cc hold clear removes only a manual hold)");
    return 0;
  }
  console.error(HOLD_USAGE);
  return 2;
}
