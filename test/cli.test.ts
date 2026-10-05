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

describe("cli --only-if-older-than", () => {
  it("takes a number of days and leaves the other flags alone", () => {
    expect(parseFlags(["a", "b", "--only-if-older-than", "4.75", "--dry-run"])).toMatchObject({ ids: ["a", "b"], onlyIfOlderThan: 4.75, dryRun: true });
    expect(parseFlags(["a", "--only-if-older-than", "5"])).toMatchObject({ ids: ["a"], onlyIfOlderThan: 5 });
    expect(parseFlags(["a"])).toMatchObject({ onlyIfOlderThan: undefined });
  });
  it("rejects a missing, zero, negative or non-numeric value instead of renewing on a guess", () => {
    for (const v of [undefined, "0", "-1", "abc", "4,75", "1e3", "", "Infinity", "--dry-run"]) {
      const argv = v === undefined ? ["a", "--only-if-older-than"] : ["a", "--only-if-older-than", v];
      expect(parseFlags(argv)).toEqual({ error: "--only-if-older-than needs a number of days greater than 0, e.g. 4.75" });
    }
  });
});

