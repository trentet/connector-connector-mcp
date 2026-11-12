// @reqs ACCT-001 ACCT-002 ACCT-003 ACCT-C01 ACCT-C02 ACCT-C05 ACCT-C10 ACCT-C11
/**
 * The account rule (owner t119u, 2026-11-11). Every sign-in, credential fill or account-scoped action runs for an
 * account specified for that run: passed in explicitly by the caller (cc_run / cc_signin account, the connector's
 * own reauth definition) or named by the owner in the account authorization registry (src/core/accountRegistry.ts,
 * read-only here). The accounts file's default, CC_ACCOUNT, a vault label and an already-signed-in session never
 * specify an account. Before acting, the account actually signed in is read and must be exactly that account.
 */
import { lookupAccount, normAccount, type Lookup } from "./accountRegistry.js";
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

export interface ChoiceDeps {
  lookup?: (service: string) => Promise<Lookup>;
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
 * ACCT-C11: returns the sign-in method the owner recorded with it; an entry that records none is refused.
 */
async function registryAgrees(service: string, expected: string, deps: ChoiceDeps): Promise<string | undefined> {
  const lookup = await (deps.lookup ?? ((s: string) => lookupAccount(s)))(service);
  if (lookup.status === "tampered") throw new AccountNotAuthorizedError(`the account authorization for ${lookup.service} is invalid (${lookup.reason}); refusing`);
  if (lookup.status === "incomplete") throw new AccountNotAuthorizedError(`the owner's account authorization for ${lookup.service} records no sign-in method, so how the account signs in is not specified; refusing until the owner enters it again`);
  if (lookup.status === "authorized" && lookup.account !== normAccount(expected)) {
    throw new AccountMismatchError(`the account specified for this run is not the one the owner named for ${lookup.service}; refusing`);
  }
  return lookup.status === "authorized" ? lookup.signInMethod : undefined;
}

/** ACCT-C11: the registry service each platform's account is named under. */
export const PLATFORM_SERVICE: Record<string, string> = { claude: "claude.ai", chatgpt: "chatgpt.com", grok: "grok.com" };

/**
 * ACCT-C11: the identity a platform session must show, with the login method taken from the owner's verified registry
 * entry when there is one (it overrides nothing silently: an accounts.json loginProvider that differs is
 * ACCOUNT_MISMATCH). An entry without a method is refused; no entry leaves the accounts.json identity as it is.
 */
export async function registryIdentity(platform: string, base: ExpectedIdentity, deps: ChoiceDeps = {}): Promise<ExpectedIdentity> {
  if (!normAccount(base.email)) return base; // refused by the identity check itself
  const recorded = await registryAgrees(PLATFORM_SERVICE[platform] ?? platform, base.email!, deps);
  const own = base.provider?.trim().toLowerCase();
  if (recorded && own && recorded !== own) throw new AccountMismatchError(`the login method in accounts.json for ${platform} is not the one the owner recorded for it; refusing`);
  return { ...base, provider: recorded ?? base.provider };
}

/** ACCT-C11: a vault login is used only when it records its sign-in method and that is the method this sign-in uses. */
export function assertVaultLoginMethod(label: string, recorded: string | null | undefined, method: string): void {
  const got = String(recorded ?? "").trim().toLowerCase();
  if (!got) throw new AccountNotAuthorizedError(`vault entry "${label}" records no sign-in method, so it is not used (the owner sets it in the vault); refusing`);
  if (got !== method) throw new AccountMismatchError(`vault entry "${label}" is a ${got} sign-in, not ${method}; not signing in`);
}

/**
 * ACCT-C02: before cc types a vault login into a site's own sign-in form. The run's specified account (`expected`)
 * is required, the vault entry's username must be exactly it, and an owner registry entry for the service must agree.
 */
export async function assertLoginAccount(o: { service: string; label: string; username: string; expected?: string; /** ACCT-C11 */ signInMethod?: string | null; method: string }, deps: ChoiceDeps = {}): Promise<void> {
  if (!normAccount(o.expected)) throw new AccountNotAuthorizedError(`no account is specified for signing in to ${o.service}; refusing`);
  if (normAccount(o.username) !== normAccount(o.expected)) throw new AccountMismatchError(`vault entry "${o.label}" is not the account specified for this run; not signing in`);
  assertVaultLoginMethod(o.label, o.signInMethod, o.method);
  const recorded = await registryAgrees(o.service, o.expected!, deps);
  if (recorded && recorded !== o.method) throw new AccountMismatchError(`the owner recorded a ${recorded} sign-in for ${o.service}, not ${o.method}; not signing in`);
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
  if (recorded && recorded !== "google") throw new AccountMismatchError(`the owner recorded a ${recorded} sign-in for ${signInService(acc.id)}, but cc signs in to claude.ai with Google; refusing`);
}
