import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildConsentUrl, fileLock, reauth, renewalAgeDays, RENEWAL_RECORD, selectGoogleConnectors, withPort, type ReauthDeps, type TokenResponse } from "../src/core/reauth.js";
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
    hostname: () => "test-host",
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
  it("rejects missing dir, non-Google scopes, no vault label, bad ssh, health without restart", () => {
    const errs = validateRegistry(base({ secretsDir: "", scopes: ["https://evil.example/x"], account: {}, host: { ssh: "nope", keyFile: "" }, health: { url: "ftp://x" } })).errors.join("\n");
    expect(errs).toMatch(/secretsDir: required/);
    expect(errs).toMatch(/scopes: a non-empty list/);
    expect(errs).toMatch(/account.vaultLabel: required/);
    expect(errs).toMatch(/host.ssh: must look like user@host/);
    expect(errs).toMatch(/host.keyFile: required/);
    expect(errs).toMatch(/health.url: must be an http/);
    expect(errs).toMatch(/only meaningful together with restart/);
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

describe("cc reauth --only-if-older-than (the renewal record)", () => {
  const DAY = 86_400_000;
  const RECORD = `/s/${RENEWAL_RECORD}`;
  const recordAt = (daysAgo: number, byHost = "primary-host") => JSON.stringify({ renewedAt: new Date(1_000_000 - daysAgo * DAY).toISOString(), byHost });
  const base = (record?: string) => ({ "/s/credentials.json": CREDS, "/s/token.json": "OLD", ...(record === undefined ? {} : { [RECORD]: record }) });
  type Host = ReturnType<typeof fakeHost>;
  const go = async (files: Record<string, string>, req: { onlyIfOlderThanDays?: number; dryRun?: boolean } = {}, o: { g?: GoogleOAuthDef; host?: Host; vault?: ReauthDeps["vault"] } = {}) => {
    const h = o.host ?? fakeHost(files);
    const d = deps(h.t, { vault: o.vault });
    const { value: res, stderr } = await captured(() => reauth(registry(connector("a", o.g ?? def())), { connectors: ["a"], ...req }, d));
    return { h, d, res, stderr };
  };

  it("a record younger than the limit skips: one record read, no vault, no browser, no write, no restart", async () => {
    let vaultCalls = 0;
    const reads: string[] = [];
    const h = fakeHost(base(recordAt(1.8)));
    const read = h.t.readFile; h.t.readFile = async (f) => { reads.push(f); return read(f); };
    const { res, d } = await go({}, { onlyIfOlderThanDays: 4.75 }, { host: h, vault: async () => { vaultCalls++; return { username: "u", password: PASSWORD }; } });
    expect(res).toMatchObject({ ok: true, items: [{ connector: "a", status: "skipped", detail: "renewed 1.8 days ago by primary-host (renews only when older than 4.75 days)" }] });
    expect(reads).toEqual([RECORD]);
    expect(vaultCalls).toBe(0);
    expect(d.run.consentCalls + d.run.exchanges).toBe(0);
    expect(h.writes).toEqual([]); expect(h.commands).toEqual([]);
  });

  it("an older record renews, and the new record says when and by which host", async () => {
    const { res, h } = await go(base(recordAt(5)), { onlyIfOlderThanDays: 4.75 });
    expect(res.items[0].status).toBe("ok");
    const rec = JSON.parse(h.files[RECORD]);
    expect(rec).toEqual({ renewedAt: expect.any(String), byHost: "test-host" });
    expect(Number.isFinite(Date.parse(rec.renewedAt))).toBe(true);
    expect(h.writes).toEqual(["/s/token.json", RECORD]);
    expect(JSON.parse(h.files["/s/token.json"]).refresh_token).toBe(REFRESH); // the record sits beside token.json, never inside it
  });

  it("fails toward renewing: a missing, unreadable, malformed or future-dated record renews", async () => {
    for (const rec of [undefined, "", "not json", "{}", JSON.stringify({ renewedAt: "yesterday" }), JSON.stringify({ renewedAt: 42 }), recordAt(-3)]) {
      expect((await go(base(rec), { onlyIfOlderThanDays: 4.75 })).res.items[0].status).toBe("ok");
    }
  });

  it("without the flag the record is ignored: a fresh record does not stop a renewal", async () => {
    const { res, h } = await go(base(recordAt(0.1)));
    expect(res.items[0].status).toBe("ok");
    expect(h.writes).toContain(RECORD);
  });

  it("a renewal that is rolled back (health fails) or whose restart fails leaves the old record alone", async () => {
    const old = recordAt(6);
    const sick = fakeHost(base(old), { health: () => undefined });
    const r1 = await go({}, { onlyIfOlderThanDays: 4.75 }, { host: sick, g: def({ health: { url: "http://127.0.0.1:1/health", contains: "ok", waitSeconds: 1 } }) });
    expect(r1.res.items[0].status).toBe("error");
    expect(sick.files[RECORD]).toBe(old);
    const dead = fakeHost(base(old), { restartCode: () => 1 });
    const r2 = await go({}, { onlyIfOlderThanDays: 4.75 }, { host: dead });
    expect(r2.res.items[0].status).toBe("error");
    expect(dead.files[RECORD]).toBe(old);
  });

  it("a connector with no restart configured still gets its record once the token is delivered", async () => {
    const { res, h } = await go(base(), {}, { g: def({ restart: undefined, health: undefined }) });
    expect(res.items[0].status).toBe("ok");
    expect(JSON.parse(h.files[RECORD]).byHost).toBe("test-host");
  });

  it("a failed record write does not fail a successful renewal; it says so", async () => {
    const h = fakeHost(base());
    const replace = h.t.replaceFile;
    h.t.replaceFile = async (f, c) => { if (f === RECORD) throw new Error("disk full"); return replace(f, c); };
    const { res, stderr } = await go({}, {}, { host: h });
    expect(res).toMatchObject({ ok: true, items: [{ status: "ok" }] });
    expect(res.items[0].detail).toMatch(/WARNING: token\.renewed\.json could not be written/);
    expect(stderr).toMatch(/could not write token\.renewed\.json: disk full/);
  });

  it("a dry run still checks every prerequisite, writes nothing, and says what a real run would do", async () => {
    const skip = await go(base(recordAt(1)), { onlyIfOlderThanDays: 4.75, dryRun: true });
    expect(skip.res.items[0].status).toBe("dry-run");
    expect(skip.res.items[0].detail).toMatch(/vault entry "Google Account" found.*would skip: renewed 1\.0 days ago by primary-host/);
    const renew = await go(base(recordAt(6)), { onlyIfOlderThanDays: 4.75, dryRun: true });
    expect(renew.res.items[0].detail).toMatch(/would renew: no usable renewal record, or older than 4\.75 days/);
    expect(skip.h.writes).toEqual([]); expect(renew.h.writes).toEqual([]);
    expect(skip.h.commands).toEqual([]);
  });

  it("renewalAgeDays: the age in days, the host named, odd hosts tolerated", () => {
    const now = 10 * DAY;
    expect(renewalAgeDays(JSON.stringify({ renewedAt: new Date(7 * DAY).toISOString(), byHost: "h" }), now)).toEqual({ ageDays: 3, byHost: "h" });
    expect(renewalAgeDays(JSON.stringify({ renewedAt: new Date(7 * DAY).toISOString() }), now)?.byHost).toBe("an unknown host");
    expect(renewalAgeDays(undefined, now)).toBeUndefined();
    expect(renewalAgeDays(JSON.stringify({ renewedAt: new Date(11 * DAY).toISOString() }), now)).toBeUndefined();
  });

  it("the record never contains a secret", async () => {
    const { h, stderr, res } = await go(base());
    for (const s of [SECRET, CODE, REFRESH, ACCESS, PASSWORD]) expect(h.files[RECORD]).not.toContain(s);
    noSecrets(JSON.stringify(res) + stderr);
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
