import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** A fake `bw serve`: a few items, a TOTP endpoint, and a DELETE that records whether the permanent flag was used. */
let server: http.Server;
const deletes: string[] = [];
let totpAnswer: unknown = "654321";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/list/object/items") return void res.end(JSON.stringify({ success: true, data: { data: [{ id: "i1", name: "robot" }, { id: "i2", name: "dup" }, { id: "i3", name: "dup" }] } }));
    if (u.pathname === "/object/totp/i1") return void res.end(JSON.stringify({ success: true, data: { data: totpAnswer } }));
    if (req.method === "DELETE") { deletes.push(req.url ?? ""); return void res.end(JSON.stringify({ success: true })); }
    res.statusCode = 404; res.end(JSON.stringify({ success: false, message: "no" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.BW_SERVE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); delete process.env.BW_SERVE_URL; });

describe("vault authenticator code", () => {
  it("returns the current 6-digit code for a label", async () => {
    const { getTotp } = await import("../src/core/vaultClient.js");
    expect(await getTotp("robot")).toBe("654321");
  });
  it("returns nothing for an unknown label, and refuses an ambiguous one", async () => {
    const { getTotp } = await import("../src/core/vaultClient.js");
    expect(await getTotp("nope")).toBeUndefined();
    await expect(getTotp("dup")).rejects.toThrow(/ambiguous/);
  });
  it("returns nothing when the vault answers with something that is not a code", async () => {
    const { getTotp } = await import("../src/core/vaultClient.js");
    totpAnswer = "not-a-code";
    expect(await getTotp("robot")).toBeUndefined();
    totpAnswer = "654321";
  });
  it("deletes a one-time entry permanently, not just into the trash", async () => {
    const { deleteCredential } = await import("../src/core/vaultClient.js");
    expect(await deleteCredential("robot")).toBe(true);
    expect(deletes).toEqual(["/object/item/i1?permanent=true"]);
  });
});
