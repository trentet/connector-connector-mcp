// @reqs REQ-D017
/**
 * Grok's Connected list and a connector's detail, read from the page as it is (REQ-D017, extends the list read of pull
 * request 100). The settings dialog shows a few custom rows and a chip "N connected"; the chip opens the Manage view,
 * whose offer-all button lists every connected app. A connected row's detail lists one button per tool. Every pattern
 * is data (data/selectors/grok.json). The page* functions run inside the browser through page.evaluate, so they use
 * nothing from outside their own body; tests call them against a stand-in document.
 */
import type { Page } from "patchright";
import type { AdapterOutcome } from "./types.js";

export interface GrokListSelectors {
  list: { rowMarkerText: string; connectedChip: string; showAll: string };
  detail: { toolsLine: string; seeMore: string; toolsEnd: string; toolName: string };
  remove: { disconnectButton: string };
}
/** One button of the page: its own text lines, and the text lines of its wrapper (up to two levels up, while the wrapper holds that one button), where the status word sits. */
export interface RawRow { own: string[]; wrap: string[] }

/** The pause between reads; tests replace it. */
export const timing = { sleep: (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms)) };
/** AC3, AC7, AC9: reads 500 ms apart; the list within 30 s, a detail within 10 s. */
export const POLL_MS = 500, LIST_MAX_MS = 30_000, DETAIL_MAX_MS = 10_000;
const rx = (p: string) => new RegExp(p, "i");

/** AC1: the name is the first text line, or the second when the first is a one-character avatar letter. */
export const rowName = (own: string[]): string | undefined => (own[0] && own[0].length === 1 && own.length > 1 ? own[1] : own[0]);
/** AC1: names of the rows whose wrapper carries the status word (list.rowMarkerText); rows that say Connect are not connected. */
export function namesFromRows(rows: RawRow[], marker: string): string[] {
  const names = new Set<string>();
  for (const r of rows) { if (!r.wrap.includes(marker)) continue; const n = rowName(r.own); if (n) names.add(n); }
  return [...names];
}
/** AC3: the number in the chip ("18 connected") or in the offer-all button. */
export const parseConnectedCount = (text: string | null | undefined): number | undefined => { const m = /\d+/.exec(text ?? ""); return m ? Number(m[0]) : undefined; };

/** In the page (AC1): every button with text, with its own lines and its one-button wrapper's lines. */
export function pageRows(): RawRow[] {
  const lines = (e: Element | null) => ((e as HTMLElement | null)?.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const rows: RawRow[] = [];
  for (const b of [...document.querySelectorAll("button")]) {
    const own = lines(b);
    if (!own.length) continue;
    const wrap: string[] = [];
    for (let w: Element | null = b.parentElement, up = 0; w && up < 2; w = w.parentElement, up++) {
      if (w.querySelectorAll("button").length !== 1) break; // the wrapper holds several rows: too far up
      wrap.push(...lines(w));
    }
    rows.push({ own, wrap });
  }
  return rows;
}

/** In the page (AC6): presses the one visible dialog row whose name (AC1) is exactly `name`; nothing else. */
export function pageOpenRow(name: string): boolean {
  for (const b of [...document.querySelectorAll("[role=dialog] button")] as HTMLElement[]) {
    if (!b.offsetWidth) continue;
    const own = (b.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const n = own[0] && own[0].length === 1 && own.length > 1 ? own[1] : own[0];
    if (n === name) { b.click(); return true; }
  }
  return false;
}

/** In the page (AC8): the text lines of the last visible dialog; a line holding :// or token= never leaves the page. */
export function pageDetailLines(): string[] {
  const shown = ([...document.querySelectorAll("[role=dialog]")] as HTMLElement[]).filter((d) => d.offsetWidth);
  const d = shown[shown.length - 1];
  if (!d) return [];
  return (d.innerText ?? "").split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/:\/\/|token=/i.test(l));
}

/** In the page (AC6): presses the first visible dialog button whose whole text matches `pattern`; false when there is none. */
export function pagePressButton(pattern: string): boolean {
  const re = new RegExp(pattern, "i");
  for (const b of [...document.querySelectorAll("[role=dialog] button")] as HTMLElement[]) {
    if (b.offsetWidth && re.test((b.innerText ?? "").trim().replace(/\s+/g, " "))) { b.click(); return true; }
  }
  return false;
}

/**
 * AC2, AC3: presses the chip once and the offer-all button once when each is there (nothing else), then reads the rows
 * until the names are the same in consecutive reads and at least N (500 ms apart, at most 30 s): an empty or partial list
 * is an error, never a fact.
 */
export async function revealAndReadConnected(page: Page, sel: GrokListSelectors): Promise<string[]> {
  let expected: number | undefined;
  const chip = page.locator("[role=dialog] button, [role=dialog] [role=button], [role=dialog] a").filter({ hasText: rx(sel.list.connectedChip) }).first();
  if (await chip.count()) { expected = parseConnectedCount(await chip.innerText()); await chip.click(); await timing.sleep(5 * POLL_MS); }
  const all = page.getByRole("button", { name: rx(sel.list.showAll) }).first();
  if (await all.count()) { expected ??= parseConnectedCount(await all.innerText()); await all.click(); await timing.sleep(5 * POLL_MS); }
  let names: string[] = [], stable = 0, last = "";
  for (let i = 0; i < LIST_MAX_MS / POLL_MS && stable < 2; i++) {
    await timing.sleep(POLL_MS);
    names = namesFromRows(await page.evaluate(pageRows), sel.list.rowMarkerText);
    const key = names.slice().sort().join("|");
    stable = names.length > 0 && names.length >= (expected ?? 0) && key === last ? stable + 1 : 0;
    last = key;
  }
  if (stable < 2) throw new Error(`grok.com's Connected list did not finish loading (${names.length} rows seen${expected ? `, ${expected} announced` : ""}); refusing to report a partial or empty list`);
  return names;
}

/**
 * AC6, AC7: the tool names of `name`'s open detail: the lines after the tools line up to the end of the tool list, that look
 * like a tool name. The detail counts as open only when the name and Disconnect come before the tools line.
 */
export function toolsFromDetail(lines: string[], name: string, sel: GrokListSelectors): string[] {
  const head = lines.findIndex((l) => rx(sel.detail.toolsLine).test(l));
  const iName = lines.indexOf(name);
  const iDisc = lines.findIndex((l) => rx(sel.remove.disconnectButton).test(l));
  if (head < 0 || iName < 0 || iDisc < 0 || iName > head || iDisc > head) throw new Error(`the detail of "${name}" is not open (no name, Disconnect or tools line)`);
  const rest = lines.slice(head + 1);
  const end = rest.findIndex((l) => rx(sel.detail.toolsEnd).test(l));
  return [...new Set((end < 0 ? rest : rest.slice(0, end)).filter((l) => rx(sel.detail.toolName).test(l)))];
}

/**
 * AC6, AC7: opens only `name`'s row, presses the expand button once when it is there, and returns the tools once two
 * reads agree (500 ms apart, at most 10 s). Never presses a tool, a toggle, Disconnect or Manage.
 */
export async function readDetailTools(page: Page, name: string, sel: GrokListSelectors): Promise<string[]> {
  if (!(await page.evaluate(pageOpenRow, name))) throw new Error(`no row named "${name}" to open in grok.com's Connected list`);
  let tools: string[] = [], last = "", problem = "", expanded = false;
  for (let i = 0; i < DETAIL_MAX_MS / POLL_MS; i++) {
    await timing.sleep(POLL_MS);
    try { tools = toolsFromDetail(await page.evaluate(pageDetailLines), name, sel); problem = ""; } catch (e) { problem = (e as Error).message; last = ""; continue; }
    if (!expanded) { expanded = true; if (await page.evaluate(pagePressButton, sel.detail.seeMore)) { last = ""; continue; } }
    const key = tools.join("|");
    if (tools.length > 0 && key === last) return tools;
    last = key;
  }
  if (problem) throw new Error(`${problem} within ${DETAIL_MAX_MS / 1000} s`);
  if (!tools.length) throw new Error(`grok.com lists no tool for "${name}"`);
  throw new Error(`the tools of "${name}" did not settle within ${DETAIL_MAX_MS / 1000} s`);
}

/** AC5, AC7, AC8: ok only when `name` is in the whole Connected list and its detail lists its tools; the outcome carries names and tool names only. */
export async function verifyConnected(page: Page, name: string, sel: GrokListSelectors): Promise<AdapterOutcome> {
  const names = await revealAndReadConnected(page, sel);
  const where = `grok.com's Connected list (${names.length} connected apps read)`;
  if (!names.includes(name)) return { status: "error", detail: `"${name}" is not in ${where}` };
  try {
    const tools = await readDetailTools(page, name, sel);
    return { status: "ok", detail: `"${name}" is in ${where}; Grok lists ${tools.length} tools for it: ${tools.join(", ")}` };
  } catch (e) {
    return { status: "error", detail: `"${name}" is in ${where}, but its tools could not be read: ${(e as Error).message}` };
  }
}