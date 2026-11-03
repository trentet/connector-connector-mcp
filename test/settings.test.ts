import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAccounts, validateSettings, type AccountDef } from "../src/core/accounts.js";
import { fingerprint, normalizeText, planProject, resolveTextFile, runSettings, settingsLogFile, type SettingsPage, type SettingsSession } from "../src/core/settings.js";
import { CLICK_DENY, loadSettingsSpec } from "../src/adapters/claudeSettings.js";
import { main } from "../src/cli.js";

/**
 * `cc settings apply|verify` (issue #74, CLAUDE.md rule 9). Each block names the requirement of the brief it proves.
 * Invented accounts, projects and text only.
 */
const FILE = path.resolve("/fixtures/instructions.txt");
const TEXT = "MARKER-7f3c first line of the fixture instructions\nsecond line that must never be printed\r\nthird line, also private\n";
const ACC: AccountDef = { id: "fixture", platforms: ["claude"], master: "browser-master-fixture", settings: { projects: [{ name: "Fixture Project", instructions: { type: "file", path: FILE } }] } };
const files: Record<string, string> = { [FILE]: TEXT };
const readFile = (p: string) => files[p];

/** An in-memory claude.ai: projects with instructions, counting every write. */
function fakeClaude(init: { name: string; text: string }[] = [], opts: { ignoreWrites?: boolean; blocked?: Error; throwOnWrite?: string } = {}) {
  const projects = init.map((p, i) => ({ ...p, href: `https://claude.example/project/${i}` }));
  const calls = { creates: 0, writes: 0, opens: 0, closed: 0, opened: 0 };
  let current: (typeof projects)[number] | undefined;
  const page: SettingsPage = {
    async listProjects() { if (opts.blocked) throw opts.blocked; return projects.map(({ name, href }) => ({ name, href })); },
    async createProject(name) { calls.creates++; const p = { name, text: "", href: `https://claude.example/project/${projects.length}` }; projects.push(p); current = p; return p.href; },
    async openProject(href) { calls.opens++; current = projects.find((p) => p.href === href); if (!current) throw new Error("no such project"); },
    async readInstructions() { return current!.text; },
    async writeInstructions(t) { calls.writes++; if (opts.throwOnWrite) throw new Error(opts.throwOnWrite); if (!opts.ignoreWrites) current!.text = t; },
  };
  const open = async (): Promise<SettingsSession> => { calls.opened++; return { page, close: async () => { calls.closed++; }, blockedKind: (e) => (e === opts.blocked ? "human-check" : undefined) }; };
  return { projects, calls, open };
}
const capture = () => { const lines: string[] = []; return { lines, log: (l: string) => lines.push(l) }; };
const noSleep = async () => {};

describe("req 2: the registry block holds references only and is validated", () => {
  it("the checked-in accounts file is valid and every settings block is a file reference, never text", () => {
    const a = loadAccounts();
    const withSettings = a.accounts.filter((x) => x.settings);
    expect(withSettings.length).toBeGreaterThan(0);
    for (const x of withSettings) for (const p of x.settings!.projects) {
      expect(Object.keys(p).sort()).toEqual(["instructions", "name"]);
      expect(Object.keys(p.instructions).sort()).toEqual(["path", "type"]);
      expect(p.instructions.type).toBe("file");
    }
  });
  it("refuses an empty block, non-exact names, duplicates, inline text and unknown fields", () => {
    expect(validateSettings({}).join()).toMatch(/at least one project/);
    expect(validateSettings({ projects: [] }).join()).toMatch(/at least one project/);
    expect(validateSettings({ projects: [{ name: " Lead", instructions: { type: "file", path: "/a" } }] }).join()).toMatch(/exact name/);
    expect(validateSettings({ projects: [{ name: "Two  spaces", instructions: { type: "file", path: "/a" } }] }).join()).toMatch(/exact name/);
    expect(validateSettings({ projects: [{ name: "", instructions: { type: "file", path: "/a" } }] }).join()).toMatch(/non-empty/);
    const dup = { name: "Same", instructions: { type: "file", path: "/a" } };
    expect(validateSettings({ projects: [dup, dup] }).join()).toMatch(/duplicate/);
    expect(validateSettings({ projects: [{ name: "X", instructions: { type: "literal", value: "inline text" } }] }).join()).toMatch(/reference/);
    expect(validateSettings({ projects: [{ name: "X", instructions: { type: "file", path: "/a" }, text: "inline" }] }).join()).toMatch(/unknown field/);
  });
});

describe("req 4: refusals before any browser opens", () => {
  it("an account without a settings block is refused and no browser opens", async () => {
    const f = fakeClaude();
    const r = await runSettings("apply", { ...ACC, settings: undefined }, { open: f.open, readFile });
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/no "settings" block/);
    expect(f.calls.opened).toBe(0);
  });
  it("a missing, empty, relative or unexpanded instructions file is refused and no browser opens", async () => {
    for (const [p, want] of [["/fixtures/missing.txt", /not found/], ["/fixtures/empty.txt", /empty/], ["relative/file.txt", /absolute/], ["%NOPE_VAR%/x.txt", /NOPE_VAR.*not set/]] as const) {
      const f = fakeClaude();
      const acc: AccountDef = { ...ACC, settings: { projects: [{ name: "P", instructions: { type: "file", path: p } }] } };
      const r = await runSettings("apply", acc, { open: f.open, readFile: (x) => (x === "/fixtures/empty.txt" ? " \r\n\t\n" : files[x]), env: {} });
      expect(r.ok).toBe(false);
      expect(r.items[0].detail).toMatch(want);
      expect(f.calls.opened).toBe(0);
    }
  });
  it("an account not used on claude is refused", async () => {
    const f = fakeClaude();
    const r = await runSettings("verify", { ...ACC, platforms: ["grok"] }, { open: f.open, readFile });
    expect(r.ok).toBe(false);
    expect(f.calls.opened).toBe(0);
  });
  it("%VAR% in the path is expanded, the text is normalised (BOM, CRLF, outer blank space) and oversized files are refused", () => {
    expect(resolveTextFile({ type: "file", path: "%BASE%/instructions.txt" }, { BASE: "/fixtures" }, readFile)).toBe(normalizeText(TEXT));
    expect(normalizeText("﻿  a\r\nb\r\n\n")).toBe("a\nb");
    expect(() => resolveTextFile({ type: "file", path: "/big" }, {}, () => "x".repeat(100_001))).toThrow(/over 100000/);
    expect(fingerprint("a\r\nb\n")).toEqual(fingerprint("a\nb"));
  });
});

describe("req 4: exact project names only", () => {
  const found = [{ name: "Fixture Project", href: "h1" }, { name: "Other", href: "h2" }];
  it("one exact match is opened, no match is created", () => {
    expect(planProject(found, "Fixture Project")).toEqual({ kind: "open", href: "h1" });
    expect(planProject(found, "Brand New")).toEqual({ kind: "create" });
  });
  it("a near match (case or spacing) is refused instead of creating a look-alike; two exact matches are ambiguous", () => {
    expect(planProject([{ name: "fixture  project", href: "h" }], "Fixture Project")).toMatchObject({ kind: "refuse", why: expect.stringMatching(/close/) });
    expect(planProject([{ name: "X", href: "a" }, { name: "X", href: "b" }], "X")).toMatchObject({ kind: "refuse", why: expect.stringMatching(/2 projects/) });
  });
  it("the whole run refuses on a near match and creates nothing", async () => {
    const f = fakeClaude([{ name: "fixture project", text: "" }]);
    const r = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(f.calls.creates + f.calls.writes).toBe(0);
  });
});

describe("req 4: dry run opens no browser", () => {
  it("resolves the account and the file and says what it would do", async () => {
    const f = fakeClaude(), c = capture();
    const r = await runSettings("apply", ACC, { dryRun: true, open: f.open, readFile, log: c.log });
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([expect.objectContaining({ project: "Fixture Project", status: "dry-run", action: "would-apply" })]);
    const fp = fingerprint(TEXT);
    expect(r.items[0].detail).toContain(`${fp.chars} characters, sha256 ${fp.sha256.slice(0, 12)}`);
    expect(f.calls.opened).toBe(0);
  });
});

describe("req 3+4: apply is idempotent and only real when read back", () => {
  it("creates a missing project, writes once, reads back; a second apply writes nothing", async () => {
    const f = fakeClaude([{ name: "Other", text: "someone else's instructions" }]);
    const r1 = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep });
    expect(r1.ok).toBe(true);
    expect(r1.items[0]).toMatchObject({ status: "ok", action: "created" });
    expect(f.calls).toMatchObject({ creates: 1, writes: 1, opened: 1, closed: 1 });
    const r2 = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep });
    expect(r2.items[0]).toMatchObject({ status: "ok", action: "unchanged" });
    expect(f.calls).toMatchObject({ creates: 1, writes: 1, opened: 2, closed: 2 });
    expect(f.projects.find((p) => p.name === "Other")!.text).toBe("someone else's instructions");
    expect(f.projects.filter((p) => p.name === "Fixture Project")).toHaveLength(1);
  });
  it("an existing project with other text is updated (never recreated)", async () => {
    const f = fakeClaude([{ name: "Fixture Project", text: "old text" }]);
    const r = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep });
    expect(r.items[0]).toMatchObject({ status: "ok", action: "updated" });
    expect(f.calls.creates).toBe(0);
  });
  it("a save that does not stick is an error after polling, never ok", async () => {
    const f = fakeClaude([{ name: "Fixture Project", text: "old text" }], { ignoreWrites: true });
    const r = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep, readBack: { attempts: 3, delayMs: 500 } });
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/reading them back/);
    expect(f.calls.opens).toBe(1 + 3);
  });
  it("a human check stops the call, is reported as such, and the browser is still closed", async () => {
    const f = fakeClaude([], { blocked: new Error("human check page") });
    const r = await runSettings("apply", ACC, { open: f.open, readFile, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/STOPPED \(human-check\)/);
    expect(f.calls).toMatchObject({ creates: 0, writes: 0, closed: 1 });
  });
});

describe("req 4: verify is a read-only comparison", () => {
  it("matching text is ok; different text or a missing project is an error; nothing is ever written or created", async () => {
    const ok = fakeClaude([{ name: "Fixture Project", text: normalizeText(TEXT) + "\n" }]);
    expect((await runSettings("verify", ACC, { open: ok.open, readFile })).items[0]).toMatchObject({ status: "ok", action: "matches" });
    const diff = fakeClaude([{ name: "Fixture Project", text: "stale" }]);
    const r = await runSettings("verify", ACC, { open: diff.open, readFile });
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/differ/);
    const none = fakeClaude();
    expect((await runSettings("verify", ACC, { open: none.open, readFile })).items[0].detail).toMatch(/no project named exactly/);
    for (const f of [ok, diff, none]) expect(f.calls.creates + f.calls.writes).toBe(0);
  });
});

describe("req 3: the instruction text never reaches output, logs or errors", () => {
  it("not in printed lines, the log file or the JSON result, even when a page error quotes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-settings-log-"));
    const logFile = path.join(dir, "settings", "fixture.log");
    const runs = [
      { op: "apply" as const, f: fakeClaude([{ name: "Fixture Project", text: "old" }]) },
      { op: "apply" as const, f: fakeClaude([{ name: "Fixture Project", text: "old" }], { throwOnWrite: `could not type "${normalizeText(TEXT)}"` }) },
      { op: "verify" as const, f: fakeClaude([{ name: "Fixture Project", text: "old" }]) },
      { op: "apply" as const, f: fakeClaude(), dry: true },
    ];
    const out: string[] = [];
    for (const x of runs) {
      const c = capture();
      const r = await runSettings(x.op, ACC, { open: x.f.open, readFile, sleep: noSleep, log: c.log, logFile, dryRun: x.dry });
      out.push(...c.lines, JSON.stringify(r));
    }
    out.push(fs.readFileSync(logFile, "utf8"));
    const all = out.join("\n");
    expect(all).toMatch(/characters, sha256 [0-9a-f]{12}/);
    for (const l of normalizeText(TEXT).split("\n")) expect(all).not.toContain(l.trim());
    expect(all).not.toContain("MARKER-7f3c");
    expect(all).toContain("<REDACTED>"); // the quoting error was scrubbed, not dropped
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("the log goes to logs/settings/<account>.log under CC_LOG_DIR", () => {
    expect(settingsLogFile("fixture", { CC_LOG_DIR: "/l" })).toBe(path.join("/l", "settings", "fixture.log"));
  });
});

describe("req 3+5: selectors are data; what may be clicked is bounded in code", () => {
  it("the shipped selector file loads, has no auth block, and every entry is marked unverified until seen live", () => {
    const spec = loadSettingsSpec();
    expect(spec.projectsUrl).toMatch(/^https:\/\/claude\.ai\//);
    const raw = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "claude-settings.json"), "utf8"));
    expect(raw.auth).toBeUndefined();
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) expect((v as { status?: string }).status, k).toMatch(/^(unverified|verified)$/);
    expect(spec.unverified.length).toBe(Object.keys(raw).filter((k) => !k.startsWith("_") && raw[k].status !== "verified").length);
  });
  it("refuses a data file whose waits would busy-wait", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-settings-spec-"));
    const raw = JSON.parse(fs.readFileSync(path.resolve("data", "selectors", "claude-settings.json"), "utf8"));
    raw.timing.value.pollMs = 50;
    fs.writeFileSync(path.join(dir, "claude-settings.json"), JSON.stringify(raw));
    expect(() => loadSettingsSpec(path.join(dir, "claude-settings.json"))).toThrow(/500 ms/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("the deny list blocks every forbidden kind of control and lets the four allowed ones through", () => {
    for (const bad of ["Delete project", "Remove", "Rename", "Archive", "Share", "Invite members", "Upgrade plan", "Billing", "Continue with Google", "Log in", "Sign out", "Add connector", "Manage memory", "Preferences", "Leave project"]) expect(CLICK_DENY.test(bad), bad).toBe(true);
    for (const good of ["Create project", "+ New project", "Set project instructions", "Edit project instructions", "Save instructions", "Save", "Edit"]) expect(CLICK_DENY.test(good), good).toBe(false);
  });
});

describe("req 1: the CLI", () => {
  it("needs a sub-command and an explicit --account, and refuses unknown arguments", async () => {
    const errs: string[] = [];
    const orig = console.error; console.error = (m: string) => errs.push(String(m));
    try {
      expect(await main(["settings"])).toBe(2);
      expect(await main(["settings", "delete", "--account", "fixture"])).toBe(2);
      expect(await main(["settings", "apply"])).toBe(2);
      expect(await main(["settings", "apply", "--account", "--dry-run"])).toBe(2);
      expect(await main(["settings", "verify", "--account", "x", "--force"])).toBe(2);
    } finally { console.error = orig; }
    expect(errs.join("\n")).toMatch(/--account is required/);
    expect(errs.join("\n")).toMatch(/unknown argument\(s\): --force/);
  });
});
