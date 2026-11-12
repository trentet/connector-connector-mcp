// @reqs ACCT-001 ACCT-002 ACCT-003 ACCT-C01 ACCT-C02 ACCT-C05
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

/** A registry entry, when the owner made one, must name the same account as the run; a tampered entry refuses. */
async function registryAgrees(service: string, expected: string, deps: ChoiceDeps): Promise<void> {
  const lookup = await (deps.lookup ?? ((s: string) => lookupAccount(s)))(service);
  if (lookup.status === "tampered") throw new AccountNotAuthorizedError(`the account authorization for ${lookup.service} is invalid (${lookup.reason}); refusing`);
  if (lookup.status === "authorized" && lookup.account !== normAccount(expected)) {
    throw new AccountMismatchError(`the account specified for this run is not the one the owner named for ${lookup.service}; refusing`);
  }
}

/**
 * ACCT-C02: before cc types a vault login into a site's own sign-in form. The run's specified account (`expected`)
 * is required, the vault entry's username must be exactly it, and an owner registry entry for the service must agree.
 */
export async function assertLoginAccount(o: { service: string; label: string; username: string; expected?: string }, deps: ChoiceDeps = {}): Promise<void> {
  if (!normAccount(o.expected)) throw new AccountNotAuthorizedError(`no account is specified for signing in to ${o.service}; refusing`);
  if (normAccount(o.username) !== normAccount(o.expected)) throw new AccountMismatchError(`vault entry "${o.label}" is not the account specified for this run; not signing in`);
  await registryAgrees(o.service, o.expected!, deps);
}

/** The registry service under which the owner may name the Google account for one cc account's claude.ai sign-in. */
export const signInService = (accountId: string) => `cc-signin:${accountId.toLowerCase()}`;

/**
 * ACCT-C01: before cc signs a named cc account in to claude.ai. The account must carry its email (the exact account
 * to sign in), and an owner registry entry for cc-signin:<id>, when there is one, must name that email.
 */
export async function assertSignInAccount(acc: AccountDef, deps: ChoiceDeps = {}): Promise<void> {
  if (!normAccount(acc.email)) throw new AccountNotAuthorizedError(`account "${acc.id}" has no email, so the account to sign in is not specified; refusing`);
  await registryAgrees(signInService(acc.id), acc.email!, deps);
}
