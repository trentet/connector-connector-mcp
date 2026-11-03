import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "patchright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BlockedError, claudeSettingsDriver, loadSettingsSpec, type SettingsSpec } from "../src/adapters/claudeSettings.js";
import type { AccountDef } from "../src/core/accounts.js";
import { normalizeText, runSettings } from "../src/core/settings.js";

/**
 * Real Chromium against a FAKE claude.ai Projects site (like test/signin.test.ts does for Google), built from the shapes the
 * shipped data/selectors/claude-settings.json expects. It proves the page logic and its bounds, not the real claude.ai UI
 * (those selectors stay "unverified" until read-only discovery on the host). Every page also offers Delete, Share and
 * Upgrade controls that report to the server if they are ever clicked. Invented projects and text only.
 */
function findChrome(): string | undefined {
  if (process.env.CC_TEST_CHROME) return process.env.CC_TEST_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
  const exe = dir && `${root}/${dir}/chrome-linux/chrome`;
  return exe && fs.existsSync(exe) ? exe : undefined;
}
const browser: Browser | undefined = await chromium.launch({ headless: true, executablePath: findChrome() }).catch(() => undefined);

const TEXT = "FIXTURE-INSTR-91b2 you are a test project\nline two of the private fixture text\nline three ends here";
const FILE = "/fixtures/settings-browser.txt";
const ACC: AccountDef = { id: "fixture", platforms: ["claude"], settings: { projects: [{ name: "Fixture Project", instructions: { type: "file", path: FILE } }] } };

interface P { id: string; name: string; text: string }
let state: { projects: P[]; mode: "ok" | "human-check" | "signed-out"; ignoreSave: boolean };
let hits: { creates: number; saves: number; forbidden: string[]; posts: number };
let server: http.Server, base = "";
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const forbidden = (label: string) => `<button onclick="fetch('/api/forbidden?c=${encodeURIComponent(label)}',{method:'POST'})">${label}</button>`;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", base);
    const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
    const html = (t: string, b: string) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(page(t, b)); };
    if (req.method === "POST") hits.posts++;
    if (u.pathname === "/api/forbidden") { hits.forbidden.push(u.searchParams.get("c") ?? "?"); return res.end("{}"); }
    if (u.pathname === "/api/projects" && req.method === "POST") {
      hits.creates++;
      const p = { id: crypto.randomUUID(), name: JSON.parse(body).name, text: "" };
      state.projects.push(p);
      return res.end(JSON.stringify({ id: p.id }));
    }
    const save = /^\/api\/projects\/([0-9a-f-]{36})\/instructions$/.exec(u.pathname);
    if (save && req.method === "POST") { hits.saves++; const p = state.projects.find((x) => x.id === save[1]); if (p && !state.ignoreSave) p.text = JSON.parse(body).text; return res.end("{}"); }
    if (state.mode === "human-check") return html("Just a moment...", "<p>Verify you are human by completing the action below.</p>");
    if (state.mode === "signed-out" && u.pathname !== "/login") { res.statusCode = 302; res.setHeader("location", "/login"); return res.end(); }
    if (u.pathname === "/login") return html("Claude", `<button>Continue with Google</button><p>Log in</p>`);
    if (u.pathname === "/projects") {
      const cards = state.projects.map((p) => `<a href="/project/${p.id}"><div>${p.name}</div><div>Updated 2 days ago</div></a>`).join("");
      return html("Projects", `<nav><button>Upgrade plan</button></nav><h1>Projects</h1><a href="/projects/create" role="button">+ New project</a>${forbidden("Delete all projects")}<main>${cards}</main>`);
    }
    if (u.pathname === "/projects/create") {
      return html("New project", `<label>What are you working on?<input placeholder="Name your project" id="n"></label>
        <button onclick="fetch('/api/projects',{method:'POST',body:JSON.stringify({name:document.getElementById('n').value})}).then(r=>r.json()).then(j=>location='/project/'+j.id)">Create project</button>`);
    }
    const proj = /^\/project\/([0-9a-f-]{36})$/.exec(u.pathname);
    if (proj) {
      const p = state.projects.find((x) => x.id === proj[1]);
      if (!p) { res.statusCode = 404; return res.end("no"); }
      return html(p.name, `<h1>${p.name}</h1>${forbidden("Share")}${forbidden("Delete project")}${forbidden("Rename")}
        <section><h2>Instructions</h2><button id="open">Set project instructions</button></section>
        <script>
          const current = ${JSON.stringify(p.text)};
          document.getElementById('open').onclick = () => {
            const d = document.createElement('div'); d.setAttribute('role', 'dialog');
            d.innerHTML = '<h2>Set project instructions</h2><textarea></textarea><button id="cancel">Cancel</button><button id="save">Save instructions</button>';
            document.body.appendChild(d);
            d.querySelector('textarea').value = current;
            d.querySelector('#cancel').onclick = () => d.remove();
            d.querySelector('#save').onclick = () => fetch('/api/projects/${p.id}/instructions', { method: 'POST', body: JSON.stringify({ text: d.querySelector('textarea').value }) }).then(() => d.remove());
          };
          document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('[role=dialog]').forEach((d) => d.remove()); });
        </script>`);
    }
    res.statusCode = 404; res.end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); await browser?.close(); });
beforeEach(() => { state = { projects: [], mode: "ok", ignoreSave: false }; hits = { creates: 0, saves: 0, forbidden: [], posts: 0 }; });

/** The shipped selectors, pointed at the fake host, with short waits. */
const spec = (over: Partial<SettingsSpec> = {}): SettingsSpec => {
  const s = loadSettingsSpec();
  return { ...s, hosts: ["localhost"], projectsUrl: `${base}/projects`, createUrl: `${base}/projects/create`, timing: { ...s.timing, pageMs: 10_000, elementMs: 3_000, settleMs: 100, listStableChecks: 2, pollMs: 500 }, ...over };
};

async function settings(op: "apply" | "verify", sp = spec()) {
  const ctx: BrowserContext = await browser!.newContext();
  const lines: string[] = [];
  let closed = 0;
  const r = await runSettings(op, ACC, {
    readFile: (p) => (p === FILE ? TEXT : undefined), log: (l) => lines.push(l), readBack: { attempts: 2, delayMs: 500 },
    open: async () => ({ page: claudeSettingsDriver(await ctx.newPage(), sp), close: async () => { closed++; await ctx.close(); }, blockedKind: (e) => (e instanceof BlockedError ? e.kind : undefined) }),
  });
  return { r, out: lines.join("\n") + JSON.stringify(r), closed };
}
const target = () => state.projects.filter((p) => p.name === "Fixture Project");

describe.skipIf(!browser)("cc settings (real Chromium, fake claude.ai Projects)", { timeout: 60_000 }, () => {
  it("apply creates the missing project, sets its instructions, reads them back, and prints no text", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Other", text: "other project's own text" });
    const { r, out, closed } = await settings("apply");
    expect(r.ok, out).toBe(true);
    expect(r.items[0]).toMatchObject({ status: "ok", action: "created" });
    expect(target()).toHaveLength(1);
    expect(target()[0].text).toBe(normalizeText(TEXT));
    expect(state.projects.find((p) => p.name === "Other")!.text).toBe("other project's own text");
    expect(hits).toMatchObject({ creates: 1, saves: 1, forbidden: [] });
    expect(closed).toBe(1);
    expect(out).toMatch(/read back: \d+ characters, sha256 [0-9a-f]{12}/);
    for (const l of TEXT.split("\n")) expect(out).not.toContain(l);
  });

  it("apply is idempotent: a second run on the same state writes nothing", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: normalizeText(TEXT) });
    const { r } = await settings("apply");
    expect(r.items[0]).toMatchObject({ status: "ok", action: "unchanged" });
    expect(hits).toMatchObject({ creates: 0, saves: 0, posts: 0, forbidden: [] });
  });

  it("apply updates an existing project with other text and never creates a second one", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: "old text" });
    const { r } = await settings("apply");
    expect(r.items[0]).toMatchObject({ status: "ok", action: "updated" });
    expect(target()).toHaveLength(1);
    expect(target()[0].text).toBe(normalizeText(TEXT));
    expect(hits).toMatchObject({ creates: 0, saves: 1, forbidden: [] });
  });

  it("verify only reads: no request that changes anything, ok on a match, error on a difference", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: normalizeText(TEXT) });
    expect((await settings("verify")).r.items[0]).toMatchObject({ status: "ok", action: "matches" });
    state.projects[0].text = "drifted";
    const { r } = await settings("verify");
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/differ/);
    expect(hits).toMatchObject({ posts: 0, forbidden: [] });
  });

  it("a near-identical name is refused: nothing is created or renamed", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "fixture project", text: "" });
    const { r } = await settings("apply");
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/close/);
    expect(hits).toMatchObject({ posts: 0 });
  });

  it("a save that does not stick is reported as an error after the read-back, never as ok", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: "old text" });
    state.ignoreSave = true;
    const { r } = await settings("apply");
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/reading them back/);
  });

  it("a human-check page stops the run without touching it", async () => {
    state.mode = "human-check";
    const { r, closed } = await settings("apply");
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/STOPPED \(human-check\)/);
    expect(hits.posts).toBe(0);
    expect(closed).toBe(1);
  });

  it("a signed-out account stops the run and nothing on the login page is clicked", async () => {
    state.mode = "signed-out";
    const { r } = await settings("verify");
    expect(r.items[0].detail).toMatch(/STOPPED \(signed-out\)/);
    expect(hits.posts).toBe(0);
  });

  it("rule 9 is enforced in code: a data file pointing a click at Delete is refused", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: "old" });
    const { r } = await settings("apply", spec({ instructionsOpen: "^delete project$" }));
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/refusing to click "Delete project"/);
    expect(hits.forbidden).toEqual([]);
  });

  it("never clicks on another host, whatever the data file says", async () => {
    state.projects.push({ id: crypto.randomUUID(), name: "Fixture Project", text: "old" });
    const { r } = await settings("apply", spec({ hosts: ["claude.ai"] }));
    expect(r.ok).toBe(false);
    expect(r.items[0].detail).toMatch(/STOPPED \(unexpected-page\)/);
    expect(hits.posts).toBe(0);
  });
});
