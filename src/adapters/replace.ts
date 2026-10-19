import type { AdapterContext, AdapterOutcome, PlatformAdapter, ResolvedConnector } from "./types.js";

/**
 * "Update" for a platform with no edit form: take the connector out and put it back, so the platform ends with the registry's current address and secret.
 * It is the one update that can leave a connector MISSING, so it is written to fail loudly: nothing is removed unless the list read says it is there,
 * the add is tried twice, and a failed add reports "REMOVED and could not be added back" instead of a plain error. A result is only ok after a fresh verify (CLAUDE.md rule 4).
 * Uses only the adapter's own list, remove, add and verify, so it needs no UI facts of its own.
 */
export async function replaceConnector(a: Pick<PlatformAdapter, "list" | "remove" | "add" | "verify">, ctx: AdapterContext, c: ResolvedConnector): Promise<AdapterOutcome> {
  const there = (await a.list(ctx)).names.includes(c.name);
  if (!there) return a.add(ctx, c, "fail"); // nothing to replace: a plain add
  const rm = await a.remove(ctx, c);
  if (rm.status !== "ok") return { status: "error", detail: `update stopped at the remove step, which said ${rm.status}${rm.detail ? ` (${rm.detail})` : ""}; the add was not tried` };
  let last: AdapterOutcome = { status: "error", detail: "no add attempt ran" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    last = await a.add(ctx, c, "fail");
    if (last.status === "ok") {
      const v = await a.verify(ctx, c);
      return v.status === "ok" ? { status: "ok", detail: `"${c.name}" replaced (removed, added back, verified)` } : { status: "error", detail: `"${c.name}" was added back but verify said ${v.status}${v.detail ? ` (${v.detail})` : ""}` };
    }
  }
  return { status: "error", detail: `"${c.name}" was REMOVED and could not be added back (${last.status}${last.detail ? `: ${last.detail}` : ""}); it is MISSING on ${ctx.platform}. Run add for it now.` };
}
