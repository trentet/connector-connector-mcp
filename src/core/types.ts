export type Platform = "claude" | "chatgpt" | "grok";
export const PLATFORMS: Platform[] = ["claude", "chatgpt", "grok"];
/** Platforms whose add-connector UI has no custom-header field (verified by live probe 2026-10-01 for grok); auth must ride in the URL. */
export const HEADERLESS_PLATFORMS: Platform[] = ["chatgpt", "grok"];
export type Op = "add" | "remove" | "update" | "list" | "verify" | "probe";

/** A source describes HOW to obtain a string at run time. Values are never stored in the registry. */
export type Source =
  | { type: "literal"; value: string } // non-secret text only
  | { type: "env"; name: string }
  | { type: "envFile"; paths: string[]; key: string }
  | { type: "fileRegex"; path: string; pattern: string; group?: number }
  | { type: "vault"; label: string; field?: "username" | "password" }
  | { type: "template"; template: string; variables: Record<string, Source> };

/**
 * A connector whose server holds a Google OAuth grant (credentials.json + token.json) that Google expires after 7 days while the
 * OAuth app stays in Testing status. `cc reauth` renews it. Everything connector-specific lives here, in the registry, never in src/.
 */
export interface GoogleOAuthDef {
  /** Directory on the connector's own host holding credentials.json (read) and token.json (written). `%VAR%` is expanded on this machine. */
  secretsDir: string;
  /** The scopes the connector's server uses. The consent must request exactly these and Google must grant them all, or nothing is written. */
  scopes: string[];
  /** The Google account that owns the grant: its vault entry (username/password resolved inside the process, never returned or logged). */
  account: { vaultLabel: string };
  /** The connector's server runs on another machine: files move with scp and commands with ssh. Absent = this machine. */
  host?: { ssh: string; keyFile: string; port?: number; os?: "windows" | "posix" };
  /** Run on the connector's host after the new token is in place (servers read token.json at start). */
  restart?: { command: string };
  /** Checked on the connector's host after the restart; if it fails, the previous token is restored. */
  health?: { url: string; contains?: string; waitSeconds?: number };
}

export interface ConnectorDef {
  id: string;
  name: string;
  /** "test" connectors are on-demand only: `*` / --all skips them unless includeTest is set. Default "production". */
  tier?: "production" | "test";
  /** Display name differs on some platforms (verified: claude.ai calls the Drive connector by a shorter name). */
  nameByPlatform?: Partial<Record<Platform, string>>;
  description?: string;
  /** Default server URL. May be a template that embeds a secret (tokenized URL). */
  url: Source;
  /** Per-platform URL override, e.g. ChatGPT cannot send headers so it needs a tokenized URL. */
  urlByPlatform?: Partial<Record<Platform, Source>>;
  /** header = custom request header (claude.ai); none = auth lives in the URL or the server is open; oauth = platform-driven. */
  auth: {
    mode: "header" | "none" | "oauth";
    headerName?: string;
    headerValue?: Source;
    /**
     * oauth only: the connector's OWN authorization page is a login form. Nobody is at the host, so cc signs in to it
     * with this vault credential (username/password resolved inside the process, never returned or logged). cc never
     * clicks an Approve/consent button on its own and never fills any other origin.
     */
    oauthLogin?: { vaultLabel: string };
  };
  platforms: Platform[];
  /** Present when this connector's server holds a Google OAuth grant that `cc reauth` must keep alive. */
  googleOAuth?: GoogleOAuthDef;
}

export interface Registry {
  version: 1;
  defaults?: { ifExisting?: "skip" | "update" | "fail" };
  connectors: ConnectorDef[];
}

export interface RunRequest {
  op: Op;
  connectors: string[]; // ids, or ["*"]
  platforms: Platform[];
  dryRun?: boolean;
  /** Also select tier "test" connectors when connectors includes "*". */
  includeTest?: boolean;
  ifExisting?: "skip" | "update" | "fail";
}

export interface ItemResult {
  connector: string;
  platform: Platform;
  op: Op;
  status: "ok" | "skipped" | "dry-run" | "not-implemented" | "error";
  detail?: string;
}

export interface RunResult {
  ok: boolean;
  items: ItemResult[];
}
