import { describe, expect, it } from "vitest";
import { replaceConnector } from "../src/adapters/replace.js";
import type { AdapterContext, AdapterOutcome, ResolvedConnector } from "../src/adapters/types.js";

const ctx = { platform: "grok", redact: (s: string) => s, session: async () => { throw new Error("no browser in this test"); } } as unknown as AdapterContext;
const c = { name: "Demo", url: "https://demo.example.test/mcp", def: { id: "demo" } } as unknown as ResolvedConnector;
const ok = (detail = ""): AdapterOutcome => ({ status: "ok", detail });

function fake(over: { names?: string[]; remove?: AdapterOutcome; adds?: AdapterOutcome[]; verify?: AdapterOutcome }) {
  const calls: string[] = [];
  const adds = [...(over.adds ?? [ok()])];
  return {
    calls,
    a: {
      list: async () => { calls.push("list"); return { names: over.names ?? ["Demo"] }; },
      remove: async () => { calls.push("remove"); return over.remove ?? ok(); },
      add: async (_x: AdapterContext, _y: ResolvedConnector, ifExisting: string) => { calls.push(`add:${ifExisting}`); return adds.shift() ?? { status: "error" as const, detail: "no more" }; },
      verify: async () => { calls.push("verify"); return over.verify ?? ok(); },
    },
  };
}

describe("replaceConnector (update for a platform with no edit form)", () => {
  it("removes, adds back, verifies, in that order", async () => {
    const f = fake({});
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("ok");
    expect(f.calls).toEqual(["list", "remove", "add:fail", "verify"]);
  });
  it("a connector that is not there is a plain add, with nothing removed", async () => {
    const f = fake({ names: ["Other"] });
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("ok");
    expect(f.calls).toEqual(["list", "add:fail"]);
  });
  it("a remove that does not say ok stops everything: no add is tried", async () => {
    const f = fake({ remove: { status: "error", detail: "still listed" } });
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/stopped at the remove step/);
    expect(f.calls).toEqual(["list", "remove"]);
  });
  it("one failed add is retried once and can still succeed", async () => {
    const f = fake({ adds: [{ status: "error", detail: "slow" }, ok()] });
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("ok");
    expect(f.calls.filter((x) => x === "add:fail")).toHaveLength(2);
  });
  it("two failed adds say plainly that the connector is MISSING", async () => {
    const f = fake({ adds: [{ status: "error", detail: "a" }, { status: "error", detail: "b" }] });
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/REMOVED and could not be added back/);
    expect(r.detail).toMatch(/MISSING on grok/);
  });
  it("an add that said ok but fails verify is not reported as ok", async () => {
    const f = fake({ verify: { status: "error", detail: "not listed" } });
    const r = await replaceConnector(f.a, ctx, c);
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/verify said error/);
  });
});
