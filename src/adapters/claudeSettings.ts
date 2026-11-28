import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "patchright";
import { domFill, sleep } from "../browser/dom.js";

/**
 * Page logic for `cc settings` on claude.ai: find a project by exact name, create it, read and write its instructions.
 * Facts about the page (URLs, selectors, waits) are data in data/selectors/claude-settings.json; a UI change is fixed there.
 *
 * What this file may click is bounded by CLAUDE.md rule 9 (operator, 3 Nov 2026) and enforced HERE, in code, so that no data
 * edit can widen it: clicks happen only through `guardedClick`, only on the configured claude.ai hosts, only for the four
 * roles below (create-project, create submit, open the instructions editor, its Save), and never on a control whose name
 * matches CLICK_DENY. Projects are opened by navigating to their link, not by clicking. A read closes the editor with a key
 * press (no button). The instruction text is never returned in an error, logged or printed.
 */

/** `name` is the project tile's name (projectName, else its first line); `lines` are all of the project tile's text lines, so a name shown elsewhere in a project tile is never mistaken for "missing". */
export interface ProjectRef { name: string; href: string; lines?: string[] }
interface Entry<T> { value: T; status?: string; seen?: string; guess?: string }
export interface SettingsTiming { pageMs: number; elementMs: number; listStableChecks: number; pollMs: number; settleMs: number; readBackAttempts: number; readBackDelayMs: number }
export interface SettingsSpec {
  hosts: string[]; projectsUrl: string; projectLink: string; projectName: string; projectPath: string; projectHeading: string; protectedProjects: string[];
  createUrl: string; createButton: string; createDialog: string; /** CSS inside createDialog */ createNameField: string; createSubmit: string;
  instructionsOpen: string; instructionsDialog: string; instructionsField: string; instructionsFieldKind: "textarea" | "contenteditable"; instructionsSave: string; closeKey: string;
  signedOutMarkers: string[]; humanCheck: { titles: string[]; bodyMarkers: string[]; frameHosts: string[] };
  timing: SettingsTiming;
  /** Keys whose entry is not marked "verified" in the data file. */
  unverified: string[];
}

const KEYS = ["hosts", "projectsUrl", "projectLink", "projectName", "projectPath", "projectHeading", "protectedProjects", "createUrl", "createButton", "createDialog", "createNameField", "createSubmit", "instructionsOpen", "instructionsDialog", "instructionsField", "instructionsFieldKind", "instructionsSave", "closeKey", "signedOutMarkers", "humanCheck", "timing"] as const;

export function loadSettingsSpec(file = path.resolve(process.env.CC_SELECTORS_DIR ?? path.join("data", "selectors"), "claude-settings.json")): SettingsSpec {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, unknown> = { unverified: [] as string[] };
  for (const k of KEYS) {
    const e = raw[k];
    if (e === undefined) throw new Error(`${path.basename(file)}: "${k}" is missing`);
    const isEntry = !!e && typeof e === "object" && !Array.isArray(e) && "value" in (e as object);
    out[k] = isEntry ? (e as Entry<unknown>).value : e;
    if (!isEntry || (e as Entry<unknown>).status !== "verified") (out.unverified as string[]).push(k);
  }
  const s = out as unknown as SettingsSpec;
  if (s.instructionsFieldKind !== "textarea" && s.instructionsFieldKind !== "contenteditable") throw new Error(`${path.basename(file)}: instructionsFieldKind must be "textarea" or "contenteditable"`);
  for (const [k, v] of Object.entries(s.timing)) if (/Ms$/.test(k) && k !== "pageMs" && k !== "elementMs" && (v as number) < 500) throw new Error(`${path.basename(file)}: timing.${k} must be 500 ms or more (no busy waiting)`);
  return s;
}

/**
 * Controls cc never clicks, whatever the data file says (CLAUDE.md rule 9): anything that deletes, removes, renames, archives,
 * shares, invites, upgrades or bills, signs in or out, or touches connectors, memory or preferences.
 */
export const CLICK_DENY = /delete|remove|rename|more options|archive|share|invite|upgrade|billing|subscri|\bplan\b|payment|sign ?(in|out|up)|log ?(in|out)|continue with|connector|integration|memory|preference|leave|disconnect|permission|visibility|transfer/i;

export class BlockedError extends Error { constructor(public kind: "human-check" | "signed-out" | "unexpected-page", detail: string) { super(detail); } }

const rx = (p: string) => new RegExp(p, "i");
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
/** Origin + path only: never a query string. */
export const safeUrl = (u: string) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return "(no url)"; } };
const onHost = (u: string, hosts: string[]) => { const h = hostOf(u); return hosts.some((x) => h === x || h.endsWith("." + x)); };

/** What the page in front of us is. A human check or a lost sign-in is reported, never acted on. */
export async function checkPage(page: Page, spec: SettingsSpec): Promise<void> {
  const title = (await page.title().catch(() => "")).toLowerCase();
  const body = (await page.evaluate(() => document.body?.innerText.slice(0, 800) ?? "").catch(() => "")).toLowerCase();
  const frames = page.frames().map((f) => hostOf(f.url()));
  const hc = spec.humanCheck;
  if (hc.titles.some((t) => title.includes(t)) || hc.bodyMarkers.some((m) => body.includes(m)) || frames.some((h) => hc.frameHosts.some((x) => h === x || h.endsWith("." + x)))) {
    throw new BlockedError("human-check", `a human-check page was shown at ${safeUrl(page.url())}; cc does not try to get past it`);
  }
  if (!onHost(page.url(), spec.hosts)) throw new BlockedError("unexpected-page", `landed on ${safeUrl(page.url())}, which is not ${spec.hosts.join(" or ")}; stopped`);
  const p = (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })();
  if (/\/login|\/logout/.test(p) || (spec.signedOutMarkers.some((m) => body.includes(m)) && !(await page.$(spec.projectLink)) && !rx(spec.projectPath).test(p))) {
    throw new BlockedError("signed-out", "claude.ai is not signed in in this account's master profile; run `cc browser signin --account <id>` (cc does not sign in here)");
  }
}

/** The accessible name cc judges a control by. */
async function controlName(l: Locator): Promise<string> {
  return l.evaluate((el) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)).catch(() => "");
}

export type ClickRole = "create-project" | "create-submit" | "instructions-open" | "instructions-save";

/** The ONLY way this file clicks: right host, an allowed role, and a control name that is not on the deny list. */
export async function guardedClick(page: Page, l: Locator, role: ClickRole, spec: SettingsSpec): Promise<void> {
  if (!onHost(page.url(), spec.hosts)) throw new Error(`refusing to click (${role}): the page is ${safeUrl(page.url())}, not ${spec.hosts.join(" or ")}`);
  if ((await l.count()) === 0) throw new Error(`no control for ${role} on ${safeUrl(page.url())}; fix data/selectors/claude-settings.json`);
  const name = await controlName(l);
  if (CLICK_DENY.test(name)) throw new Error(`refusing to click "${name}" (${role}): CLAUDE.md rule 9 forbids that kind of control; fix data/selectors/claude-settings.json`);
  await l.evaluate((el) => (el as HTMLElement).click());
}

/** A button (or link-styled button) whose accessible name matches `pattern`, inside `scope`. */
const byName = (scope: Page | Locator, pattern: string) => scope.getByRole("button", { name: rx(pattern) }).or(scope.getByRole("link", { name: rx(pattern) })).first();

async function waitFor(cond: () => Promise<boolean>, ms: number, pollMs: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) { if (await cond()) return true; if (Date.now() > end) return false; await sleep(Math.max(500, pollMs)); }
}

/** One driver per page. Every method leaves the page on claude.ai; none deletes, renames or shares anything. */
export interface SettingsDriver {
  listProjects(): Promise<ProjectRef[]>;
  createProject(name: string): Promise<string>;
  /** Opens the project page and checks its heading is exactly `name`. */
  openProject(href: string, name: string): Promise<void>;
  readInstructions(): Promise<string>;
  writeInstructions(text: string): Promise<void>;
}

export function claudeSettingsDriver(page: Page, spec: SettingsSpec): SettingsDriver {
  const t = spec.timing;
  const goto = async (url: string) => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: t.pageMs }); await sleep(t.settleMs); await checkPage(page, spec); };
  const readLinks = () => page.$$eval(spec.projectLink, (as, nameSel) => as.map((a) => {
    const n = nameSel ? a.querySelector(nameSel) : null;
    // Icon-font glyphs (private use, e.g. the pin icon of a pinned project tile, U+E0C9) and zero-width characters are not text: strip them before judging a line (live finding, 3 Nov 2026).
    const clean = (s: string) => s.replace(/[\uE000-\uF8FF\u200B-\u200D\u2060\uFEFF]/g, "").trim();
    const lines = ((a as HTMLElement).innerText ?? a.textContent ?? "").split("\n").map(clean).filter(Boolean);
    const name = n ? clean((n as HTMLElement).innerText ?? "") : lines[0] ?? "";
    return { name, href: (a as HTMLAnchorElement).href, lines };
  }), spec.projectName);
  const dialog = () => page.locator(spec.instructionsDialog).last();
  const field = () => dialog().locator(spec.instructionsField).first();
  const readField = (l: Locator) => spec.instructionsFieldKind === "textarea" ? l.inputValue() : l.evaluate((el) => (el as HTMLElement).innerText);
  const openEditor = async () => {
    await guardedClick(page, byName(page.locator("body"), spec.instructionsOpen), "instructions-open", spec);
    if (!(await waitFor(async () => (await field().count()) > 0, t.elementMs, 500))) throw new Error(`the instructions editor did not open on ${safeUrl(page.url())}; fix data/selectors/claude-settings.json (instructionsOpen, instructionsDialog, instructionsField)`);
    await sleep(t.settleMs);
  };
  const closeEditor = async () => {
    await page.keyboard.press(spec.closeKey);
    if (!(await waitFor(async () => (await field().count()) === 0, t.elementMs, 500))) throw new Error("the instructions editor did not close; nothing was saved");
  };
  return {
    async listProjects() {
      await goto(spec.projectsUrl);
      await page.waitForSelector(spec.projectLink, { timeout: t.elementMs }).catch(() => {}); // an account with no projects has none
      let last = -1, stable = 0, links: ProjectRef[] = [];
      for (let i = 0; i < 40 && stable < t.listStableChecks; i++) {
        links = await readLinks();
        stable = links.length === last ? stable + 1 : 0;
        last = links.length;
        await sleep(Math.max(500, t.pollMs));
      }
      if (stable < t.listStableChecks) throw new Error(`the project list did not finish loading (${links.length} seen); refusing to decide on a partial list`);
      const seen = new Set<string>();
      return links.filter((l) => l.name && !seen.has(l.href) && seen.add(l.href)); // a pinned project is listed twice with the same href
    },
    async createProject(name) {
      if (spec.protectedProjects.includes(name)) throw new Error(`"${name}" is a protected project; cc never creates or touches it`);
      if (spec.createUrl) await goto(spec.createUrl);
      else { await goto(spec.projectsUrl); await guardedClick(page, byName(page.locator("body"), spec.createButton), "create-project", spec); }
      const dlg = page.locator(spec.createDialog).filter({ has: page.locator(spec.createNameField) }).last();
      const f = dlg.locator(spec.createNameField).first();
      if (!(await waitFor(async () => (await f.count()) > 0, t.elementMs, 500))) throw new Error(`no project-name field (${spec.createNameField}) in a create dialog on ${safeUrl(page.url())}; fix data/selectors/claude-settings.json (createButton, createDialog, createNameField)`);
      await domFill(f, name); // only the name: the description stays empty
      await guardedClick(page, byName(dlg, spec.createSubmit), "create-submit", spec);
      const opened = await waitFor(async () => { try { return rx(spec.projectPath).test(new URL(page.url()).pathname); } catch { return false; } }, t.pageMs, 500);
      if (!opened) throw new Error(`clicked create, but no project page opened (now at ${safeUrl(page.url())})`);
      await sleep(t.settleMs);
      await checkPage(page, spec);
      return page.url();
    },
    async openProject(href, name) {
      if (spec.protectedProjects.includes(name)) throw new Error(`"${name}" is a protected project; cc never opens or touches it`);
      if (!onHost(href, spec.hosts)) throw new Error(`refusing to open ${safeUrl(href)}: not ${spec.hosts.join(" or ")}`);
      await goto(href);
      if (!rx(spec.projectPath).test(new URL(page.url()).pathname)) throw new BlockedError("unexpected-page", `opened ${safeUrl(href)} but landed on ${safeUrl(page.url())}`);
      const h = page.locator(spec.projectHeading).first();
      await waitFor(async () => (await h.count()) > 0, t.elementMs, 500);
      const heading = ((await h.innerText().catch(() => "")) ?? "").trim();
      if (heading !== name) throw new Error(`the project page at ${safeUrl(href)} is headed "${heading.slice(0, 80)}", not "${name}"; not touching it`);
    },
    async readInstructions() {
      await openEditor();
      const text = await readField(field());
      await closeEditor();
      return text;
    },
    async writeInstructions(text) {
      await openEditor();
      const f = field();
      if (spec.instructionsFieldKind === "textarea") await domFill(f, text);
      else { await f.focus(); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.insertText(text); }
      await sleep(t.settleMs);
      await guardedClick(page, byName(dialog(), spec.instructionsSave), "instructions-save", spec);
      if (!(await waitFor(async () => (await field().count()) === 0, t.elementMs, 500))) throw new Error("clicked Save, but the instructions editor stayed open (not saved?)");
    },
  };
}
