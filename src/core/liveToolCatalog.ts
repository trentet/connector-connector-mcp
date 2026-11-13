/**
 * REQ-D011 — live, authenticated source-of-truth MCP tools/list.
 * Uses the shared registry secret resolvers, without connector-specific identities.
 * Errors are generic because URLs may contain credential material.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Redactor } from "./redact.js";
import { resolve, type ResolveDeps, defaultDeps } from "./secrets.js";
import type { ConnectorDef, Platform } from "./types.js";
import type { McpToolContract, ToolCatalog } from "./toolSchema.js";

export type ToolListPage = { tools: McpToolContract[]; nextCursor?: string };
export type ToolListReader = (cursor?: string) => Promise<ToolListPage>;

/** Every page is required; a truncated list is never silently current. */
export async function collectToolPages(
  read: ToolListReader, opts: { maxPages?: number; maxTools?: number } = {},
): Promise<ToolCatalog> {
  const maxPages = opts.maxPages ?? 50, maxTools = opts.maxTools ?? 2500;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
      !Number.isInteger(maxTools) || maxTools < 1 || maxTools > 10000) {
    throw new Error("invalid bounds for MCP tools/list");
  }
  const tools: McpToolContract[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let index = 0; index < maxPages; index++) {
    const page = await read(cursor);
    if (!page || !Array.isArray(page.tools)) throw new Error("invalid MCP tools/list result");
    for (const tool of page.tools) {
      if (!tool || typeof tool.name !== "string" || !tool.name.trim() || seen.has(tool.name)) {
        throw new Error("ambiguous MCP tool definition");
      }
      tools.push({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      });
      seen.add(tool.name);
      if (tools.length > maxTools) throw new Error("MCP tools/list size exceeded");
    }
    if (!page.nextCursor) {
      if (tools.length === 0) throw new Error("empty MCP tools/list");
      return { tools, complete: true };
    }
    if (cursors.has(page.nextCursor)) throw new Error("cyclic MCP tools/list cursor");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("incomplete paginated MCP tools/list");
}

/**
 * Reuses CC's registry and secret resolvers. No connector-specific endpoint
 * details are embedded in this module. OAuth without a usable protocol token
 * cannot be assumed to work from a browser sign-in: fail closed instead.
 */
export async function readLiveServerToolCatalog(
  definition: ConnectorDef,
  platform: Platform,
  redactor: Redactor = new Redactor(),
  deps: ResolveDeps = defaultDeps,
): Promise<ToolCatalog> {
  if (!definition.platforms.includes(platform)) throw new Error("connector not configured on platform");
  if (definition.auth.mode === "oauth") throw new Error("no read-only OAuth tool-catalog credential");
  const urlSource = definition.urlByPlatform?.[platform] ?? definition.url;
  if (!urlSource) throw new Error("MCP endpoint is not declared");

  let endpoint: URL;
  let headers: Record<string, string> = {};
  try {
    endpoint = new URL(await resolve(urlSource, redactor, deps));
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" &&
        (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost"))) {
      throw new Error("insecure transport");
    }
    if (definition.auth.mode === "header" && definition.auth.headerName && definition.auth.headerValue) {
      headers = { [definition.auth.headerName]: await resolve(definition.auth.headerValue, redactor, deps) };
    }
  } catch {
    throw new Error("MCP endpoint resolution failed");
  }

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers, signal: AbortSignal.timeout(30000) },
  });
  const client = new Client({ name: "helm-cc-schema-auditor", version: "1.0" });
  try {
    await client.connect(transport);
    return await collectToolPages(async (cursor) => {
      const response = await client.listTools(cursor ? { cursor } : undefined, { timeout: 10000 });
      return { tools: response.tools, nextCursor: response.nextCursor };
    });
  } catch {
    throw new Error("MCP source catalog could not be verified");
  } finally {
    await client.close().catch(() => undefined);
  }
}