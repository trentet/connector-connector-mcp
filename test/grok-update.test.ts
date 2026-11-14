// @reqs REQ-U009 REQ-D001
import { describe, expect, it, vi } from "vitest";
import { updateByRemoveThenAdd } from "../src/adapters/grok.js";
import type { AdapterOutcome } from "../src/adapters/types.js";

const ok = (detail: string): AdapterOutcome => ({ status: "ok", detail });
const err = (detail: string): AdapterOutcome => ({ status: "error", detail });

function ops(init: { list: string[]; remove?: AdapterOutcome; add?: AdapterOutcome }) {
  const calls: string[] = [];
  return {
    calls,
    list: vi.fn(async () => { calls.push("list"); return init.list; }),
    remove: vi.fn(async () => { calls.push("remove"); return init.remove ?? ok("removed"); }),
    add: vi.fn(async () => { calls.push("add"); return init.add ?? ok("added"); }),
  };
}

describe("updateByRemoveThenAdd (REQ-U009 REQ-D001)", () => {
  it("removes then re-adds a connector that is already connected", async () => {
    const o = ops({ list: ["helm-secret", "other"] });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out).toEqual({ status: "ok", detail: '"helm-secret" updated (removed and re-added)' });
    expect(o.calls).toEqual(["list", "remove", "add"]);
    expect(o.remove).toHaveBeenCalledOnce();
    expect(o.add).toHaveBeenCalledOnce();
  });

  it("only adds when the connector is not already connected, and does not remove", async () => {
    const o = ops({ list: ["other"] });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out).toEqual({ status: "ok", detail: "added" });
    expect(o.calls).toEqual(["list", "add"]);
    expect(o.remove).not.toHaveBeenCalled();
  });

  it("does not add when remove fails", async () => {
    const o = ops({ list: ["helm-secret"], remove: err("still listed") });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out.status).toBe("error");
    expect(out.detail).toContain("update did not remove \"helm-secret\"");
    expect(out.detail).toContain("still listed");
    expect(out.detail).toContain("not re-adding");
    expect(o.calls).toEqual(["list", "remove"]);
    expect(o.add).not.toHaveBeenCalled();
  });

  it("treats a skipped remove as gone and still re-adds", async () => {
    const o = ops({ list: ["helm-secret"], remove: { status: "skipped", detail: "already gone" } });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out).toEqual({ status: "ok", detail: '"helm-secret" updated (removed and re-added)' });
    expect(o.calls).toEqual(["list", "remove", "add"]);
  });

  it("reports that re-add failed after a successful remove", async () => {
    const o = ops({ list: ["helm-secret"], add: err("did not appear") });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out.status).toBe("error");
    expect(out.detail).toBe('removed "helm-secret" but re-add failed (did not appear)');
    expect(o.calls).toEqual(["list", "remove", "add"]);
  });

  it("does not claim a remove happened when add fails and the connector was not connected", async () => {
    const o = ops({ list: [], add: err("submit failed") });
    const out = await updateByRemoveThenAdd("helm-secret", o);
    expect(out.status).toBe("error");
    expect(out.detail).toBe("submit failed");
    expect(out.detail).not.toMatch(/removed/);
    expect(o.remove).not.toHaveBeenCalled();
  });
});
