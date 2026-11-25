// @reqs ACCT-001 ACCT-002 ACCT-C04 ACCT-C11
/**
 * Read-only check of the owner's account authorization registry (kept by the vault connector): one vault item per service,
 * `account-authorization/<service>`, whose username is the account the owner typed on the vault connector's own single-use
 * form, signed with the vault connector's host key. This module never writes anything. It reads the items from bw serve
 * (the same local API as src/core/vaultClient.ts) and verifies each signature with the public key the vault connector serves at
 * GET /account-authorization/public-key. An entry that is missing its signature, does not verify, or has a
 * second entry for the same service is "tampered", which every caller treats as a hard refusal.
 */
import { createPublicKey, verify as edVerify } from "node:crypto";

export const PREFIX = "account-authorization/";

export type Lookup =
  | { status: "authorized"; service: string; account: string; /** ACCT-C11: how the owner said the account signs in (signed). */ signInMethod: string }
  /** ACCT-C11: an older entry signed without a sign-in method: refused for any sign-in or fill, never guessed. */
  | { status: "incomplete"; service: string; account: string; reason: string }
  | { status: "none"; service: string }
  | { status: "tampered"; service: string; reason: string }
  | { status: "unavailable"; service: string; reason: string };

export interface RegistryItem {
  name: string;
  notes?: string | null;
  login?: { username?: string | null } | null;
}

export interface RegistrySource {
  listItems(): Promise<RegistryItem[]>;
  publicKeyPem(): Promise<string>;
}

const ISSUED_RE = /(?:^|\n)issued_at=(\S+)/;
const SIG_RE = /(?:^|\n)auth_sig=([A-Za-z0-9_-]+)/;
const SVC_RE = /(?:^|\n)service=(\S+)/;
const METHOD_RE = /(?:^|\n)sign_in_method=(\S+)/;
/** ACCT-C11: the sign-in methods the vault records (the same values the identity readers report). */
export const SIGN_IN_METHODS = ["email", "username", "google", "x", "apple", "github", "sso", "phone", "cursor", "android"] as const;

export const normService = (s: string) => String(s ?? "").trim().toLowerCase().replace(/^www\./, "");
export const normAccount = (a: string | null | undefined) => String(a ?? "").trim().toLowerCase();

// v2 signs the sign-in method too (the vault's signed registry rule); v1 entries carry none.
const payload = (service: string, account: string, issuedAt: string, method?: string) =>
  Buffer.from(method ? `account-authorization-v2|${service}|${account}|${method}|${issuedAt}` : `account-authorization-v1|${service}|${account}|${issuedAt}`, "utf8");

/** Verifies one registry item for `service` (already normalized). */
export function verifyEntry(service: string, item: RegistryItem, publicKeyPem: string): Lookup {
  const notes = String(item.notes ?? "").replace(/\r\n/g, "\n");
  const issued = ISSUED_RE.exec(notes)?.[1];
  const sig = SIG_RE.exec(notes)?.[1];
  const svc = SVC_RE.exec(notes)?.[1];
  const method = METHOD_RE.exec(notes)?.[1];
  const account = normAccount(item.login?.username);
  if (!issued || !sig || svc !== service || !account) {
    return { status: "tampered", service, reason: "entry is missing its owner-form signature" };
  }
  if (method !== undefined && !(SIGN_IN_METHODS as readonly string[]).includes(method)) return { status: "tampered", service, reason: "entry names an unknown sign-in method" };
  let ok = false;
  try {
    ok = edVerify(null, payload(service, account, issued, method), createPublicKey(publicKeyPem), Buffer.from(sig, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { status: "tampered", service, reason: "signature does not match the entry" };
  if (!method) return { status: "incomplete", service, account, reason: "the entry records no sign-in method; the owner must enter it again" };
  return { status: "authorized", service, account, signInMethod: method };
}

/** The owner-named account for a service, or none / tampered / unavailable. Never throws. */
export async function lookupAccount(serviceIn: string, src: RegistrySource = defaultRegistrySource()): Promise<Lookup> {
  const service = normService(serviceIn);
  let items: RegistryItem[];
  try {
    items = (await src.listItems()).filter((i) => String(i.name ?? "").trim().toLowerCase() === PREFIX + service);
  } catch (err) {
    return { status: "unavailable", service, reason: `vault not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (items.length === 0) return { status: "none", service };
  if (items.length > 1) return { status: "tampered", service, reason: `${items.length} entries for one service` };
  let pem: string;
  try {
    pem = await src.publicKeyPem();
  } catch (err) {
    return { status: "unavailable", service, reason: `registry key not reachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  return verifyEntry(service, items[0]!, pem);
}

export function defaultRegistrySource(): RegistrySource {
  const bw = process.env.BW_SERVE_URL || "http://127.0.0.1:8087";
  const vaultMcp = process.env.VAULT_MCP_URL || "http://127.0.0.1:3000";
  return {
    async listItems() {
      const res = await fetch(`${bw}/list/object/items?search=${encodeURIComponent(PREFIX)}`);
      const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { data?: RegistryItem[] } } | null;
      if (!res.ok || body?.success === false) throw new Error(`bw serve returned HTTP ${res.status}`);
      return body?.data?.data ?? [];
    },
    async publicKeyPem() {
      const res = await fetch(`${vaultMcp}/account-authorization/public-key`);
      if (!res.ok) throw new Error(`the vault connector returned HTTP ${res.status}`);
      return await res.text();
    },
  };
}
