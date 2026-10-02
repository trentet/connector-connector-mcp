// Shared environment layout for cc (mirrors the other HELM connectors: <base>/deploy/<env>, <base>/<env>/secrets/connector.env).
import { homedir } from "node:os";
import { join } from "node:path";

export const ENVS = ["production", "test"];
export const PORTS = { production: 8810, test: 8811 };
export const HOSTNAMES = { production: "cc.trentt.me", test: "cc-test.trentt.me" };

export function helmBase(e = process.env, platform = process.platform, home = homedir()) {
  if (e.HELM_DATA_ROOT) return e.HELM_DATA_ROOT;
  if (platform === "win32") return join(e.LOCALAPPDATA ?? join(home, "AppData", "Local"), "HELM", "connector-connector-mcp");
  if (platform === "darwin") return join(home, "Library", "Application Support", "HELM", "connector-connector-mcp");
  return join(e.XDG_DATA_HOME ?? join(home, ".local", "share"), "helm", "connector-connector-mcp");
}
export const deployDir = (env, base = helmBase()) => join(base, "deploy", env);
export const secretsFile = (env, base = helmBase()) => join(base, env, "secrets", "connector.env");
