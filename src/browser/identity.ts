// @reqs ACCT-003 ACCT-C05
/**
 * Reads which account a platform's browser session is signed in as, from data/selectors/identity.json: open the
 * platform page, then read the email field of a same-origin account endpoint. A platform with no reader there (or a
 * reader that yields no email) is "unknown", and the runner refuses it (ACCT-C05). Nothing here clicks or types.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserSession } from "./chrome.js";

export interface IdentityProbe { page?: string; fetch?: string; emailField?: string; liveVerified: boolean; note: string }
export type IdentityProbes = Partial<Record<string, IdentityProbe>>;

export function loadIdentityProbes(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): IdentityProbes {
  return (JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8")) as { platforms: IdentityProbes }).platforms;
}

const pick = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** The email the platform says is signed in, or undefined (no reader, page or endpoint failed, no email). */
export async function readPlatformIdentity(platform: string, session: BrowserSession, probes: IdentityProbes = loadIdentityProbes()): Promise<string | undefined> {
  const p = probes[platform];
  if (!p?.page || !p.fetch || !p.emailField) return undefined;
  await session.page.goto(p.page, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
  const body = await session.page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: "include" }); return r.ok ? await r.json() : null; } catch { return null; }
  }, p.fetch).catch(() => null);
  const e = pick(body, p.emailField);
  return typeof e === "string" && e.includes("@") ? e : undefined;
}
