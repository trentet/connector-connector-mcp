import { packageVersion } from "./version.js";
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadAccounts, type AccountDef } from "../core/accounts.js";
import { loadRegistry } from "../core/registry.js";
import { run as coreRun } from "../core/runner.js";
import { enqueueRun, getRunJob, jobToResult, settleJob } from "../core/runJobs.js";
import { reauth as coreReauth, type ReauthRequest, type ReauthResult } from "../core/reauth.js";
import { PLATFORMS, type Registry, type RunRequest, type RunResult } from "../core/types.js";

export interface AppOptions {
  token: string;
  registryPath: string;
  host?: string;
  allowedHosts?: string[];
  /** Injectable for tests; defaults to the real runner (same code path as the CLI). */
  runFn?: (reg: Registry, req: RunRequest) => Promise<RunResult>;
  /** Injectable for tests; defaults to the real renewal (same code path as `cc reauth`). */
  reauthFn?: (reg: Registry, req: ReauthRequest) => Promise<ReauthResult>;
  version?: string;
  /** Injectable for tests; defaults to the real `cc browser signin`. */
  signinFn?: (account: string | undefined, waitForVaultMs: number) => Promise<{ status: string; account: string; email?: string; confirmed: boolean }>;
  /** Injectable for tests; defaults to registry/accounts.json. */
  accountsPath?: string;
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

/**
 * Tools take registry IDS only. There is deliberately no url/token/secret argument anywhere: anything passed as an MCP
 * argument lands in the calling session's context. `.strict()` makes unknown fields an error, not silently ignored.
 */
const runInput = z.object({
  op: z.enum(["add", "remove", "update", "verify", "list", "probe", "status"]),
  connectors: z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]*)$/)).max(50).default([]).describe('Registry ids, or ["*"] for all. Not used by list/probe/status.'),
  platforms: z.array(z.enum(PLATFORMS as [string, ...string[]])).min(1).default([...PLATFORMS]),
  include_test: z.boolean().default(false).describe('With connectors ["*"], also include tier "test" connectors. Test connectors are on-demand: name them explicitly to add/remove one.'),
  dry_run: z.boolean().default(false).describe("Resolve and validate everything without touching any platform."),
  if_existing: z.enum(["skip", "update", "fail"]).optional(),
  account: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional().describe("Account id from cc_list_accounts (each has its own signed-in browser). Required: without it the run is refused (ACCOUNT_NOT_AUTHORIZED); the server's default account is never used, and each platform session must show this account signed in."),
  job_id: z.string().regex(/^run_[a-f0-9]{16}$/).optional().describe("Job id returned by a previous cc_run. Required when op is status."),
}).strict();

const signinInput = z.object({
  account: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional().describe("Account id from cc_list_accounts. Required: without it the sign-in is refused (ACCOUNT_NOT_AUTHORIZED); the server's default account is never used."),
  wait_for_vault_minutes: z.number().finite().min(0).max(30).default(0).describe("When the account's vault entry is missing, wait this long for it to be added (0 = fail at once)."),
}).strict();

const reauthInput = z.object({
  connectors: z.array(z.string().regex(/^(\*|[a-z0-9][a-z0-9-]*)$/)).min(1).max(50).describe('Registry ids of connectors that have a googleOAuth block, or ["*"] for all production ones.'),
  include_test: z.boolean().default(false).describe('With connectors ["*"], also include tier "test" connectors.'),
  dry_run: z.boolean().default(false).describe("Check every prerequisite (credentials, vault entry, SSH reachability) without opening a browser or changing anything."),
  only_if_older_than_days: z.number().finite().positive().optional().describe("Skip a connector whose last successful renewal is newer than this many days (a positive number, for example 4.75); for a second renewer that only acts when the first has not."),
}).strict();

const ALLOWED_ARGS: Record<string, string[]> = { cc_run: Object.keys(runInput.shape), cc_reauth: Object.keys(reauthInput.shape), cc_signin: Object.keys(signinInput.shape), cc_list_registry: [], cc_list_accounts: [] };

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

/** cc_signin's default: only the account named in the call, with its email; an owner registry entry must agree (ACCT-C01). */
export async function defaultSigninFn(accountsPath: string | undefined, id: string | undefined, waitMs: number) {
  const { pickAccount, accountMaster } = await import("../core/accounts.js");
  const { assertSignInAccount } = await import("../core/accountChoice.js");
  const all = loadAccounts(accountsPath);
  const acc = pickAccount(all, id, process.env, "explicit");
  await assertSignInAccount(acc);
  const { masterDir } = await import("../browser/chrome.js");
  const { signInAccount } = await import("../browser/signin.js");
  const r = await signInAccount(acc, accountMaster(acc, masterDir()), { waitForVaultMs: waitMs });
  return { status: r.status, account: acc.id, email: r.email, confirmed: r.confirmed };
}

export function buildMcpServer(opts: AppOptions): McpServer {
  const server = new McpServer({ name: "connector-connector-mcp", version: opts.version ?? packageVersion() });
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
        "Add, remove, update, list, verify or probe MCP connectors on claude.ai, ChatGPT and Grok, or poll a job with op=status. Takes registry ids only (see cc_list_registry); " +
        "secrets are resolved inside the server and never returned. Idempotent. Use dry_run first if unsure. " +
        "A run that opens a browser is started as a job and is not cancelled if the client disconnects or times out. " +
        "If the work has not finished in a few seconds the tool returns a job_id; poll with op=status and that job_id. " +
        "A second start for the same account while a job is in progress returns the existing job_id and does not open another browser.",
      inputSchema: runInput.shape,
    },
    async (args) => {
      const a = runInput.parse(args);
      if (a.op === "status") {
        if (!a.job_id) return { content: [{ type: "text", text: "job_id is required when op is status" }], isError: true };
        const job = getRunJob(a.job_id);
        if (!job) return { content: [{ type: "text", text: "unknown job_id" }], isError: true };
        const res = jobToResult(job);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.ok };
      }
      const reg = loadRegistry(opts.registryPath);
      const req = { op: a.op, connectors: a.connectors, platforms: a.platforms as RunRequest["platforms"], dryRun: a.dry_run, includeTest: a.include_test, ifExisting: a.if_existing, account: a.account };
      if (a.dry_run) {
        const res = await runFn(reg, req);
        return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.ok };
      }
      const { job } = enqueueRun(req, () => runFn(reg, req));
      const waitMs = Number(process.env.CC_RUN_WAIT_MS);
      const settled = await settleJob(job.id, Number.isFinite(waitMs) ? waitMs : 2500);
      const res = jobToResult(settled);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.ok };
    },
  );
  server.registerTool(
    "cc_list_accounts",
    { description: "List the accounts cc works in (id, email, platforms, which is the default). Each account has its own signed-in browser; pass its id as `account` to cc_run.", inputSchema: {} },
    async () => {
      const all = loadAccounts(opts.accountsPath);
      const rows = all.accounts.map((x: AccountDef) => ({ id: x.id, email: x.email, platforms: x.platforms, default: x.id === all.default, googleSignIn: !!x.signIn?.google }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );
  const signinFn = opts.signinFn ?? ((id: string | undefined, waitMs: number) => defaultSigninFn(opts.accountsPath, id, waitMs));
  server.registerTool(
    "cc_signin",
    {
      description: "Sign an account in to claude.ai with Google inside cc's own browser profile for that account, using the account's vault entry (password resolved inside the server, never returned). " +
        "Needed once per account, and again only if claude.ai signs it out. Can take a few minutes (longer than some clients wait; it still completes).",
      inputSchema: signinInput.shape,
    },
    async (args) => {
      const a = signinInput.parse(args);
      try { const r = await signinFn(a.account, a.wait_for_vault_minutes * 60_000); return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] }; }
      catch (e) { return { content: [{ type: "text", text: JSON.stringify({ status: "error", detail: (e as Error).message }, null, 2) }], isError: true }; }
    },
  );
  const reauthFn = opts.reauthFn ?? ((reg, req) => coreReauth(reg, req));
  server.registerTool(
    "cc_reauth",
    {
      description:
        "Renew the Google OAuth token (7-day expiry while the OAuth app is in Testing status) of connectors whose registry entry has a googleOAuth block: " +
        "drives Google's consent in cc's own browser, delivers the new token.json to the connector's host, restarts it and checks its health; restores the old token if that fails. " +
        "Takes registry ids only; secrets are resolved inside the server and never returned. Use dry_run first if unsure. A real run can exceed a client's 60 s timeout (it still completes).",
      inputSchema: reauthInput.shape,
    },
    async (args) => {
      const a = reauthInput.parse(args);
      const reg = loadRegistry(opts.registryPath);
      const res = await reauthFn(reg, { connectors: a.connectors, includeTest: a.include_test, dryRun: a.dry_run, onlyIfOlderThanDays: a.only_if_older_than_days });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], isError: !res.ok };
    },
  );
  return server;
}

export function buildApp(opts: AppOptions) {
  const host = opts.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, allowedHosts: opts.allowedHosts });
  app.get("/health", (_req, res) => { res.status(200).json({ status: "ok", service: "connector-connector-mcp", version: opts.version ?? packageVersion() }); });
  app.post("/mcp", requireToken(opts.token), async (req, res) => {
    const extra = unknownArgs(req.body);
    if (extra) {
      res.status(200).json({ jsonrpc: "2.0", id: (req.body as { id?: unknown })?.id ?? null, error: { code: -32602, message: `Invalid params: unknown argument(s): ${extra.join(", ")}. cc takes registry ids only; never pass urls, tokens or secrets as arguments.` } });
      return;
    }
    const server = buildMcpServer(opts);
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
