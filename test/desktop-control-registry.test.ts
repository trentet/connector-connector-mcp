// @reqs REQ-D011
// REQ-D011: the registry entry of the PRODUCTION desktop control connector (id desktop-control). Every case of the
// requirement, read from registry/connectors.json only: nothing here opens a browser, a network connection or a token file,
// and no token value is ever read.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Entry = {
  id: string;
  tier?: string;
  platforms?: string[];
  url?: { type?: string; value?: string };
  auth?: { mode?: string; headerName?: string; headerValue?: { type?: string; path?: string; pattern?: string } };
};
const reg = JSON.parse(readFileSync(join(__dirname, "..", "registry", "connectors.json"), "utf8")) as { connectors: Entry[] };
const byId = (id: string): Entry | undefined => reg.connectors.find((c) => c.id === id);
const prod = byId("desktop-control") as Entry;
const test = byId("desktop-control-test") as Entry;
const hv = (e: Entry) => e.auth?.headerValue;

// The directory every production connector hosted on KNOTTYAI-PC names its token under (a copy on the host cc runs on:
// secrets.ts reads local files only).
const HELM_BASE = "C:/Users/Trent/AppData/Local/HELM";

describe("REQ-D011 the production entry exists and is the production tier", () => {
  it("TC-D011-01 exists once, tier production, Claude only, on the production host name", () => {
    expect(reg.connectors.filter((c) => c.id === "desktop-control")).toHaveLength(1);
    expect(prod.tier).toBe("production");
    expect(prod.platforms).toEqual(["claude"]);
    expect(prod.url).toEqual({ type: "literal", value: "https://desktop.trentt.me/mcp" });
  });
  it("TC-D011-02 sends the token in the x-api-key header (the only header the HTTP entry point accepts)", () => {
    expect(prod.auth?.mode).toBe("header");
    expect(prod.auth?.headerName).toBe("x-api-key");
    expect(hv(prod)?.type).toBe("fileRegex");
  });
  it("TC-D011-03 has the same shape as the test entry apart from the environment (no field is missing or extra)", () => {
    expect(Object.keys(prod).sort()).toEqual(Object.keys(test).sort());
    expect(Object.keys(prod.auth ?? {}).sort()).toEqual(Object.keys(test.auth ?? {}).sort());
    expect(Object.keys(hv(prod) ?? {}).sort()).toEqual(Object.keys(hv(test) ?? {}).sort());
  });
});

describe("REQ-D011 where cc reads the production token", () => {
  it("TC-D011-04 names the token file under the local production secrets folder of desktop-control", () => {
    expect(hv(prod)?.path).toBe(`${HELM_BASE}/desktop-control/production/secrets/token`);
  });
  it("TC-D011-05 uses a local drive path only: never a share or network path (cc reads local files only)", () => {
    const p = hv(prod)?.path ?? "";
    expect(p).toMatch(/^[A-Za-z]:\//);
    expect(p.startsWith("//")).toBe(false);
    expect(p.includes("\\\\")).toBe(false);
  });
  it("TC-D011-06 its pattern takes a whole 64-character token made of the characters the connector's setup writes", () => {
    const re = new RegExp(hv(prod)?.pattern ?? "(", "");
    const sample = "aZ09_-".repeat(10) + "abcd"; // 64 characters, shape only, not a real token
    expect(sample).toHaveLength(64);
    expect(re.exec(sample)?.[0]).toBe(sample);
    expect(re.exec("")).toBeNull();
  });
  it("TC-D011-07 follows the pattern of the other production connectors hosted on the host (folder <id>/production/secrets under the same base)", () => {
    for (const id of ["helm-vision-mcp", "helm-audio-mcp", "helm-thread-monitor"]) {
      const e = byId(id) as unknown as { auth: { headerValue?: { paths?: string[] }; urlValue?: unknown } } | undefined;
      const text = JSON.stringify(e);
      expect(text, id).toContain(`${HELM_BASE}/${id}/production/secrets/`);
    }
    expect(hv(prod)?.path?.startsWith(`${HELM_BASE}/desktop-control/production/secrets/`)).toBe(true);
  });
});

describe("REQ-D011 production never shares anything with test", () => {
  it("TC-D011-08 the token file, the URL and the name differ from the test entry", () => {
    expect(hv(prod)?.path).not.toBe(hv(test)?.path);
    expect(prod.url?.value).not.toBe(test.url?.value);
    expect(prod.id).not.toBe(test.id);
  });
  it("TC-D011-09 nothing of the production entry points into a test folder or a test host name", () => {
    const text = JSON.stringify(prod).toLowerCase();
    expect(text).not.toContain("/test/");
    expect(text).not.toContain("desktop-test");
    expect(text).not.toContain('"tier":"test"');
  });
  it("TC-D011-10 the test entry keeps its own test token file and host (the definition of production changes nothing of it)", () => {
    expect(test.tier).toBe("test");
    expect(hv(test)?.path).toBe(`${HELM_BASE}/desktop-control/test/secrets/token`);
    expect(test.url?.value).toBe("https://desktop-test.trentt.me/mcp");
  });
});
