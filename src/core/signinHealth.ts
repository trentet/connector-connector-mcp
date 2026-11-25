// @reqs REQ-D013 REQ-D014
import fs from "node:fs";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * REQ-D014 / REQ-D013: how long a Google sign-in still lives, and the alert that must never be skipped.
 * While the Google OAuth app is in Testing status a refresh token lives 7 days; cc writes token.renewed.json (renewedAt) at every
 * renewal, so the hours left are computed from that record. No secret, code, token or email is ever read, printed or stored here.
 */
export const SIGNIN_LIFETIME_HOURS = 168;
export const DEFAULT_WARN_HOURS = 72;
export const ALERT_FILE = "reauth-ALERT.json";

export type SignInState = "ok" | "warn" | "expired" | "unknown";
export interface SignInStatus { connector: string; hoursLeft?: number; state: SignInState; byHost?: string }

/** Hours left from a renewal record, or undefined when it is missing, unreadable or dated in the future (nothing is trusted then). */
export function hoursLeftFromRecord(raw: string | undefined, nowMs: number): { hoursLeft: number; renewedAt: string; byHost?: string } | undefined {
  if (raw === undefined) return undefined;
  try {
    const j = JSON.parse(raw) as { renewedAt?: unknown; byHost?: unknown };
    const at = typeof j.renewedAt === "string" ? Date.parse(j.renewedAt) : NaN;
    if (!Number.isFinite(at) || at > nowMs + 5 * 60_000) return undefined;
    const left = Math.max(0, SIGNIN_LIFETIME_HOURS - Math.max(0, nowMs - at) / 3_600_000);
    return { hoursLeft: Math.round(left * 10) / 10, renewedAt: new Date(at).toISOString(), byHost: typeof j.byHost === "string" ? j.byHost : undefined };
  } catch { return undefined; }
}

export function classifyHours(hoursLeft: number | undefined, warnHours: number = DEFAULT_WARN_HOURS): SignInState {
  if (hoursLeft === undefined) return "unknown";
  if (hoursLeft <= 0) return "expired";
  return hoursLeft <= warnHours ? "warn" : "ok";
}

export interface Alert { raised: boolean; lines: string[]; file: { raisedAt: string; runFailed: boolean; warnHours: number; connectors: { connector: string; hoursLeft?: number; state: SignInState; byHost?: string }[] } }

/** The alert of REQ-D013: raised when the run failed or any sign-in is warn, expired or unknown. Only ids, hours and states are used. */
export function evaluateAlert(statuses: readonly SignInStatus[], o: { warnHours: number; nowIso: string; runFailed?: boolean }): Alert {
  const problems = statuses.filter((s) => s.state !== "ok");
  const lines: string[] = [];
  if (o.runFailed) lines.push("ALERT: the scheduled Google sign-in renewal run failed (see scheduled-reauth.log)");
  for (const s of statuses) {
    const hours = s.hoursLeft === undefined ? "hours left unknown" : `${s.hoursLeft} hours left`;
    lines.push(s.state === "ok" ? `ok     ${s.connector}: Google sign-in ${hours}` : `ALERT: ${s.connector}: Google sign-in ${s.state}, ${hours} (alert below ${o.warnHours} hours)`);
  }
  return {
    raised: Boolean(o.runFailed) || problems.length > 0,
    lines,
    file: { raisedAt: o.nowIso, runFailed: Boolean(o.runFailed), warnHours: o.warnHours, connectors: problems.map((s) => ({ connector: s.connector, hoursLeft: s.hoursLeft, state: s.state, byHost: s.byHost })) },
  };
}

export type ExecFileFn = (cmd: string, args: string[], options?: object) => Promise<unknown>;

/**
 * Writes (or removes) alerts/reauth-ALERT.json and runs the hook. The hook is the program named by CC_ALERT_COMMAND, run with the alert
 * file path as its only argument and no shell (so it can route the alert to the owner and the owner threads); a missing or failing hook
 * never hides the alert: the file, the ALERT lines and the exit code stay.
 */
export async function applyAlert(a: Alert, o: { dir: string; hookCommand?: string; execFile?: ExecFileFn }): Promise<{ exit: number; lines: string[]; hookOk?: boolean; file?: string }> {
  const file = path.join(o.dir, ALERT_FILE);
  if (!a.raised) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort: the status itself is still ok */ }
    return { exit: 0, lines: a.lines };
  }
  const lines = [...a.lines];
  try { fs.mkdirSync(o.dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(a.file, null, 2)); lines.push(`alert file: ${file}`); }
  catch (e) { lines.push(`ALERT file could not be written (${clean((e as Error).message)}); this line and the exit code are the alert`); }
  let hookOk: boolean | undefined;
  const hook = o.hookCommand?.trim();
  if (hook) {
    try { await (o.execFile ?? (promisify(nodeExecFile) as ExecFileFn))(hook, [file], { windowsHide: true, timeout: 60_000 }); hookOk = true; lines.push("alert hook ran"); }
    catch (e) { hookOk = false; lines.push(`ALERT hook failed (${clean((e as Error).message)}); the alert file and this line stay`); }
  } else lines.push("no CC_ALERT_COMMAND set: the alert is only this line, the alert file and the exit code");
  return { exit: 1, lines, hookOk, file };
}

const clean = (m: string): string => m.replace(/\S+@\S+/g, "<redacted>").replace(/\s+/g, " ").slice(0, 120);