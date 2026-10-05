import { describe, expect, it } from "vitest";
import type { PlatformAdapter } from "../src/adapters/types.js";
import type { BrowserSession } from "../src/browser/chrome.js";
import { validateRegistry } from "../src/core/registry.js";
import { run } from "../src/core/runner.js";
import { selectGoogleConnectors } from "../src/core/reauth.js";
import { PLATFORMS, type GoogleOAuthDef, type Platform, type Registry } from "../src/core/types.js";
import { registryFixture } from "./fixtures.js";

const google: GoogleOAuthDef = {
  secretsDir: "/srv/robot/secrets", scopes: ["https://www.googleapis.com/auth/drive"], account: { vaultLabel: "Robot Google" },
  host: { ssh: "robot@nas.example", keyFile: "%USERPROFILE%\\.ssh\\k", os: "posix" }, restart: { command: "docker restart robot" }, health: { url: "http://127.0.0.1:9/health", contains: "ok", waitSeconds: 30 },
};
/** A Google-only entry: a googleOAuth block, nothing to register on any platform. */
const robot = (over: Record<string, unknown> = {}) => ({ id: "robot", name: "Robot", auth: { mode: "none" }, repo: "o/robot", googleOAuth: google, ...over });
const registry = (...c: unknown[]) => ({ version: 1, connectors: c });
const mcp = { id: "plain", name: "Plain", url: { type: "literal", value: "https://x.example/mcp" }, auth: { mode: "none" }, platforms: ["claude"] };

describe("a Google-only registry entry (a googleOAuth block, no platform, no url)", () => {
  it("is valid with platforms omitted or empty, and normalised to an empty platform list", () => {
    for (const over of [{}, { platforms: [] }]) {
      const { registry: reg, errors } = validateRegistry(registry(robot(over)));
      expect(errors).toEqual([]);
      expect(reg?.connectors[0].platforms).toEqual([]);
      expect(reg?.connectors[0].url).toBeUndefined();
    }
  });

  it("still needs everything a renewal needs: repo, a valid googleOAuth block, id and name", () => {
    expect(validateRegistry(registry(robot({ repo: undefined }))).errors.join("\n")).toMatch(/repo: required when googleOAuth is set/);
    expect(validateRegistry(registry(robot({ googleOAuth: { ...google, scopes: ["https://evil.example/x"] } }))).errors.join("\n")).toMatch(/scopes: a non-empty list/);
    expect(validateRegistry(registry(robot({ id: "Not Kebab", name: "" }))).errors.join("\n")).toMatch(/id must be kebab-case[\s\S]*name required/);
  });

  it("the exemption is only for an entry WITH a googleOAuth block: any other entry still needs platforms and a url", () => {
    const { platforms: _p, url: _u, ...noPlatformsNoUrl } = { ...mcp };
    const noPlatforms = validateRegistry(registry(noPlatformsNoUrl)).errors.join("\n");
    expect(noPlatforms).toMatch(/platforms must be a non-empty subset of claude\|chatgpt\|grok \(only an entry with a googleOAuth block may leave it empty\)/);
    expect(noPlatforms).toMatch(/url: required/);
    expect(validateRegistry(registry({ ...mcp, platforms: [] })).errors.join("\n")).toMatch(/platforms must be a non-empty subset/);
    expect(validateRegistry(registry({ ...mcp, url: undefined })).errors.join("\n")).toMatch(/\.url: required/);
  });

  it("an entry that lists platforms must still have a url, even with a googleOAuth block; a bad platform is still an error", () => {
    expect(validateRegistry(registry(robot({ platforms: ["claude"] }))).errors.join("\n")).toMatch(/\.url: required/);
    expect(validateRegistry(registry(robot({ platforms: ["bing"] }))).errors.join("\n")).toMatch(/platforms must be a subset of/);
    expect(validateRegistry(registry(robot({ platforms: ["claude"], url: { type: "literal", value: "https://x.example/mcp" } }))).errors).toEqual([]);
  });

  it("a bad url source on an entry that has one is still reported", () => {
    expect(validateRegistry(registry({ ...mcp, url: { type: "bogus" } })).errors.join("\n")).toMatch(/\.url: invalid source type/);
  });

  it("reauth picks it up by id and with --all, like any other googleOAuth entry", () => {
    const reg = validateRegistry(registry(robot(), mcp)).registry as Registry;
    expect(selectGoogleConnectors(reg, { connectors: ["robot"] }).picked.map((c) => c.id)).toEqual(["robot"]);
    expect(selectGoogleConnectors(reg, { connectors: ["*"] }).picked.map((c) => c.id)).toEqual(["robot"]);
  });

  it("platform operations skip it, opening no browser and resolving no url", async () => {
    const reg = validateRegistry(registry(robot())).registry as Registry;
    const { deps } = registryFixture(reg);
    const opened: Platform[] = [];
    const sessionFactory = async (p: Platform): Promise<BrowserSession> => { opened.push(p); throw new Error("no browser should be opened for a Google-only entry"); };
    const adapter = (platform: Platform): PlatformAdapter => ({ platform } as unknown as PlatformAdapter);
    const adapters = Object.fromEntries(PLATFORMS.map((p) => [p, adapter(p)])) as Record<Platform, PlatformAdapter>;
    for (const connectors of [["robot"], ["*"]]) {
      const res = await run(reg, { op: "add", connectors, platforms: [...PLATFORMS] }, { deps, adapters, sessionFactory });
      expect(res.ok).toBe(true);
      expect(res.items.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
      expect(res.items[0].detail).toBe("platform not enabled for this connector");
    }
    expect(opened).toEqual([]);
  });
});
