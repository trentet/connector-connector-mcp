// @reqs ACCT-C12
/**
 * ACCT-C12 (owner t124u, 2026-11-11): the sign-in method of a vault entry, settled when the entry is pulled for a
 * sign-in. Existing entries stay as they are; nothing is refused just because it predates the field.
 * - The entry's sign_in_method field set: that method is used (and the session is verified against it elsewhere).
 * - Not set: the site's available sign-in options are taken from its stored per-site record
 *   (`sign-in-options/<site>` in the vault), else detected (data/selectors/signin-options.json: a fixed list, or
 *   markers read on the site's own sign-in page). Exactly one option: it is written to the entry's sign_in_method with
 *   sign_in_method_source "auto: only option", and the sign-in goes on. Several: the list is stored in the per-site
 *   record and the sign-in is refused (ACCOUNT_NOT_AUTHORIZED: sign-in method must be chosen) with the options, until
 *   the owner sets the entry's sign_in_method to one of them. Detection that fails, reads nothing or reads a method
 *   that is not a known one is unknown, and refused. Nothing is ever guessed.
 */
import fs from "node:fs";
import { SIGN_IN_METHODS } from "./accountRegistry.js";

export const OPTIONS_PREFIX = "sign-in-options/";
export const METHOD_FIELD = "sign_in_method";
export const METHOD_SOURCE_FIELD = "sign_in_method_source";
export const AUTO_SOURCE = "auto: only option";

/** The per-site record of the sign-in options a site offers. */
export interface SiteOptions { site: string; options: string[]; detectedAt: string; source: string }

/** Where entries and site records are read and written (the vault through bw serve; a fake in tests). */
export interface SignInStore {
  /** The site's stored record, undefined when there is none; throws when it cannot be read or is ambiguous. */
  readSite(site: string): Promise<SiteOptions | undefined>;
  writeSite(rec: SiteOptions): Promise<void>;
  /** Sets sign_in_method and sign_in_method_source on exactly the entry labelled `label`. */
  writeEntryMethod(label: string, method: string, source: string): Promise<void>;
}

export type Detector = () => Promise<string[] | undefined>;

export interface Resolved { method: string; source: "entry" | "auto: only option"; written: boolean }

export interface ResolveErrors { refuse: (message: string) => Error; mismatch: (message: string) => Error }

const KNOWN = SIGN_IN_METHODS as readonly string[];
export const normSite = (s: string | undefined) => String(s ?? "").trim().toLowerCase().replace(/^www\./, "");
export const normMethod = (m: string | null | undefined) => String(m ?? "").trim().toLowerCase();

/** The options a detector reported: known, de-duplicated, in order; undefined when empty or when any is unknown. */
export function cleanOptions(found: readonly string[] | undefined): string[] | undefined {
  if (!found || found.length === 0) return undefined;
  const out: string[] = [];
  for (const f of found) {
    const m = normMethod(f);
    if (!KNOWN.includes(m)) return undefined;
    if (!out.includes(m)) out.push(m);
  }
  return out.length ? out : undefined;
}

/** The notes of a per-site record (no secret in it). */
export function siteNotes(r: SiteOptions): string {
  return `site=${normSite(r.site)}\noptions=${r.options.join(",")}\ndetected_at=${r.detectedAt}\nsource=${r.source}`;
}

/** A per-site record from its vault item; undefined when it is not a well-formed one. */
export function parseSite(name: string, notes: string | null | undefined): SiteOptions | undefined {
  const n = String(notes ?? "").replace(/\r\n/g, "\n");
  const get = (k: string) => new RegExp(`(?:^|\\n)${k}=([^\\n]*)`).exec(n)?.[1]?.trim();
  const site = normSite(get("site"));
  if (!site || normSite(name) !== OPTIONS_PREFIX + site) return undefined;
  const options = cleanOptions((get("options") ?? "").split(",").filter(Boolean));
  if (!options) return undefined;
  return { site, options, detectedAt: get("detected_at") ?? "", source: get("source") ?? "" };
}

/**
 * ACCT-C12: the sign-in method for vault entry `label` on `site`. `write: false` (a dry run) reports what would be
 * written without writing anything.
 */
export async function resolveSignInMethod(
  o: { label: string; site: string | undefined; entryMethod?: string | null; detect?: Detector; write?: boolean; now?: () => Date },
  d: ResolveErrors & { store: SignInStore },
): Promise<Resolved> {
  const set = normMethod(o.entryMethod);
  if (set) {
    if (!KNOWN.includes(set)) throw d.refuse(`vault entry "${o.label}" records an unknown sign-in method; it is not used`);
    return { method: set, source: "entry", written: false };
  }
  const site = normSite(o.site);
  if (!site) throw d.refuse(`vault entry "${o.label}" records no sign-in method, and the site it signs in to is unknown, so its sign-in options cannot be determined; refusing`);
  let rec: SiteOptions | undefined;
  try {
    rec = await d.store.readSite(site);
  } catch (e) {
    throw d.refuse(`vault entry "${o.label}" records no sign-in method, and the sign-in options stored for ${site} could not be read (${(e as Error).message}); refusing`);
  }
  let options = rec?.options;
  if (!options) {
    let found: string[] | undefined;
    try { found = o.detect ? await o.detect() : undefined; } catch { found = undefined; }
    options = cleanOptions(found);
    if (!options) throw d.refuse(`vault entry "${o.label}" records no sign-in method, and the sign-in options ${site} offers could not be determined; the method is unknown, refusing`);
  }
  const write = o.write !== false;
  if (options.length === 1) {
    const method = options[0]!;
    if (write) {
      try { await d.store.writeEntryMethod(o.label, method, AUTO_SOURCE); } catch (e) {
        throw d.refuse(`${site} offers only ${method}, but it could not be recorded on vault entry "${o.label}" (${(e as Error).message}); refusing`);
      }
    }
    return { method, source: AUTO_SOURCE, written: write };
  }
  if (!rec && write) {
    try { await d.store.writeSite({ site, options, detectedAt: (o.now ?? (() => new Date()))().toISOString(), source: "detected" }); } catch { /* the refusal below stands either way */ }
  }
  const err = d.refuse(`sign-in method must be chosen: vault entry "${o.label}" records none, and ${site} offers ${options.join(", ")}; the owner sets the entry's ${METHOD_FIELD} field to one of them`);
  (err as Error & { options?: string[] }).options = options;
  throw err;
}

/** One site's detector: a fixed option list, or markers (Playwright selectors) per method on its sign-in page. */
export interface SiteDetector { hosts?: string[]; page?: string; fixed?: string[]; markers?: Record<string, string[]>; liveVerified?: boolean; note?: string }
export interface SignInOptionsData { sites: Record<string, SiteDetector> }

/** A page as far as detection needs it. */
export interface DetectPage { url(): string; count(selector: string): Promise<number> }

/**
 * ACCT-C12: the options `site` offers: its fixed list, else the methods whose markers match on `page` (which must be
 * on one of the site's hosts). Undefined (unknown) when the site has no detector, the page is elsewhere, or nothing
 * matches.
 */
export async function detectSignInOptions(data: SignInOptionsData, site: string, page?: DetectPage): Promise<string[] | undefined> {
  const def = data.sites[normSite(site)];
  if (!def) return undefined;
  if (def.fixed?.length) return cleanOptions(def.fixed);
  if (!page || !def.markers) return undefined;
  let host: string;
  try { host = new URL(page.url()).hostname.toLowerCase(); } catch { return undefined; }
  const hosts = (def.hosts ?? [normSite(site)]).map((h) => h.toLowerCase());
  if (!hosts.some((h) => host === h || host.endsWith("." + h))) return undefined;
  const found: string[] = [];
  for (const [method, sels] of Object.entries(def.markers)) {
    for (const s of sels) {
      let n = 0;
      try { n = await page.count(s); } catch { return undefined; } // a marker that cannot be read: unknown
      if (n > 0) { found.push(method); break; }
    }
  }
  return cleanOptions(found);
}

/** Reads a sign-in options data file (sites: { "<site>": SiteDetector }). */
export function loadSignInOptions(file: string): SignInOptionsData {
  const j = JSON.parse(fs.readFileSync(file, "utf8")) as { sites?: Record<string, SiteDetector> };
  return { sites: j.sites ?? {} };
}
