// @reqs ACCT-003 ACCT-C05 ACCT-C07 ACCT-C10
/**
 * Reads which account a platform's browser session is signed in as, from data/selectors/identity.json: open the
 * platform page, then read a same-origin account endpoint with the session's cookies. The probe names the email field
 * and, where the platform reports it, the login-method field and how its values map to a provider (ACCT-C10). A
 * platform with no reader there (or a response that yields no email, or a status other than okStatus) is "unknown", and
 * every caller refuses it. Nothing here clicks or types.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserSession } from "./chrome.js";
import { AccountNotAuthorizedError, assertSameIdentity, expectedIdentity, registryIdentity, type ExpectedIdentity, type SeenIdentity } from "../core/accountChoice.js";

export { expectedIdentity, registryIdentity };

export interface IdentityProbe {
  page?: string;
  fetch?: string;
  emailField?: string;
  /** Dot path to the login method in the same response (ACCT-C10). */
  providerField?: string;
  /** Login-method value (enum name, upper case, or number) to provider (email, google, x, ...). Unlisted values: no provider. */
  providerMap?: Record<string, string>;
  /** When the response carries this field, it must equal okStatus, otherwise nothing is identified. */
  statusField?: string;
  okStatus?: string;
  liveVerified: boolean;
  note: string;
}
export type IdentityProbes = Partial<Record<string, IdentityProbe>>;
/** What a reader identified: the signed-in email, and the login method when the platform reports one. */
export interface PlatformIdentity { email?: string; provider?: string; providerRaw?: string }

export function loadIdentityProbes(dir = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"))): IdentityProbes {
  return (JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8")) as { platforms: IdentityProbes }).platforms;
}

const pick = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** ACCT-C10: the email and login method a probe's response body names; {} when it names no email or its status is not okStatus. */
export function identityFromBody(body: unknown, p: IdentityProbe): PlatformIdentity {
  if (!body || typeof body !== "object" || !p.emailField) return {};
  if (p.statusField) {
    const st = pick(body, p.statusField);
    if (st !== undefined && st !== null && String(st) !== (p.okStatus ?? "authenticated")) return {};
  }
  const e = pick(body, p.emailField);
  if (!(typeof e === "string" && e.includes("@"))) return {};
  const out: PlatformIdentity = { email: e };
  if (p.providerField) {
    const raw = pick(body, p.providerField);
    if (typeof raw === "string" || typeof raw === "number") {
      out.providerRaw = String(raw);
      const key = String(raw).trim();
      const mapped = p.providerMap?.[key.toUpperCase()] ?? p.providerMap?.[key];
      if (mapped) out.provider = mapped;
    }
  }
  return out;
}

/** ACCT-C10: the email and login method the platform says are signed in; {} when unknown (no reader, page or endpoint failed). */
export async function readPlatformAccount(platform: string, session: BrowserSession, probes: IdentityProbes = loadIdentityProbes()): Promise<PlatformIdentity> {
  const p = probes[platform];
  if (!p?.page || !p.fetch || !p.emailField) return {};
  await session.page.goto(p.page, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => undefined);
  const body = await session.page.evaluate(async (u) => {
    try { const r = await fetch(u, { credentials: "include" }); return r.ok ? await r.json() : null; } catch { return null; }
  }, p.fetch).catch(() => null);
  return identityFromBody(body, p);
}

/** The email the platform says is signed in, or undefined (no reader, page or endpoint failed, no email). */
export async function readPlatformIdentity(platform: string, session: BrowserSession, probes: IdentityProbes = loadIdentityProbes()): Promise<string | undefined> {
  return (await readPlatformAccount(platform, session, probes)).email;
}

/**
 * ACCT-C07 ACCT-C10: opens a browser session for `expected` (the named account's email, and its login method when the
 * account specifies one) and returns it only once the platform shows exactly that. No account: refused before anything
 * opens. Another account or login method, or an unreadable one: the session is closed and ACCOUNT_MISMATCH /
 * ACCOUNT_NOT_AUTHORIZED is thrown.
 */
export async function openVerifiedSession(
  platform: string,
  expected: string | ExpectedIdentity | undefined,
  open: () => Promise<BrowserSession>,
  read: (platform: string, s: BrowserSession) => Promise<SeenIdentity> = (p, s) => readPlatformAccount(p, s),
): Promise<BrowserSession> {
  const want: ExpectedIdentity | undefined = typeof expected === "string" ? { email: expected } : expected;
  if (!want?.email) throw new AccountNotAuthorizedError(`no account is specified for ${platform}; refusing before opening a browser`);
  const s = await open();
  try {
    assertSameIdentity(platform, want, await read(platform, s).catch(() => undefined));
    return s;
  } catch (e) { await s.close().catch(() => undefined); throw e; }
}
