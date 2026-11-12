// @reqs ACCT-001 ACCT-002 ACCT-C01 ACCT-C02
/**
 * Which account cc may sign in with. The owner names an account for a service in the account authorization
 * registry (src/core/accountRegistry.ts, read-only here). Without that naming cc uses an account only when it is
 * the only one that could apply, and refuses with ACCOUNT_NOT_AUTHORIZED otherwise. A default, CC_ACCOUNT, a vault
 * label and registry/accounts.json never count as the owner naming an account.
 */
import { lookupAccount, normAccount, PREFIX, type Lookup } from "./accountRegistry.js";
import { listLoginSummaries, type LoginSummary } from "./vaultClient.js";
import type { AccountDef, Accounts } from "./accounts.js";

export class AccountNotAuthorizedError extends Error {
  readonly code = "ACCOUNT_NOT_AUTHORIZED";
  constructor(message: string) {
    super(`ACCOUNT_NOT_AUTHORIZED: ${message}`);
    this.name = "AccountNotAuthorizedError";
  }
}

export interface ChoiceDeps {
  lookup?: (service: string) => Promise<Lookup>;
  logins?: () => Promise<LoginSummary[]>;
}

const hostOf = (u: string): string | undefined => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : "https://" + u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
const onHosts = (h: string, hosts: string[]) => hosts.some((x) => h === x || h.endsWith("." + x));

/**
 * ACCT-C02: before cc types a vault login into a site's own sign-in form. With an owner-named account the entry's
 * username must be it; with none, no other vault login with a different username may have a URI on the site's hosts.
 */
export async function assertLoginAccount(o: { service: string; hosts: string[]; label: string; username: string }, deps: ChoiceDeps = {}): Promise<void> {
  const lookup = await (deps.lookup ?? ((s: string) => lookupAccount(s)))(o.service);
  const user = normAccount(o.username);
  if (lookup.status === "tampered") throw new AccountNotAuthorizedError(`the account authorization for ${lookup.service} is invalid (${lookup.reason}); not signing in`);
  if (lookup.status === "authorized") {
    if (user !== lookup.account) throw new AccountNotAuthorizedError(`vault entry "${o.label}" is not the account the owner named for ${lookup.service}; not signing in`);
    return;
  }
  const others = new Set<string>();
  for (const i of await (deps.logins ?? listLoginSummaries)()) {
    if (i.name === o.label || i.name.trim().toLowerCase().startsWith(PREFIX)) continue;
    const u = normAccount(i.username);
    if (!u || u === user) continue;
    if (i.uris.some((uri) => { const h = hostOf(uri); return !!h && onHosts(h, o.hosts); })) others.add(u);
  }
  if (others.size > 0) {
    throw new AccountNotAuthorizedError(`${others.size + 1} vault accounts could sign in to ${o.service} and the owner has not named one; not signing in`);
  }
}

/** The registry service under which the owner names the Google account for one cc account's claude.ai sign-in. */
export const signInService = (accountId: string) => `cc-signin:${accountId.toLowerCase()}`;

/**
 * ACCT-C01: before cc signs a cc account in to claude.ai with Google. With an owner-named account for
 * cc-signin:<id> the cc account's email must be it; with none, this must be the only cc account that can sign in.
 */
export async function assertSignInAccount(all: Accounts, acc: AccountDef, deps: ChoiceDeps = {}): Promise<void> {
  const service = signInService(acc.id);
  const lookup = await (deps.lookup ?? ((s: string) => lookupAccount(s)))(service);
  if (lookup.status === "tampered") throw new AccountNotAuthorizedError(`the account authorization for ${service} is invalid (${lookup.reason}); not signing in`);
  if (lookup.status === "authorized") {
    if (!acc.email || normAccount(acc.email) !== lookup.account) throw new AccountNotAuthorizedError(`account "${acc.id}" is not the account the owner named for ${service}; not signing in`);
    return;
  }
  const able = all.accounts.filter((x) => x.signIn?.google);
  if (able.length === 1 && able[0]!.id === acc.id) return;
  throw new AccountNotAuthorizedError(`${able.length} cc accounts can sign in and the owner has not named the account for ${service}; not signing in`);
}
