import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConsentUrl, fileLock, reauth, renewalAge, selectGoogleConnectors, withPort, type ReauthDeps, type TokenResponse } from "../src/core/reauth.js";
import { loadRegistry, validateRegistry } from "../src/core/registry.js";
import { expandEnv, SshTransport, type ExecResult, type Transport } from "../src/core/transport.js";
import type { ConnectorDef, GoogleOAuthDef, Registry } from "../src/core/types.js";

const SECRET = "client-SECRET-abc123", CODE = "4/0AUTHCODE-xyz789", REFRESH = "1//refresh-TOKEN-qwe456", ACCESS = "ya29.access-TOKEN-asd", PASSWORD = "pw-GOOGLE-7777";
const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"];
const CREDS = JSON.stringify({ installed: { client_id: "cid.apps.example", client_secret: SECRET, redirect_uris: ["http://localhost"] } });

const def = (over: Partial<GoogleOAuthDef> = {}): GoogleOAuthDef => ({
  secretsDir: "/s", scopes: SCOPES, account: { vaultLabel: "Google Account" },
  restart: { command: "restart-it" }, health: { url: "http://127.0.0.1:1/health", contains: "ok", waitSeconds: 5 }, ...over,
});
const connector = (id: string, g?: GoogleOAuthDef, tier?: "test"): ConnectorDef => ({ id, name: id, tier, url: { type: "literal", value: "https://x.example/mcp" }, auth: { mode: "none" }, platforms: ["claude"], googleOAuth: g });
const registry = (...c: ConnectorDef[]): Registry => ({ version: 1, connectors: c });

/** In-memory host: files, commands run, and a switchable health answer. */
function fakeHost(files: Record<string, string>, opts: { health?: () => string | undefined; restartCode?: () => number } = {}) {
  const writes: string[] = [], commands: string[] = [];
  const t: Transport = {
    where: "fake-host",
    join: (d, n) => `${d}/${n}`,
    readFile: async (f) => files[f],
    replaceFile: async (f, c) => { writes.push(f); files[f] = c; },
    exec: async (cmd): Promise<ExecResult> => { commands.push(cmd); return { code: opts.restartCode?.() ?? 0, stdout: "", stderr: "" }; },
    fetchText: async () => (opts.health ? opts.health() : "ok"),
  };
  return { t, files, writes, commands };
}

interface Run { consentCalls: number; exchanges: number; closed: number; urls: string[]; logs: string }
function deps(t: Transport, o: { vault?: ReauthDeps["vault"]; tokens?: TokenResponse; consent?: ReauthDeps["consent"]; sink?: Run } = {}): ReauthDeps & { run: Run } {
  const run: Run = o.sink ?? { consentCalls: 0, exchanges: 0, closed: 0, urls: [], logs: "" };
  let clock = 1_000_000;
  return {
    run,
    transport: () => t,
    vault: o.vault ?? (async () => ({ username: "me@example.com", password: PASSWORD })),
    // The fake "browser": read the redirect_uri + state out of the consent URL cc built and hit the real loopback server the way Google's redirect would.
    consent: o.consent ?? (async (a) => {
      run.consentCalls++; run.urls.push(a.url);
      const u = new URL(a.url);
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", CODE); back.searchParams.set("state", u.searchParams.get("state")!);
      await fetch(back);
      if (!a.isDone()) throw new Error("loopback did not register the redirect");
    }),
    closeBrowser: async () => { run.closed++; },
    exchange: async () => { run.exchanges++; return o.tokens ?? { access_token: ACCESS, refresh_token: REFRESH, scope: SCOPES.join(" "), token_type: "Bearer", expires_in: 3599 }; },
    sleep: async () => { clock += 3000; },
    now: () => (clock += 10),
    state: () => "state-fixed-123",
    logFile: null,
  };
}

/** Everything cc prints goes through console.error; capture it so we can prove no secret is in it. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const orig = console.error; let buf = "";
  console.error = (...a: unknown[]) => { buf += a.join(" ") + "\n"; };
  try { return { value: await fn(), stderr: buf }; } finally { console.error = orig; }
}
const noSecrets = (text: string) => { for (const s of [SECRET, CODE, REFRESH, ACCESS, PASSWORD]) expect(text).not.toContain(s); };

describe("connector selection", () => {
  const reg = registry(connector("a", def()), connector("a-test", def(), "test"), connector("plain"));
  it("'*' picks connectors with a googleOAuth block, production only unless includeTest", () => {
    expect(selectGoogleConnectors(reg, { connectors: ["*"] }).picked.map((c) => c.id)).toEqual(["a"]);
    expect(selectGoogleConnectors(reg, { connectors: ["*"], includeTest: true }).picked.map((c) => c.id)).toEqual(["a", "a-test"]);
  });
  it("naming a connector explicitly works for a test one; unknown ids and connectors with no block are errors", () => {
    expect(selectGoogleConnectors(reg, { connectors: ["a-test"] }).picked.map((c) => c.id)).toEqual(["a-test"]);
    const r = selectGoogleConnectors(reg, { connectors: ["nope", "plain"] });
    expect(r.picked).toEqual([]);
    expect(r.items.map((i) => i.status)).toEqual(["error", "error"]);
    expect(r.items[1].detail).toMatch(/no googleOAuth block/);
  });
});

describe("registry validation of googleOAuth", () => {
  const base = (g: unknown) => ({ version: 1, connectors: [{ ...connector("a"), repo: "o/a", googleOAuth: g }] });
  it("accepts a good block and the shipped registry", () => {
    expect(validateRegistry(base(def())).errors).toEqual([]);
    expect(loadRegistry("registry/connectors.json").connectors.some((c) => c.googleOAuth)).toBe(true);
  });
  it("rejects missing dir, non-Google scopes, no vault label, bad ssh, a bad health url", () => {
    const errs = validateRegistry(base({ secretsDir: "", scopes: ["https://evil.example/x"], account: {}, host: { ssh: "nope", keyFile: "" }, health: { url: "ftp://x" } })).errors.join("\n");
    expect(errs).toMatch(/secretsDir: required/);
    expect(errs).toMatch(/scopes: a non-empty list/);
    expect(errs).toMatch(/account.vaultLabel: required/);
    expect(errs).toMatch(/host.ssh: must look like user@host/);
    expect(errs).toMatch(/host.keyFile: required/);
    expect(errs).toMatch(/health.url: must be an http/);
    expect(errs).not.toMatch(/only meaningful together with restart/); // health without restart is allowed since #43
  });
  it("accepts a health block without restart; expectRenewedAt must be a boolean", () => {
    expect(validateRegistry(base(def({ restart: undefined, health: { url: "http://127.0.0.1:9/health", contains: "ok", waitSeconds: 120, expectRenewedAt: true } }))).errors).toEqual([]);
    expect(validateRegistry(base(def({ restart: undefined, health: { url: "http://127.0.0.1:9/health", expectRenewedAt: "yes" as never } }))).errors.join("\n")).toMatch(/expectRenewedAt: true or false/);
  });
});

describe("consent URL", () => {
  it("asks for offline access, forces consent, carries state + login hint and exactly the declared scopes", () => {
    const u = new URL(buildConsentUrl({ clientId: "cid", redirectUri: "http://localhost:5555/", scopes: SCOPES, state: "s1", loginHint: "me@example.com" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("s1");
    expect(u.searchParams.get("login_hint")).toBe("me@example.com");
    expect(withPort("http://localhost", 5555)).toBe("http://localhost:5555/");
  });
});

describe("cc reauth", () => {
  it("happy path: consent -> exchange -> new token.json -> restart -> health ok; nothing secret in the result or the log", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const d = deps(h.t);
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(res).toMatchObject({ ok: true, items: [{ connector: "a", status: "ok" }] });
    const written = JSON.parse(h.files["/s/token.json"]);
    expect(written).toMatchObject({ refresh_token: REFRESH, access_token: ACCESS, scope: SCOPES.join(" "), token_type: "Bearer" });
    expect(written.expiry_date).toBeGreaterThan(1_000_000);
    expect(h.commands).toEqual(["restart-it"]);
    expect(d.run.exchanges).toBe(1);
    expect(d.run.closed).toBe(1);
    noSecrets(JSON.stringify(res) + stderr);
    expect(new URL(d.run.urls[0]).searchParams.get("login_hint")).toBe("me@example.com");
  });

  it("the loopback only accepts the state cc generated", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS });
    const d = deps(h.t, { consent: async (a) => {
      const back = new URL(new URL(a.url).searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "FORGED"); back.searchParams.set("state", "someone-elses");
      await fetch(back);
      expect(a.isDone()).toBe(false);
      back.searchParams.set("code", CODE); back.searchParams.set("state", "state-fixed-123");
      await fetch(back);
      expect(a.isDone()).toBe(true);
    } });
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(res.ok).toBe(true);
  });

  it("Google grants fewer scopes than declared: error, token untouched, no restart", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const d = deps(h.t, { tokens: { refresh_token: REFRESH, access_token: ACCESS, scope: SCOPES[0] } });
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/fewer scopes.*documents.*nothing was written/);
    expect(h.files["/s/token.json"]).toBe("OLD");
    expect(h.commands).toEqual([]);
    noSecrets(JSON.stringify(res) + stderr);
  });

  it("no refresh_token in Google's answer: error, token untouched", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, deps(h.t, { tokens: { access_token: ACCESS, scope: SCOPES.join(" ") } })));
    expect(res.items[0].detail).toMatch(/no refresh_token/);
    expect(h.files["/s/token.json"]).toBe("OLD");
    expect(h.writes).toEqual([]);
  });

  it("health check fails after the restart: the previous token is restored and the server restarted again", async () => {
    let healthy = false;
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD-TOKEN-CONTENT" }, { health: () => (healthy ? "ok" : undefined) });
    // The server only comes back once the OLD token is back in place (the second restart).
    const origExec = h.t.exec;
    h.t.exec = async (c) => { const r = await origExec(c); healthy = h.files["/s/token.json"] === "OLD-TOKEN-CONTENT"; return r; };
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", def({ health: { url: "http://127.0.0.1:1/h", contains: "ok", waitSeconds: 3 } }))), { connectors: ["a"] }, deps(h.t)));
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/health check did not pass.*previous token was restored and the server is running again/);
    expect(h.files["/s/token.json"]).toBe("OLD-TOKEN-CONTENT");
    expect(h.commands).toEqual(["restart-it", "restart-it"]);
    noSecrets(JSON.stringify(res) + stderr);
  });

  it("a failing restart command also restores the previous token", async () => {
    let calls = 0;
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" }, { restartCode: () => (++calls === 1 ? 1 : 0) });
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, deps(h.t)));
    expect(res.items[0].detail).toMatch(/restart command exited 1; the previous token was restored/);
    expect(h.files["/s/token.json"]).toBe("OLD");
  });

  it("consent failure changes nothing and the browser is still released", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const d = deps(h.t, { consent: async () => { throw new Error("Google asked for 2-step verification that nobody approved in time"); } });
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(res.items[0]).toMatchObject({ status: "error" });
    expect(res.items[0].detail).toMatch(/2-step verification/);
    expect(h.writes).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(d.run.closed).toBe(1);
  });

  it("dry run opens no browser, writes nothing, restarts nothing, and says what is ready", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const d = deps(h.t);
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], dryRun: true }, d));
    expect(res.items[0].status).toBe("dry-run");
    expect(res.items[0].detail).toMatch(/credentials.json readable.*vault entry "Google Account" found.*token.json present.*restart configured.*health configured/);
    expect(d.run.consentCalls + d.run.exchanges).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.commands).toEqual([]);
    noSecrets(JSON.stringify(res) + stderr);
  });

  it("missing credentials.json, a non-Desktop client, and a missing vault entry are clear errors", async () => {
    const run = async (files: Record<string, string>, vault?: ReauthDeps["vault"]) => (await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, deps(fakeHost(files).t, { vault })))).value.items[0].detail;
    expect(await run({})).toMatch(/credentials.json not found at fake-host:\/s/);
    expect(await run({ "/s/credentials.json": JSON.stringify({ web: { client_id: "x" } }) })).toMatch(/not a Desktop-app OAuth client/);
    expect(await run({ "/s/credentials.json": JSON.stringify({ installed: { client_id: "x", client_secret: "y", redirect_uris: ["https://example.com/cb"] } }) })).toMatch(/no localhost redirect URI/);
    expect(await run({ "/s/credentials.json": CREDS }, async () => undefined)).toMatch(/vault entry "Google Account" not found/);
  });

  it("processes several connectors one after another with one browser, a failure in one does not stop the next", async () => {
    const good = fakeHost({ "/s/credentials.json": CREDS });
    const bad = fakeHost({});
    const d = deps(good.t);
    d.transport = (g) => (g.secretsDir === "/bad" ? bad.t : good.t);
    const reg = registry(connector("bad", def({ secretsDir: "/bad" })), connector("good", def()));
    const { value: res } = await captured(() => reauth(reg, { connectors: ["bad", "good"] }, d));
    expect(res.items.map((i) => `${i.connector}:${i.status}`)).toEqual(["bad:error", "good:ok"]);
    expect(res.ok).toBe(false);
    expect(d.run.closed).toBe(1);
  });
});

describe("transports", () => {
  it("expands %VAR% on this machine and leaves unknown names visible", () => {
    expect(expandEnv("%A%\\x\\%NOPE%", { A: "C:\\u" } as never)).toBe("C:\\u\\x\\%NOPE%");
  });
  it("ssh: key file, BatchMode, user@host and the Windows move command; scp uses forward slashes", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const runner = async (file: string, args: string[]) => { calls.push({ file, args }); return { code: 0, stdout: "", stderr: "" }; };
    const t = new SshTransport({ ssh: "me@box", keyFile: "/k/key", os: "windows" }, runner as never);
    expect(t.join("C:\\a\\secrets", "token.json")).toBe("C:\\a\\secrets\\token.json");
    await t.replaceFile("C:\\a\\secrets\\token.json", "{}");
    const scp = calls.find((c) => c.file === "scp")!;
    expect(scp.args).toEqual(expect.arrayContaining(["-i", "/k/key", "BatchMode=yes", "IdentitiesOnly=yes"]));
    expect(scp.args.at(-1)).toBe("me@box:C:/a/secrets/token.json.new");
    const ssh = calls.find((c) => c.file === "ssh")!;
    expect(ssh.args.at(-2)).toBe("me@box");
    expect(ssh.args.at(-1)).toBe("move /Y C:\\a\\secrets\\token.json.new C:\\a\\secrets\\token.json");
    // a path with a space is quoted for the remote shell
    calls.length = 0;
    await t.replaceFile("C:\\a b\\token.json", "{}");
    expect(calls.find((c) => c.file === "ssh")!.args.at(-1)).toBe('move /Y "C:\\a b\\token.json.new" "C:\\a b\\token.json"');
  });
  it("ssh posix uses mv -f and curl; a failed scp is an error and leaves nothing behind", async () => {
    const runner = async (file: string) => (file === "scp" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "ok", stderr: "" });
    const t = new SshTransport({ ssh: "me@box", keyFile: "/k/key", os: "posix" }, runner as never);
    await expect(t.replaceFile("/a/token.json", "{}")).rejects.toThrow(/could not upload/);
    expect(await t.readFile("/a/credentials.json")).toBeUndefined();
    expect(t.join("/a/", "x")).toBe("/a/x");
  });
});

describe("one renewal per connector at a time", () => {
  it("fileLock: exclusive, releasable, and a dead owner's lock is taken over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-lock-"));
    const lock = fileLock(dir);
    const release = lock("a")!;
    expect(release).toBeTypeOf("function");
    expect(lock("a")).toBeUndefined();     // held
    expect(lock("b")).toBeTypeOf("function"); // other connectors are independent
    release();
    const again = lock("a")!;
    expect(again).toBeTypeOf("function");
    again();
    fs.writeFileSync(path.join(dir, "dead.lock"), "999999999"); // no such process
    expect(lock("dead")).toBeTypeOf("function");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("a renewal that finds the lock held is skipped (not an error) and never touches the connector; a dry run ignores the lock", async () => {
    const h = fakeHost({ "/s/credentials.json": CREDS, "/s/token.json": "OLD" });
    const d = deps(h.t);
    d.lock = () => undefined;
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(res).toMatchObject({ ok: true, items: [{ connector: "a", status: "skipped", detail: expect.stringMatching(/already running/) }] });
    expect(h.writes).toEqual([]);
    expect(d.run.consentCalls).toBe(0);
    const dry = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], dryRun: true }, d));
    expect(dry.value.items[0].status).toBe("dry-run");
  });
  it("the lock is released after a failure too", async () => {
    const held = new Set<string>();
    const h = fakeHost({}); // no credentials.json -> error
    const d = deps(h.t);
    d.lock = (id) => { if (held.has(id)) return undefined; held.add(id); return () => held.delete(id); };
    await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, d));
    expect(held.size).toBe(0);
  });
});

describe("second renewer support (#39)", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const DAY = 86_400_000;
  const RECORD = "/s/token.renewed.json";
  // a clock fixed at NOW that still advances when cc sleeps, so health-check deadlines can pass
  const withNow = (d: ReauthDeps & { run: Run }) => { let t = NOW; return Object.assign(d, { now: () => t, sleep: async (ms: number) => { t += ms; } }); };
  const ago = (days: number, byHost = "host-a") => JSON.stringify({ renewedAt: new Date(NOW - days * DAY).toISOString(), byHost });
  const baseFiles = (extra: Record<string, string> = {}) => ({ "/s/credentials.json": CREDS, "/s/token.json": "OLD", ...extra });

  it("a fully successful renewal writes the record next to token.json (when and by which host, nothing secret)", async () => {
    const h = fakeHost(baseFiles());
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.ok).toBe(true);
    const rec = JSON.parse(h.files[RECORD]);
    expect(rec.renewedAt).toBe(new Date(NOW).toISOString());
    expect(typeof rec.byHost).toBe("string");
    expect(h.files[RECORD]).not.toMatch(new RegExp([SECRET, CODE, REFRESH, ACCESS, PASSWORD].join("|")));
    noSecrets(JSON.stringify(res) + stderr);
  });

  it("with no restart configured the record is still written; a failed health check or restart writes none", async () => {
    const noRestart = fakeHost(baseFiles());
    await captured(() => reauth(registry(connector("a", def({ restart: undefined, health: undefined }))), { connectors: ["a"] }, withNow(deps(noRestart.t))));
    expect(noRestart.files[RECORD]).toBeDefined();

    const badHealth = fakeHost(baseFiles(), { health: () => undefined });
    const r1 = await captured(() => reauth(registry(connector("a", def({ health: { url: "http://127.0.0.1:1/h", contains: "ok", waitSeconds: 3 } }))), { connectors: ["a"] }, withNow(deps(badHealth.t))));
    expect(r1.value.ok).toBe(false);
    expect(badHealth.files[RECORD]).toBeUndefined();
    expect(badHealth.files["/s/token.json"]).toBe("OLD");

    const badRestart = fakeHost(baseFiles(), { restartCode: () => 1 });
    await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, withNow(deps(badRestart.t))));
    expect(badRestart.files[RECORD]).toBeUndefined();
  });

  it("--only-if-older-than: a recent record means skipped, with no vault lookup, no browser consent, no write and no restart", async () => {
    const h = fakeHost(baseFiles({ [RECORD]: ago(2, "W540") }));
    const d = withNow(deps(h.t, { vault: async () => { throw new Error("the vault must not be touched on a skip"); } }));
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], onlyIfOlderThanDays: 4.75 }, d));
    expect(res).toMatchObject({ ok: true, items: [{ connector: "a", status: "skipped" }] });
    expect(res.items[0].detail).toMatch(/renewed 2\.0 day\(s\) ago by W540; nothing to do/);
    expect(d.run.consentCalls + d.run.exchanges).toBe(0);
    expect(h.writes).toEqual([]);
    expect(h.commands).toEqual([]);
  });

  it("an old, missing, unreadable or future-dated record all mean renew (fail toward renewing)", async () => {
    for (const [label, rec] of [["old", ago(6)], ["missing", undefined], ["unreadable", "not json {"], ["no date", "{}"], ["future", ago(-3)]] as const) {
      const h = fakeHost(baseFiles(rec === undefined ? {} : { [RECORD]: rec }));
      const d = withNow(deps(h.t));
      const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], onlyIfOlderThanDays: 4.75 }, d));
      expect(res.items[0].status, label).toBe("ok");
      expect(d.run.consentCalls, label).toBe(1);
      expect(JSON.parse(h.files[RECORD]).renewedAt, label).toBe(new Date(NOW).toISOString());
    }
  });

  it("token.json's own expiry is never used: a fresh-looking token.json without a record is still renewed", async () => {
    const h = fakeHost(baseFiles({ "/s/token.json": JSON.stringify({ expiry_date: NOW + 3_000_000, refresh_token: "x" }) }));
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], onlyIfOlderThanDays: 4.75 }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
  });

  it("without the flag nothing is skipped, even with a fresh record", async () => {
    const h = fakeHost(baseFiles({ [RECORD]: ago(0.1) }));
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
  });

  it("dry run says it would skip when the record is recent, and still opens nothing", async () => {
    const h = fakeHost(baseFiles({ [RECORD]: ago(1) }));
    const d = withNow(deps(h.t));
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], dryRun: true, onlyIfOlderThanDays: 4.75 }, d));
    expect(res.items[0]).toMatchObject({ status: "dry-run" });
    expect(res.items[0].detail).toMatch(/^would skip: renewed 1\.0 day/);
    expect(d.run.consentCalls).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("a Google-only entry (googleOAuth, platforms [], no url) is valid; platforms [] or absent without googleOAuth are not", () => {
    const robot = { id: "robot", name: "Robot", repo: "o/robot", platforms: [], auth: { mode: "none" }, googleOAuth: def() };
    expect(validateRegistry({ version: 1, connectors: [robot] }).errors).toEqual([]);
    expect(validateRegistry({ version: 1, connectors: [{ ...robot, googleOAuth: undefined }] }).errors.join("\n")).toMatch(/platforms must be a non-empty subset/);
    // platforms absent on a googleOAuth entry is normalised to [] (#44); without googleOAuth it is still an error
    expect(validateRegistry({ version: 1, connectors: [{ ...robot, platforms: undefined }] }).errors).toEqual([]);
    expect(validateRegistry({ version: 1, connectors: [{ ...robot, platforms: undefined, googleOAuth: undefined }] }).errors.join("\n")).toMatch(/platforms must be a non-empty subset/);
    // an entry that does list a platform still needs its url
    expect(validateRegistry({ version: 1, connectors: [{ ...robot, platforms: ["claude"] }] }).errors.join("\n")).toMatch(/url/);
    const reg = validateRegistry({ version: 1, connectors: [robot] }).registry!;
    expect(selectGoogleConnectors(reg, { connectors: ["*"] }).picked.map((c) => c.id)).toEqual(["robot"]);
  });
});

describe("health check without a restart, and proof that the new token was loaded (#43)", () => {
  const NOW = Date.parse("2026-10-09T12:00:00Z");
  const RECORD = "/s/token.renewed.json";
  // a clock that advances when cc sleeps, so a health wait can run out
  const withNow = (d: ReauthDeps & { run: Run }) => { let t = NOW; return Object.assign(d, { now: () => t, sleep: async (ms: number) => { t += ms; } }); };
  const files = (extra: Record<string, string> = {}) => ({ "/s/credentials.json": CREDS, "/s/token.json": "OLD-TOKEN", ...extra });
  const noRestart = (health: NonNullable<GoogleOAuthDef["health"]>) => def({ restart: undefined, health });
  const H = (over: Partial<NonNullable<GoogleOAuthDef["health"]>> = {}) => ({ url: "http://127.0.0.1:9/health", contains: '"drive":"ok"', waitSeconds: 9, ...over });

  it("no restart, health ok: delivers, runs no command, polls health, writes the record, says it was re-read", async () => {
    const h = fakeHost(files(), { health: () => '{"drive":"ok"}' });
    const { value: res } = await captured(() => reauth(registry(connector("a", noRestart(H()))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
    expect(res.items[0].detail).toMatch(/re-read by the server \(no restart\); health ok/);
    expect(h.commands).toEqual([]);
    expect(JSON.parse(h.files["/s/token.json"]).refresh_token).toBe(REFRESH);
    expect(JSON.parse(h.files[RECORD]).renewedAt).toBe(new Date(NOW).toISOString());
  });

  it("no restart, health never ok: the previous token is restored, no record is written, and the error says so", async () => {
    const h = fakeHost(files(), { health: () => undefined });
    const { value: res } = await captured(() => reauth(registry(connector("a", noRestart(H({ waitSeconds: 6 })))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/health check did not pass within 6s; the previous token was restored but the server still did not come back/);
    expect(h.files["/s/token.json"]).toBe("OLD-TOKEN");
    expect(h.files[RECORD]).toBeUndefined();
    expect(h.commands).toEqual([]);
  });

  it("a health page that is already ok on the OLD token passes a plain check at once (why expectRenewedAt exists)", async () => {
    const h = fakeHost(files(), { health: () => '{"drive":"ok","renewedAt":"2026-10-01T00:00:00.000Z"}' });
    const { value: res } = await captured(() => reauth(registry(connector("a", noRestart(H()))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
  });

  it("expectRenewedAt: a stale ok does not pass; the record is put back; the token is restored", async () => {
    const OLD_RECORD = JSON.stringify({ renewedAt: "2026-10-01T00:00:00.000Z", byHost: "old-host" });
    const h = fakeHost(files({ [RECORD]: OLD_RECORD }), { health: () => '{"drive":"ok","renewedAt":"2026-10-01T00:00:00.000Z"}' });
    const { value: res } = await captured(() => reauth(registry(connector("a", noRestart(H({ waitSeconds: 6, expectRenewedAt: true })))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.ok).toBe(false);
    expect(res.items[0].detail).toMatch(/did not show the new renewal record/);
    expect(res.items[0].detail).toMatch(/previous token was restored and the server is running again/); // the plain check passes on the old token
    expect(h.files["/s/token.json"]).toBe("OLD-TOKEN");
    expect(h.files[RECORD]).toBe(OLD_RECORD);
  });

  it("expectRenewedAt: passes only once the page echoes the new renewedAt (the server loads it a few polls later)", async () => {
    const h = fakeHost(files(), { health: () => undefined });
    let polls = 0;
    h.t.fetchText = async () => {
      polls++;
      const rec = h.files[RECORD] ? JSON.parse(h.files[RECORD]) : {};
      return polls < 3 ? '{"drive":"ok","renewedAt":"2026-10-01T00:00:00.000Z"}' : JSON.stringify({ drive: "ok", renewedAt: rec.renewedAt });
    };
    const { value: res } = await captured(() => reauth(registry(connector("a", noRestart(H({ waitSeconds: 30, expectRenewedAt: true })))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
    expect(res.items[0].detail).toMatch(/health ok, showing the new renewal/);
    expect(polls).toBe(3);
    expect(JSON.parse(h.files[RECORD]).renewedAt).toBe(new Date(NOW).toISOString());
  });

  it("expectRenewedAt with no previous record: a failed renewal leaves an undated record, which counts as 'renew' for --only-if-older-than", async () => {
    const h = fakeHost(files(), { health: () => undefined });
    await captured(() => reauth(registry(connector("a", noRestart(H({ waitSeconds: 6, expectRenewedAt: true })))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(h.files["/s/token.json"]).toBe("OLD-TOKEN");
    expect(renewalAge(h.files[RECORD], NOW)).toBeUndefined();
  });

  it("with a restart configured, expectRenewedAt also applies (restart, then the page must show the new record)", async () => {
    const h = fakeHost(files());
    h.t.fetchText = async () => { const rec = h.files[RECORD] ? JSON.parse(h.files[RECORD]) : {}; return JSON.stringify({ drive: "ok", renewedAt: rec.renewedAt }); };
    const { value: res } = await captured(() => reauth(registry(connector("a", def({ health: H({ expectRenewedAt: true }) }))), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].status).toBe("ok");
    expect(h.commands).toEqual(["restart-it"]);
  });
});

describe("leftovers of closed PR #41 (#44): dry-run renew wording and the record-write warning", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z"), DAY = 86_400_000, RECORD = "/s/token.renewed.json";
  const withNow = (d: ReauthDeps & { run: Run }) => { let t = NOW; return Object.assign(d, { now: () => t, sleep: async (ms: number) => { t += ms; } }); };
  const ago = (days: number) => JSON.stringify({ renewedAt: new Date(NOW - days * DAY).toISOString(), byHost: "host-a" });
  const baseFiles = (extra: Record<string, string> = {}) => ({ "/s/credentials.json": CREDS, "/s/token.json": "OLD", ...extra });

  it("--dry-run with --only-if-older-than says 'would renew' for an old or missing record, and still writes nothing", async () => {
    for (const [label, files] of [["old", baseFiles({ [RECORD]: ago(6) })], ["missing", baseFiles()]] as const) {
      const h = fakeHost({ ...files });
      const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], dryRun: true, onlyIfOlderThanDays: 4.75 }, withNow(deps(h.t))));
      expect(res.items[0].status, label).toBe("dry-run");
      expect(res.items[0].detail, label).toMatch(/^would renew: /);
      expect(h.writes, label).toEqual([]);
    }
  });

  it("--dry-run without the flag does not claim 'would renew' (nothing was compared)", async () => {
    const h = fakeHost(baseFiles());
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], dryRun: true }, withNow(deps(h.t))));
    expect(res.items[0].detail).not.toMatch(/would renew/);
  });

  it("a record that cannot be written is carried as a WARNING in the item detail, not only in the log", async () => {
    for (const g of [def(), def({ restart: undefined, health: undefined })]) {
      const h = fakeHost(baseFiles());
      const t = { ...h.t, replaceFile: async (f: string, c: string) => { if (f === RECORD) throw new Error("disk full"); return h.t.replaceFile(f, c); } };
      const { value: res } = await captured(() => reauth(registry(connector("a", g)), { connectors: ["a"] }, withNow(deps(t))));
      expect(res.items[0].status).toBe("ok");
      expect(res.items[0].detail).toMatch(/WARNING: could not write token\.renewed\.json \(disk full\)/);
    }
  });

  it("a normal renewal carries no warning", async () => {
    const h = fakeHost(baseFiles());
    const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"] }, withNow(deps(h.t))));
    expect(res.items[0].detail).not.toMatch(/WARNING/);
  });

  it("the skip comparison is strict: a record exactly as old as the limit renews, one just under it is skipped", async () => {
    for (const [age, status] of [[4.75, "ok"], [4.7499, "skipped"], [4.7501, "ok"]] as const) {
      const h = fakeHost(baseFiles({ [RECORD]: ago(age) }));
      const { value: res } = await captured(() => reauth(registry(connector("a", def())), { connectors: ["a"], onlyIfOlderThanDays: 4.75 }, withNow(deps(h.t))));
      expect(res.items[0].status, String(age)).toBe(status);
    }
  });
});
