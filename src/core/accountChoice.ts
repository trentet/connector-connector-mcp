// @reqs ACCT-001 ACCT-002 ACCT-003 ACCT-C01 ACCT-C02 ACCT-C05 ACCT-C10 ACCT-C11 ACCT-C12 ACCT-C13
/**
 * The account rule (owner t119u, 2026-11-11). Every sign-in, credential fill or account-scoped action runs for an
 * account specified for that run: passed in explicitly by the caller (cc_run / cc_signin account, the connector's
 * own reauth definition) or named by the owner in the account authorization registry (src/core/accountRegistry.ts,
 * read-only here). The accounts file's default, CC_ACCOUNT, a vault label and an already-signed-in session never
 * specify an account. Before acting, the account actually signed in is read and must be exactly that account.
 */
import { lookupAccount, normAccount, normService, SIGN_IN_METHODS, type Lookup } from "./accountRegistry.js";
import type { AccountDef } from "./accounts.js";

export class AccountNotAuthorizedError extends Error {
  readonly code = "ACCOUNT_NOT_AUTHORIZED";
  constructor(message: string) {
    super(`ACCOUNT_NOT_AUTHORIZED: ${message}`);
    this.name = "AccountNotAuthorizedError";
  }
}

export class AccountMismatchError extends Error {
  readonly code = "ACCOUNT_MISMATCH";
  constructor(message: string) {
    super(`ACCOUNT_MISMATCH: ${message}`);
    this.name = "AccountMismatchError";
  }
}

export interface VaultLoginRef { label: string; method?: string }

export interface ChoiceDeps {
  lookup?: (service: string) => Promise<Lookup>;
  /** ACCT-C13: vault logins for this account on this service (label and method only; never a secret). */
  listVaultLogins?: (account: string, service: string) => Promise<VaultLoginRef[]>;
}

/**
 * ACCT-003: the account signed in (`seen`: one value or every account the page shows) must be exactly the specified
 * account. Nothing specified, nothing readable, or any other account shown is refused. Messages carry no emails.
 */
export function assertSameAccount(where: string, expected: string | undefined, seen: string | readonly string[] | undefined): void {
  const want = normAccount(expected);
  if (!want) throw new AccountNotAuthorizedError(`no account is specified for ${where}; refusing`);
  const got = (Array.isArray(seen) ? [...seen] : typeof seen === "string" ? [seen] : []).map((s) => normAccount(s)).filter(Boolean);
  if (got.length === 0) throw new AccountNotAuthorizedError(`the account signed in on ${where} could not be read; an unverified session is never used`);
  if (got.some((g) => g !== want)) throw new AccountMismatchError(`${where} shows a signed-in account other than the one specified for this run; refusing`);
}

/** ACCT-C10: the account a session must show: its email, and its login method when the account entry specifies one. */
export interface ExpectedIdentity { email?: string; provider?: string }
/** What a reader saw: an email (or several), or an email with the login method it was signed in with. */
export type SeenIdentity = string | readonly string[] | { email?: string; provider?: string } | undefined;

/**
 * ACCT-003 ACCT-C10: the email must be exactly the expected one (assertSameAccount). When the account specifies a login
 * method (email, google, x, ...), the session's must be that one too: another is ACCOUNT_MISMATCH, an unreadable one
 * ACCOUNT_NOT_AUTHORIZED. Messages carry no email.
 */
export function assertSameIdentity(where: string, expected: ExpectedIdentity, seen: SeenIdentity): void {
  const obj = seen && typeof seen === "object" && !Array.isArray(seen) ? (seen as { email?: string; provider?: string }) : undefined;
  assertSameAccount(where, expected.email, obj ? obj.email : (seen as string | readonly string[] | undefined));
  const want = expected.provider?.trim().toLowerCase();
  if (!want) return;
  const got = obj?.provider?.trim().toLowerCase();
  if (!got) throw new AccountNotAuthorizedError(`the login method signed in on ${where} could not be read, and this account must use ${want}; an unverified session is never used`);
  if (got !== want) throw new AccountMismatchError(`${where} is signed in with a login method other than the one specified for this account (${want}); refusing`);
}

/** The identity a platform session must show for an account entry (its email, and loginProvider[platform] when set). */
export function expectedIdentity(acc: { email?: string; loginProvider?: Partial<Record<string, string>> }, platform: string): ExpectedIdentity {
  return { email: acc.email, provider: acc.loginProvider?.[platform] };
}

/**
 * A registry entry, when the owner made one, must name the same account as the run; a tampered entry refuses.
 * ACCT-C11: returns the sign-in method the owner recorded with it. ACCT-C12: an older entry signed without one
 * (incomplete) still names its account; it simply records no method (the entry's own method is settled on pull).
 */
async function registryAgrees(service: string, expected: string, deps: ChoiceDeps): Promise<string | undefined> {
  const lookup = await (deps.lookup ?? ((s: string) => lookupAccount(s)))(service);
  if (lookup.status === "tampered") throw new AccountNotAuthorizedError(`the account authorization for ${lookup.service} is invalid (${lookup.reason}); refusing`);
  if ((lookup.status === "authorized" || lookup.status === "incomplete") && lookup.account !== normAccount(expected)) {
    throw new AccountMismatchError(`the account specified for this run is not the one the owner named for ${lookup.service}; refusing`);
  }
  return lookup.status === "authorized" ? lookup.signInMethod : undefined;
}

/** ACCT-C11: the registry service each platform's account is named under (services, not login methods). */
export const PLATFORM_SERVICE: Record<string, string> = { claude: "claude.ai", chatgpt: "chatgpt.com", grok: "grok.com" };

/**
 * ACCT-C11 ACCT-C12: the identity a platform session must show. The login method is only ever the one the owner
 * recorded in the verified registry entry; an accounts.json loginProvider is a cross-check against it (differs:
 * ACCOUNT_MISMATCH), never a source. With no recorded method the email alone is verified.
 */

/** ACCT-C13: a vault item is for `service` when a login URI host is that service, or the service host appears in its label. */
export function entryMatchesService(name: string, uriHosts: readonly string[], service: string): boolean {
  const svc = normService(service);
  if (!svc) return false;
  for (const h of uriHosts) {
    const host = String(h ?? "").trim().toLowerCase().replace(/^www\./, "");
    if (host === svc || host.endsWith("." + svc)) return true;
  }
  return String(name ?? "").toLowerCase().includes(svc);
}

async function defaultVaultLogins(account: string, service: string): Promise<VaultLoginRef[]> {
  // Unit tests never touch the live vault unless they inject listVaultLogins.
  if (process.env.VITEST) return [];
  const { listVaultLogins } = await import("./vaultClient.js");
  return listVaultLogins(account, service);
}

/**
 * ACCT-C13: the expected sign-in method from matching vault logins, with the registry method only as a tie-break.
 * One method (one entry, or several that agree): that method, even if the registry has none or differs (the vault is
 * the system of record). Several that disagree: the registry method if it names one of them, otherwise refused.
 * No vault method: the registry method, if any.
 */
export function resolveVaultLoginMethod(entries: readonly VaultLoginRef[], registryMethod?: string): string | undefined {
  const known = new Set(SIGN_IN_METHODS as readonly string[]);
  const methods: string[] = [];
  for (const e of entries) {
    const m = e.method?.trim().toLowerCase();
    if (!m) continue;
    if (!known.has(m)) throw new AccountNotAuthorizedError(`a vault login for this account records an unknown sign-in method; refusing`);
    if (!methods.includes(m)) methods.push(m);
  }
  if (methods.length === 1) return methods[0];
  if (methods.length > 1) {
    const rec = registryMethod?.trim().toLowerCase();
    if (rec && methods.includes(rec)) return rec;
    throw new AccountNotAuthorizedError(`several vault logins for this account disagree on sign-in method (${methods.join(", ")}); the approval record must pick one`);
  }
  const rec = registryMethod?.trim().toLowerCase();
  return rec || undefined;
}

export async function registryIdentity(platform: string, base: ExpectedIdentity, deps: ChoiceDeps = {}): Promise<ExpectedIdentity> {
  if (!normAccount(base.email)) return { email: base.email }; // refused by the identity check itself
  const service = PLATFORM_SERVICE[platform] ?? platform;
  const recorded = await registryAgrees(service, base.email!, deps);
  const entries = await (deps.listVaultLogins ?? defaultVaultLogins)(base.email!, service);
  const provider = resolveVaultLoginMethod(entries, recorded);
  const own = base.provider?.trim().toLowerCase();
  if (provider && own && provider !== own) throw new AccountMismatchError(`the login method in accounts.json for ${platform} is not the one the vault records for it; refusing`);
  return provider ? { email: base.email, provider } : { email: base.email };
}

/**
 * ACCT-C12: a check, not a default. A flow that can only perform one kind of sign-in (typing into an email-and-password
 * form, or clicking through Google's own sign-in or consent) proceeds only when the account's recorded method is that
 * one; any other recorded method is ACCOUNT_MISMATCH.
 */
export function assertFlowMethod(flow: string, recorded: string, performs: string): void {
  if (recorded !== performs) throw new AccountMismatchError(`${flow} performs only a ${performs} sign-in, but the sign-in method recorded for this account is ${recorded}; refusing`);
}

/** ACCT-C12: the method the registry recorded and the vault entry's must be the same when both exist. */
export function assertMethodsAgree(where: string, registry: string | undefined, entry: string): void {
  if (registry && registry !== entry) throw new AccountMismatchError(`the owner's registry entry for ${where} records a ${registry} sign-in, but the vault entry records ${entry}; refusing`);
}

/** ACCT-C12: the refusal and mismatch errors resolveSignInMethod raises in cc. */
export const ccMethodErrors = { refuse: (m: string) => new AccountNotAuthorizedError(m), mismatch: (m: string) => new AccountMismatchError(m) };

/**
 * ACCT-C02: before cc types a vault login into a site's own sign-in form. The run's specified account (`expected`)
 * is required, the vault entry's username must be exactly it, and an owner registry entry for the service must agree.
 * Returns the sign-in method the registry recorded, if any (ACCT-C12: the entry's own method is settled on pull).
 */
export async function assertLoginAccount(o: { service: string; label: string; username: string; expected?: string }, deps: ChoiceDeps = {}): Promise<string | undefined> {
  if (!normAccount(o.expected)) throw new AccountNotAuthorizedError(`no account is specified for signing in to ${o.service}; refusing`);
  if (normAccount(o.username) !== normAccount(o.expected)) throw new AccountMismatchError(`vault entry "${o.label}" is not the account specified for this run; not signing in`);
  return await registryAgrees(o.service, o.expected!, deps);
}

/** The registry service under which the owner may name the Google account for one cc account's claude.ai sign-in. */
export const signInService = (accountId: string) => `cc-signin:${accountId.toLowerCase()}`;

/**
 * ACCT-C01: before cc signs a named cc account in to claude.ai. The account must carry its email (the exact account
 * to sign in), and an owner registry entry for cc-signin:<id>, when there is one, must name that email.
 */
export async function assertSignInAccount(acc: AccountDef, deps: ChoiceDeps = {}): Promise<void> {
  if (!normAccount(acc.email)) throw new AccountNotAuthorizedError(`account "${acc.id}" has no email, so the account to sign in is not specified; refusing`);
  const recorded = await registryAgrees(signInService(acc.id), acc.email!, deps);
  if (recorded) assertFlowMethod("cc's claude.ai sign-in through Google", recorded, "google"); // ACCT-C12: a check against the recorded method
}
