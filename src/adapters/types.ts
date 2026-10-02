import type { BrowserSession } from "../browser/chrome.js";
import type { ConnectorDef, Platform } from "../core/types.js";

/** Fully resolved connector, built in-process by the runner. Never serialized into output. */
export interface ResolvedConnector {
  def: ConnectorDef;
  /** Name as the platform shows it. */
  name: string;
  url: string;
  headerValue?: string;
}

export interface AdapterContext {
  platform: Platform;
  redact: (s: string) => string;
  /** Lazily opens (once per run) the shared browser session. */
  session: () => Promise<BrowserSession>;
}

export interface AdapterOutcome { status: "ok" | "skipped" | "not-implemented" | "error"; detail?: string }

/** One adapter per platform. All browser work lives behind this interface. */
export interface PlatformAdapter {
  platform: Platform;
  list(ctx: AdapterContext): Promise<{ names: string[] }>;
  add(ctx: AdapterContext, c: ResolvedConnector, ifExisting: "skip" | "update" | "fail"): Promise<AdapterOutcome>;
  remove(ctx: AdapterContext, c: ResolvedConnector): Promise<AdapterOutcome>;
  update(ctx: AdapterContext, c: ResolvedConnector): Promise<AdapterOutcome>;
  verify(ctx: AdapterContext, c: ResolvedConnector): Promise<AdapterOutcome>;
  probe(ctx: AdapterContext): Promise<AdapterOutcome>;
}

/** Placeholder until the real adapter lands in P3; keeps the runner/CLI/tests honest meanwhile. */
export function notImplementedAdapter(platform: Platform): PlatformAdapter {
  const ni = async (): Promise<AdapterOutcome> => ({ status: "not-implemented", detail: `${platform} adapter lands in P3` });
  return { platform, list: async () => ({ names: [] }), add: ni, remove: ni, update: ni, verify: ni, probe: ni };
}
