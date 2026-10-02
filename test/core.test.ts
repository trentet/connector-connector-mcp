import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Redactor } from "../src/core/redact.js";
import { loadRegistry, validateRegistry } from "../src/core/registry.js";
import { run } from "../src/core/runner.js";
import { resolve, type ResolveDeps } from "../src/core/secrets.js";
import { PLATFORMS } from "../src/core/types.js";

const SECRET = "s3cr3t-TOKEN-value-123456";
const files: Record<string, string> = {
  "/e/.env": `# c\nSHELL_MCP_SHELL_SECRET="shellSecretValue99"\nSHELL_MCP_BEARER_TOKEN=${SECRET}\nVAULT_MCP_BEARER_TOKEN='vaultTok-ABCDEF'\nVAULT_MCP_QUERY_TOKEN=vaultQuery-0987654321\nHELM_MCP_BEARER_TOKEN=audioTok-0123456789\nCC_MCP_BEARER_TOKEN=ccTok-aaaaaaaaaa\nPATCHRIGHT_MCP_BEARER_TOKEN=patchTok-9876543210\n`,
  "/info.txt": `url: https://mcp.trentt.me/mcp?token=driveTokenXYZ789 end`,
};
const deps: ResolveDeps = {
  env: { MY_ENV: "envSecret-12345" },
  readFile: (p) => files[p],
  vault: async (l) => (l === "Grok" ? { username: "u@example.com", password: "pw-GROK-9999" } : undefined),
};
const registryPath = path.resolve("registry", "connectors.json");

describe("secret sources", () => {
  const r = new Redactor();
  it("env, envFile (quotes/comments), fileRegex, vault, template", async () => {
    expect(await resolve({ type: "env", name: "MY_ENV" }, r, deps)).toBe("envSecret-12345");
    expect(await resolve({ type: "envFile", paths: ["/missing", "/e/.env"], key: "SHELL_MCP_SHELL_SECRET" }, r, deps)).toBe("shellSecretValue99");
    expect(await resolve({ type: "envFile", paths: ["/e/.env"], key: "VAULT_MCP_BEARER_TOKEN" }, r, deps)).toBe("vaultTok-ABCDEF");
    expect(await resolve({ type: "fileRegex", path: "/info.txt", pattern: "https://mcp\\.trentt\\.me/mcp\\?token=\\w+" }, r, deps)).toContain("driveTokenXYZ789");
    expect(await resolve({ type: "vault", label: "Grok", field: "username" }, r, deps)).toBe("u@example.com");
    expect(await resolve({ type: "template", template: "https://h/mcp?token={{t}}", variables: { t: { type: "env", name: "MY_ENV" } } }, r, deps)).toBe("https://h/mcp?token=envSecret-12345");
  });
  it("errors name the problem and never contain secret values", async () => {
    await expect(resolve({ type: "env", name: "NOPE" }, r, deps)).rejects.toThrow("NOPE is not set");
    await expect(resolve({ type: "vault", label: "Missing" }, r, deps)).rejects.toThrow('"Missing" not found');
    await expect(resolve({ type: "template", template: "{{x}}", variables: {} }, r, deps)).rejects.toThrow("x is not defined");
  });
  it("redactor scrubs resolved values and generic token params", () => {
    const red = new Redactor(); red.add("abcd1234secret");
    const out = red.redact("a abcd1234secret b https://h/mcp?shell_secret=ZZZ&token=YYY c x-api-key: QQQ");
    expect(out).not.toMatch(/abcd1234secret|ZZZ|YYY|QQQ/);
  });
});

describe("registry", () => {
  it("the shipped registry is valid", () => { expect(loadRegistry(registryPath).connectors.length).toBeGreaterThan(0); });
  it("rejects bad ids, dup ids, header auth without value, chatgpt/grok+header without tokenized URL", () => {
    const bad = { version: 1, connectors: [
      { id: "Bad_ID", name: "x", url: { type: "literal", value: "https://a" }, auth: { mode: "none" }, platforms: ["claude"] },
      { id: "dup", name: "x", url: { type: "literal", value: "https://a" }, auth: { mode: "header", headerName: "x-api-key" }, platforms: ["claude", "chatgpt", "grok"] },
      { id: "dup", name: "x", url: { type: "literal", value: "https://a" }, auth: { mode: "none" }, platforms: ["nope"] },
    ] };
    const { errors } = validateRegistry(bad);
    expect(errors.join("\n")).toMatch(/kebab-case/);
    expect(errors.join("\n")).toMatch(/duplicate id/);
    expect(errors.join("\n")).toMatch(/headerValue/);
    expect(errors.join("\n")).toMatch(/chatgpt cannot send custom headers/);
    expect(errors.join("\n")).toMatch(/grok cannot send custom headers/);
    expect(errors.join("\n")).toMatch(/platforms must be/);
  });
});

describe("runner", () => {
  const reg = loadRegistry(registryPath);
  const rewritten = JSON.parse(JSON.stringify(reg).replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/Remote Terminal MCP Connector/Repos/helm-terminal-mcp/.env", "/e/.env").replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/Vault MCP Connector/Repos/vault-mcp/.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/vault-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/vault-mcp/test/secrets/connector.env", "/e/.env").replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/HELM Drive MCP Connector/Repos/TT-MCP/connector-info.txt", "/info.txt").replaceAll("C:/Users/Trent/AppData/Local/HELM/helm-audio-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/helm-audio-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/patchright-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/connector-connector-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/connector-connector-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/tt-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/patchright-mcp/test/secrets/connector.env", "/e/.env"));
  it("dry-run resolves every seeded connector on every platform with ZERO secret leakage", async () => {
    const res = await run(rewritten, { op: "add", connectors: ["*"], platforms: PLATFORMS, dryRun: true }, { deps });
    const text = JSON.stringify(res);
    expect(res.ok).toBe(true);
    expect(res.items.filter((i) => i.status === "dry-run").length).toBe(18); // drive, shell, vault, audio, patchright, cc add 3 each; test-tier connectors are excluded from "*"
    expect(res.items.filter((i) => i.status === "skipped").length).toBe(0); // every seeded production connector now supports all three platforms
    for (const leak of [SECRET, "shellSecretValue99", "vaultTok-ABCDEF", "driveTokenXYZ789", "audioTok-0123456789", "patchTok-9876543210", "vaultQuery-0987654321"]) expect(text).not.toContain(leak);
    expect(text).toContain("<query redacted>");
    expect(text).toMatch(/header x-api-key set \(\d+ chars\)/);
    expect(text).toContain("https://shell.trentt.me/mcp"); // host and path stay visible
  });
  it("unknown connector and disabled platform are reported, not thrown", async () => {
    const res = await run(rewritten, { op: "verify", connectors: ["nope"], platforms: ["claude"] }, { deps });
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/unknown connector/);
  });
  it("without adapters, a real run reports not-implemented (never a false success)", async () => {
    const res = await run(rewritten, { op: "add", connectors: ["vault-mcp"], platforms: ["claude"] }, { deps });
    expect(res.items[0].status).toBe("not-implemented");
  });
  it("a failing resolve is an error item whose message has no secret", async () => {
    const res = await run(rewritten, { op: "add", connectors: ["helm-shell"], platforms: ["claude"], dryRun: true }, { deps: { ...deps, readFile: () => undefined } });
    expect(res.items[0].status).toBe("error");
  });
});

describe("test tier", () => {
  const reg = loadRegistry(registryPath);
  const rewritten = JSON.parse(JSON.stringify(reg).replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/Remote Terminal MCP Connector/Repos/helm-terminal-mcp/.env", "/e/.env").replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/Vault MCP Connector/Repos/vault-mcp/.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/vault-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/vault-mcp/test/secrets/connector.env", "/e/.env").replaceAll("D:/GDrive/HELM/DEV-PROJECTS/Connectors/HELM Drive MCP Connector/Repos/TT-MCP/connector-info.txt", "/info.txt").replaceAll("C:/Users/Trent/AppData/Local/HELM/helm-audio-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/helm-audio-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/patchright-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/connector-connector-mcp/production/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/connector-connector-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/tt-mcp/test/secrets/connector.env", "/e/.env").replaceAll("C:/Users/Trent/AppData/Local/HELM/patchright-mcp/test/secrets/connector.env", "/e/.env"));
  const tests = rewritten.connectors.filter((c: { tier?: string }) => c.tier === "test").map((c: { id: string }) => c.id);
  it("there is at least one test-tier connector and it is excluded from '*' by default", async () => {
    expect(tests.length).toBeGreaterThan(0);
    const res = await run(rewritten, { op: "add", connectors: ["*"], platforms: ["claude"], dryRun: true }, { deps });
    for (const t of tests) expect(res.items.some((i) => i.connector === t)).toBe(false);
  });
  it("includeTest adds them to '*'; naming one explicitly always works", async () => {
    const all = await run(rewritten, { op: "add", connectors: ["*"], platforms: ["claude"], dryRun: true, includeTest: true }, { deps });
    for (const t of tests) expect(all.items.some((i) => i.connector === t)).toBe(true);
    const one = await run(rewritten, { op: "add", connectors: [tests[0]], platforms: ["claude"], dryRun: true }, { deps });
    expect(one.items[0].status).toBe("dry-run");
  });
});

describe("universality", () => {
  it("no connector's id/name/host/env var appears in src/ (cc's OWN identity is allowed only under src/server/)", () => {
    const reg = loadRegistry(registryPath);
    const isSelf = (id: string) => id.startsWith("connector-connector");
    const termsFor = (cs: typeof reg.connectors) => {
      const terms = new Set<string>();
      for (const c of cs) { terms.add(c.id); terms.add(c.name); }
      const blob = JSON.stringify(cs);
      for (const m of blob.matchAll(/https?:\/\/([a-z0-9.-]+\.trentt\.me)/gi)) terms.add(m[1]);
      for (const m of blob.matchAll(/"key":"([A-Z0-9_]+)"/g)) terms.add(m[1]);
      return terms;
    };
    const others = termsFor(reg.connectors.filter((c) => !isSelf(c.id)));
    const self = termsFor(reg.connectors.filter((c) => isSelf(c.id)));
    for (const t of others) self.delete(t); // a term shared with another connector stays forbidden everywhere
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const offenders: string[] = [];
    for (const f of walk("src")) {
      const t = fs.readFileSync(f, "utf8").toLowerCase();
      const rel = f.replace(/\\/g, "/");
      for (const term of others) if (t.includes(term.toLowerCase())) offenders.push(`${rel}: ${term}`);
      if (!rel.startsWith("src/server/")) for (const term of self) if (t.includes(term.toLowerCase())) offenders.push(`${rel}: ${term} (cc's own identity outside src/server/)`);
    }
    expect(offenders).toEqual([]);
  });
});
