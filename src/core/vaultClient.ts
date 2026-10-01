/**
 * Direct client for the Bitwarden CLI local REST API (`bw serve`) -- NOT the vault connector's MCP tools.
 * Resolved INSIDE this process so a secret never enters an MCP tool result / calling session context.
 * Same pattern other HELM connectors use for in-process credential resolution. Only reachable on the host that runs `bw serve`.
 */
const BASE_URL = () => process.env.BW_SERVE_URL || "http://127.0.0.1:8087";

async function bwFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL()}${path}`, { headers: { "Content-Type": "application/json" } });
  const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: unknown } | null;
  if (!res.ok || body?.success === false) throw new Error(`bw serve error: ${body?.message || "HTTP " + res.status}`);
  return body?.data ?? body;
}

export interface VaultCredential { username?: string; password?: string }

export async function getCredential(label: string): Promise<VaultCredential | undefined> {
  const list = (await bwFetch("/list/object/items")) as { data?: { id: string; name: string }[] } | { id: string; name: string }[];
  const items = Array.isArray(list) ? list : (list?.data ?? []);
  const matches = items.filter((i) => i.name === label);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error(`vault label "${label}" is ambiguous (${matches.length} entries)`);
  const item = (await bwFetch(`/object/item/${matches[0].id}`)) as { login?: { username?: string | null; password?: string | null } };
  return { username: item.login?.username ?? undefined, password: item.login?.password ?? undefined };
}
