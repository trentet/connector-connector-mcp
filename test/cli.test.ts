import { describe, expect, it } from "vitest";
import { parseFlags } from "../src/cli.js";

describe("cli --platform", () => {
  it("accepts several platforms and keeps connector ids separate", () => {
    const r = parseFlags(["vault-mcp", "--platform", "chatgpt", "grok", "--dry-run"]);
    expect(r).toMatchObject({ ids: ["vault-mcp"], platforms: ["chatgpt", "grok"], dryRun: true });
  });
  it("a connector id after the platform list is still an id", () => {
    expect(parseFlags(["--platform", "claude", "grok", "helm-drive"])).toMatchObject({ ids: ["helm-drive"], platforms: ["claude", "grok"] });
  });
  it("single value, 'all', and the default still work", () => {
    expect(parseFlags(["x", "--platform", "grok"])).toMatchObject({ platforms: ["grok"] });
    expect(parseFlags(["x", "--platform", "all"])).toMatchObject({ platforms: ["claude", "chatgpt", "grok"] });
    expect(parseFlags(["x"])).toMatchObject({ platforms: ["claude", "chatgpt", "grok"] });
  });
  it("rejects an unknown or missing platform", () => {
    expect(parseFlags(["x", "--platform", "bing"])).toEqual({ error: "unknown platform: bing" });
    expect(parseFlags(["x", "--platform"])).toHaveProperty("error");
    expect(parseFlags(["x", "--platform", "--dry-run"])).toHaveProperty("error");
  });
});

describe("cli reauth --only-if-older-than", () => {
  it("parses a positive number of days", () => {
    expect(parseFlags(["robot", "--only-if-older-than", "4.75"])).toMatchObject({ ids: ["robot"], onlyIfOlderThanDays: 4.75 });
    expect(parseFlags(["robot"])).toMatchObject({ onlyIfOlderThanDays: undefined });
  });
  it("rejects zero, negative, missing and non-numeric values", () => {
    for (const bad of [["--only-if-older-than", "0"], ["--only-if-older-than", "-1"], ["--only-if-older-than"], ["--only-if-older-than", "soon"]]) {
      expect(parseFlags(["robot", ...bad])).toHaveProperty("error");
    }
  });
});
