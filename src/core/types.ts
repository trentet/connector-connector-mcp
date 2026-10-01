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

export interface ConnectorDef {
  id: string;
  name: string;
  /** Display name differs on some platforms (verified: claude.ai calls the Drive connector by a shorter name). */
  nameByPlatform?: Partial<Record<Platform, string>>;
  description?: string;
  /** Default server URL. May be a template that embeds a secret (tokenized URL). */
  url: Source;
  /** Per-platform URL override, e.g. ChatGPT cannot send headers so it needs a tokenized URL. */
  urlByPlatform?: Partial<Record<Platform, Source>>;
  /** header = custom request header (claude.ai); none = auth lives in the URL or the server is open; oauth = platform-driven. */
  auth: { mode: "header" | "none" | "oauth"; headerName?: string; headerValue?: Source };
  platforms: Platform[];
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
