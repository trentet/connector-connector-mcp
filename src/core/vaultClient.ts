// @reqs ACCT-C11 ACCT-C12
/**
 * Direct client for the Bitwarden CLI local REST API (`bw serve`) -- NOT the vault connector's MCP tools.
 * Resolved INSIDE this process so a secret never enters an MCP tool result / calling session context.
 * Same pattern other HELM connectors use for in-process credential resolution. Only reachable on the host that runs `bw serve`.
 */
import { METHOD_FIELD, METHOD_SOURCE_FIELD, OPTIONS_PREFIX, normSite, parseSite, siteNotes, type SignInStore } from "./signInMethod.js";

const BASE_URL = () => process.env.BW_SERVE_URL || "http://127.0.0.1:8087";

async function bwFetch(path: string, method = "GET", payload?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL()}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: unknown } | null;
  if (!res.ok || body?.success === false) throw new Error(`bw serve error: ${body?.message || "HTTP " + res.status}`);
  return body?.data ?? body;
}

/** signInMethod (ACCT-C11): the entry's sign_in_method field (the vault's login-entry rule); undefined when it records none. */
export interface VaultCredential { username?: string; password?: string; signInMethod?: string }

export async function getCredential(label: string): Promise<VaultCredential | undefined> {
  const list = (await bwFetch("/list/object/items")) as { data?: { id: string; name: string }[] } | { id: string; name: string }[];
  const items = Array.isArray(list) ? list : (list?.data ?? []);
  const matches = items.filter((i) => i.name === label);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error(`vault label "${label}" is ambiguous (${matches.length} entries)`);
  const item = (await bwFetch(`/object/item/${matches[0].id}`)) as { login?: { username?: string | null; password?: string | null }; fields?: { name?: string | null; value?: string | null }[] | null };
  const method = (item.fields ?? []).find((f) => f?.name === "sign_in_method")?.value;
  return { username: item.login?.username ?? undefined, password: item.login?.password ?? undefined, ...(method ? { signInMethod: method } : {}) };
}

/**
 * The current authenticator code for the entry's TOTP field (`bw serve` GET /object/totp/:id; no premium plan needed on our Vaultwarden, tested 2026-10-16).
 * Resolved INSIDE this process and only ever typed into Google's own page; never returned by a tool, never logged.
 */
export async function getTotp(label: string): Promise<string | undefined> {
  const list = (await bwFetch("/list/object/items")) as { data?: { id: string; name: string }[] } | { id: string; name: string }[];
  const items = Array.isArray(list) ? list : (list?.data ?? []);
  const matches = items.filter((i) => i.name === label);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error(`vault label "${label}" is ambiguous (${matches.length} entries)`);
  const d = (await bwFetch(`/object/totp/${matches[0].id}`)) as string | { data?: string };
  const code = typeof d === "string" ? d : d?.data;
  return code && /^\d{6,8}$/.test(code) ? code : undefined;
}

/** Poll the vault until an entry with this label appears (operator submits it via a vault_request_secret link). */
export async function waitForCredential(label: string, timeoutMs: number, pollMs = 3000): Promise<VaultCredential | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const c = await getCredential(label);
    if (c && (c.password || c.username)) return c;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return undefined;
}

/** Delete a one-time entry (e.g. an SMS code) after use. */
export async function deleteCredential(label: string): Promise<boolean> {
  const list = (await bwFetch("/list/object/items")) as { data?: { id: string; name: string }[] } | { id: string; name: string }[];
  const items = Array.isArray(list) ? list : (list?.data ?? []);
  let n = 0;
  // DELETE alone only moves the item to the trash, where the secret stays recoverable: delete permanently.
  for (const i of items.filter((x) => x.name === label)) { await bwFetch(`/object/item/${i.id}?permanent=true`, "DELETE"); n++; }
  return n > 0;
}

type BwItem = { id: string; name: string; notes?: string | null; fields?: { name?: string | null; value?: string | null; type?: number }[] | null } & Record<string, unknown>;
async function listItems(): Promise<BwItem[]> {
  const list = (await bwFetch("/list/object/items")) as { data?: BwItem[] } | BwItem[];
  return Array.isArray(list) ? list : (list?.data ?? []);
}

/**
 * ACCT-C12: the vault side of resolveSignInMethod, through bw serve. Per-site records are secure notes named
 * sign-in-options/<site> (no secret in them); the entry's method is written to its sign_in_method and
 * sign_in_method_source fields, on exactly one entry with that label (several or none: refused, nothing written).
 */
export const signInStore: SignInStore = {
  async readSite(site) {
    const name = OPTIONS_PREFIX + normSite(site);
    const same = (await listItems()).filter((i) => String(i.name ?? "").trim().toLowerCase() === name);
    if (same.length === 0) return undefined;
    if (same.length > 1) throw new Error(`${same.length} records for one site`);
    const r = parseSite(same[0]!.name, same[0]!.notes);
    if (!r) throw new Error("the stored record is not well-formed");
    return r;
  },
  async writeSite(rec) {
    const name = OPTIONS_PREFIX + normSite(rec.site);
    const same = (await listItems()).filter((i) => String(i.name ?? "").trim().toLowerCase() === name);
    if (same.length > 1) throw new Error(`${same.length} records for one site`);
    if (same.length === 1) {
      const full = (await bwFetch(`/object/item/${same[0]!.id}`)) as BwItem;
      await bwFetch(`/object/item/${same[0]!.id}`, "PUT", { ...full, notes: siteNotes(rec) });
      return;
    }
    await bwFetch("/object/item", "POST", { type: 2, name, notes: siteNotes(rec), secureNote: { type: 0 }, favorite: false, folderId: null, organizationId: null, fields: [] });
  },
  async writeEntryMethod(label, method, source) {
    const same = (await listItems()).filter((i) => i.name === label);
    if (same.length !== 1) throw new Error(same.length ? `${same.length} entries share the label` : "no entry with that label");
    const full = (await bwFetch(`/object/item/${same[0]!.id}`)) as BwItem;
    const keep = (full.fields ?? []).filter((f) => f?.name !== METHOD_FIELD && f?.name !== METHOD_SOURCE_FIELD);
    await bwFetch(`/object/item/${same[0]!.id}`, "PUT", { ...full, fields: [...keep, { name: METHOD_FIELD, value: method, type: 0 }, { name: METHOD_SOURCE_FIELD, value: source, type: 0 }] });
  },
};
