import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadRegistry } from "../core/registry.js";
import { run as coreRun } from "../core/runner.js";
import { PLATFORMS, type Registry, type RunRequest, type RunResult } from "../core/types.js";

export interface AppOptions {
  token: string;
  registryPath: string;
  host?: string;
  allowedHosts?: string[];
  /** Injectable for tests; defaults to the real runner (same code path as the CLI). */
  runFn?: (reg: Registry, req: RunRequest) => Promise<RunResult>;
  version?: string;
}

const TOKEN_HEADER = "x-api-key";

export function isValidToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const q = typeof req.query.token === "string" ? req.query.token : "";
    const t = req.header(TOKEN_HEADER) || q;
    if (!t || !isValidToken(t, expected)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: `Unauthorized: send a valid ${TOKEN_HEADER} header.` }, id: null });
      return;
    }
    next();
  };
}

/** One browser, one run at a time: concurrent callers queue instead of fighting over tabs. */
function serialize(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => { const p = tail.then(fn, fn) as Promise<T>; tail = p.catch(() => {}); return p; };
}

/**
 * Tools take registry IDS only. There is deliberately no url/token/secret argument anywhere: anything passed as an MCP
 * argument lands in the calling session's context. `.strict()` makes unknown fields an error, not silently ignored.
 */
const runInput = z.object({
  op: z.enum(["add", "remove", "update", "verify", "list", "probe"]),
  connectors: z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]*)$/)).max(50).default([]).describe('Registry ids, or ["*"] for all. Not used by list/probe.'),
  platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).min(1).default([...PLATFORMS]),
  include_test: z.boolean().default(false).describe('With connectors ["*"], also include tier "test" connectors. Test connectors are on-demand: name them explicitly to add/remove one.'),
  dry_run: z.boolean().default(false).describe("Resolve and validate everything without touching any platform."),
  if_existing: z.enum(["skip", "update", "fail"]).optional(),
}).strict();

const ALLOWED_ARGS: Record<string, string[]> = { cc_run: Object.keys(runInput.shape), cc_list_registry: [] };

/** The SDK silently strips unknown fields; reject them loudly instead, so a caller that passes a url/token learns it must not. */
export function unknownArgs(body: unknown): string[] | undefined {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }[]) {
    if (m?.method !== "tools/call" || !m.params?.name) continue;
    const allowed = ALLOWED_ARGS[m.params.name];
    if (!allowed) continue;
    const extra = Object.keys(m.params.arguments ?? {}).filter((k) => !allowed.includes(k));
    if (extra.length) return extra;
  }
  return undefined;
}

export function buildMcpServer(opts: AppOptions, queue: <T>(fn: () => Promise<T>) => Promise<T>): McpServer {
  const server = new McpServer({ name: "connector-connector-mcp", version: opts.version ?? "0.0.1" });
  const runFn = opts.runFn ?? ((reg, req) => import("../adapters/index.js").then(({ ADAPTERS }) => coreRun(reg, req, { adapters: ADAPTERS })));
  server.registerTool(
    "cc_list_registry",
    { description: "List the connector definitions cc knows about (ids, display names, enabled platforms). Never returns URLs or secrets.", inputSchema: {} },
    async () => {
      const reg = loadRegistry(opts.registryPath);
      const rows = reg.connectors.map((c) => ({ id: c.id, name: c.name, platforms: c.platforms, tier: c.tier ?? "production", auth: c.auth.mode }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );
  server.registerTool(
    "cc_run",
    {
      description:
        "Add, remove, update, list, verify or probe MCP connectors on claude.ai, ChatGPT and Grok. Takes registry ids only (see cc_list_registry); " +
        "secrets are resolved inside the server and never returned. Idempotent. Use dry_run first if unsure.",
      inputSchema: runInput.shape,
    },
    async (args) => {
      const a = runInput.parse(args);
      const reg = loadRegistry(opts.registryPath);
      const res = await queue(() => runFn(reg, { op: a.op, connectors: a.connectors, platforms: a.platforms as RunRequest["platforms"], dryRun: a.dry_run, includeTest: a.include_test, ifExisting: a.if_existing }));
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.ok };
    },
  );
  return server;
}

export function buildApp(opts: AppOptions) {
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, allowedHosts: opts.allowedHosts });
  const queue = serialize();
  app.get("/health", (_req, res) => { res.status(200).json({ status: "ok", service: "connector-connector-mcp", version: opts.version ?? "0.0.1" }); });
  app.post("/mcp", requireToken(opts.token), async (req, res) => {
    const extra = unknownArgs(req.body);
    if (extra) {
      res.status(200).json({ jsonrpc: "2.0", id: (req.body as { id?: unknown })?.id ?? null, error: { code: -32602, message: `Invalid params: unknown argument(s): ${extra.join(", ")}. cc takes registry ids only; never pass urls, tokens or secrets as arguments.` } });
      return;
    }
    const server = buildMcpServer(opts, queue);
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => { void transport.close(); void server.close(); });
    } catch (err) {
      console.error("MCP request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const no = (_req: Request, res: Response): void => { res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }); };
  app.get("/mcp", requireToken(opts.token), no);
  app.delete("/mcp", requireToken(opts.token), no);
  return app;
}
