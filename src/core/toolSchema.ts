/**
 * REQ-D011 — canonical MCP tool-contract comparison.
 *
 * A Connected/Installed badge is not schema evidence.  A catalog is current
 * only when BOTH independently retrieved catalogs are complete, valid, and
 * their normalized tool contracts agree. Never log or retain secret URLs.
 */
import { createHash } from "node:crypto";

export type McpToolContract = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

export type ToolCatalog = {
  tools: readonly McpToolContract[];
  /** The reader, not the caller, has proved the complete list was retrieved. */
  complete: boolean;
  /** The platform's persisted installation identity, when observable. */
  installationId?: string;
};

export type CatalogComparison = {
  status: "CURRENT" | "STALE" | "UNKNOWN";
  sourceHash?: string;
  installedHash?: string;
  missing: string[];
  extra: string[];
  changed: string[];
  reason?: string;
};

function canonical(value: unknown, key = ""): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite schema value");
    return value;
  }
  if (Array.isArray(value)) {
    const values = value.map((v) => canonical(v));
    // JSON Schema "required" and "enum" are sets; serialization order is not part of their contract.
    if ((key === "required" || key === "enum") && values.every((v) => typeof v === "string")) {
      return [...values].sort();
    }
    return values;
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const prop of Object.keys(input).sort()) {
      if (input[prop] !== undefined) result[prop] = canonical(input[prop], prop);
    }
    return result;
  }
  throw new Error("non-JSON schema value");
}

function checkedMap(catalog: ToolCatalog): Map<string, string> {
  if (catalog.complete !== true || !Array.isArray(catalog.tools) || catalog.tools.length === 0) {
    throw new Error("incomplete or empty catalog");
  }
  const result = new Map<string, string>();
  for (const tool of catalog.tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name.trim() ||
        tool.name !== tool.name.trim() || result.has(tool.name)) {
      throw new Error("ambiguous or invalid tool name");
    }
    const contract = {
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      annotations: tool.annotations ?? null,
    };
    result.set(tool.name, JSON.stringify(canonical(contract)));
  }
  return result;
}

function digest(records: Map<string, string>): string {
  const ordered = [...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

/**
 * REQ-D011 — no unverified success state. Exact names and contracts are required.
 * No raw tool metadata is included in the return value (hashes and names only).
 */
export function compareToolCatalogs(source: ToolCatalog, installed: ToolCatalog): CatalogComparison {
  const blank: CatalogComparison = { status: "UNKNOWN", missing: [], extra: [], changed: [] };
  let upstream: Map<string, string>;
  let downstream: Map<string, string>;
  try {
    upstream = checkedMap(source);
    downstream = checkedMap(installed);
  } catch {
    return { ...blank, reason: "incomplete-or-ambiguous-catalog" };
  }

  const sourceHash = digest(upstream), installedHash = digest(downstream);
  const missing = [...upstream.keys()].filter((k) => !downstream.has(k)).sort();
  const extra = [...downstream.keys()].filter((k) => !upstream.has(k)).sort();
  const changed = [...upstream.keys()].filter((k) => downstream.has(k) && upstream.get(k) !== downstream.get(k)).sort();
  return {
    status: missing.length || extra.length || changed.length ? "STALE" : "CURRENT",
    sourceHash, installedHash, missing, extra, changed,
  };
}