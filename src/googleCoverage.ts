import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Registry } from "./core/types.js";

/**
 * Google-OAuth coverage guard. `cc reauth --all` renews only registry entries that carry a `googleOAuth` block, so a connector repo that
 * uses Google OAuth but has no block would silently expire every 7 days. This scans repos (local checkouts and/or a GitHub owner) for
 * Google OAuth usage and reports every one that no registry entry covers. Reads dependency manifests and a bounded set of source
 * files; prints only repo names, file paths and the NAMES of matched terms, never file content.
 */

export const TERMS: [string, RegExp][] = [
  ["googleapis", /googleapis/i], ["google-auth-library", /google-auth-library/i], ["python google auth", /google\.oauth2|google_auth|google-auth/i],
  ["Google.Apis (dotnet)", /Google\.Apis/], ["oauth2.googleapis.com", /oauth2\.googleapis\.com/i], ["accounts.google.com oauth", /accounts\.google\.com\/o\/oauth2/i],
  ["token.json", /token\.json/i], ["credentials.json", /credentials\.json/i], ["refresh_token", /refresh_token/i], ["GOOGLE_CLIENT", /GOOGLE_CLIENT/i], ["client_secret", /client_secret/i],
];
/** A Google client library in a dependency manifest is proof by itself. */
const DEP_TERMS = new Set(["googleapis", "google-auth-library", "python google auth", "Google.Apis (dotnet)"]);
const MANIFEST = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|go\.mod|pom\.xml|Gemfile|composer\.json|[\w.-]+\.csproj)$/i;
const SRC = /\.(js|mjs|cjs|ts|py|cs|ps1|go|java)$/i;
const INTEREST = /google|oauth|auth|drive|token|credential|gmail|calendar|sheets|docs/i;
const SKIP = /(^|[\\/])(node_modules|dist|build|\.git|vendor|bin|obj|\.next|coverage|browser-profile|logs)([\\/]|$)/i;
const MAX_SRC_FILES = 80, MAX_SRC_BYTES = 300_000;

export interface Finding { repo: string; manifestTerms: string[]; sourceTerms: string[]; files: string[] }
export type Verdict = "uses-google" | "maybe" | "none";

export function verdict(f: Pick<Finding, "manifestTerms" | "sourceTerms">): Verdict {
  if (f.manifestTerms.some((t) => DEP_TERMS.has(t))) return "uses-google";
  const s = new Set(f.sourceTerms);
  if (s.has("token.json") && s.has("credentials.json") && (s.has("refresh_token") || s.has("oauth2.googleapis.com") || s.has("accounts.google.com oauth"))) return "uses-google";
  if (s.size > 0) return "maybe"; // only generic OAuth words (refresh_token, client_secret ...): a person has to look
  return "none";
}

const termsIn = (text: string) => TERMS.filter(([, rx]) => rx.test(text)).map(([n]) => n);

/** Read access abstracted so the same logic serves local checkouts and GitHub (and tests). */
interface Source { files: { p: string; size: number }[]; read(p: string): string | undefined }

function analyse(repo: string, src: Source): Finding {
  const files = src.files.filter((f) => !SKIP.test(f.p));
  const manifestTerms = new Set<string>(), sourceTerms = new Set<string>(), hit: string[] = [];
  for (const f of files.filter((f) => MANIFEST.test(f.p) && f.size < 400_000)) {
    const t = termsIn(src.read(f.p) ?? ""); if (t.length) { t.forEach((x) => manifestTerms.add(x)); hit.push(f.p); }
  }
  for (const f of files.filter((f) => SRC.test(f.p) && INTEREST.test(f.p) && f.size < MAX_SRC_BYTES).slice(0, MAX_SRC_FILES)) {
    const t = termsIn(src.read(f.p) ?? ""); if (t.length) { t.forEach((x) => sourceTerms.add(x)); hit.push(f.p); }
  }
  return { repo, manifestTerms: [...manifestTerms], sourceTerms: [...sourceTerms], files: [...new Set(hit)] };
}

/** "owner/name" from a git origin URL (https or ssh form, with or without .git). */
export function repoFromOrigin(url: string): string | undefined {
  const m = /github[^:/]*[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Find git checkouts under `roots` (a root that is itself a checkout counts) and analyse each. */
export function scanLocal(roots: string[]): Finding[] {
  const out: Finding[] = [];
  const checkout = (dir: string): void => {
    let name = path.basename(dir);
    try { const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8"); const u = /url\s*=\s*(.+)/.exec(cfg)?.[1]; name = (u && repoFromOrigin(u)) || name; } catch { /* a worktree/file .git or no remote: fall back to the folder name */ }
    const files: { p: string; size: number }[] = [];
    const walk = (d: string, rel: string): void => {
      let es: fs.Dirent[]; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (SKIP.test(r + "/")) continue;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else if (e.isFile()) { try { files.push({ p: r, size: fs.statSync(path.join(d, e.name)).size }); } catch { /* unreadable */ } }
      }
    };
    walk(dir, "");
    out.push(analyse(name, { files, read: (p) => { try { return fs.readFileSync(path.join(dir, p), "utf8"); } catch { return undefined; } } }));
  };
  const find = (dir: string, depth: number): void => {
    if (fs.existsSync(path.join(dir, ".git"))) { checkout(dir); return; }
    if (depth <= 0) return;
    let es: fs.Dirent[]; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) if (e.isDirectory() && !SKIP.test(e.name + "/")) find(path.join(dir, e.name), depth - 1);
  };
  for (const r of roots) find(path.resolve(r), 4);
  return out;
}

export type GhRun = (args: string[]) => { ok: boolean; out: string };
export const realGh: GhRun = (args) => { const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return { ok: r.status === 0, out: r.stdout ?? "" }; };

/** Every non-archived repo of a GitHub owner (needs an authenticated `gh`). Reads files through the API; clones nothing. */
export function scanGithub(owner: string, gh: GhRun = realGh): { findings: Finding[]; errors: string[] } {
  const errors: string[] = [], findings: Finding[] = [];
  const list = gh(["repo", "list", owner, "--limit", "200", "--json", "name,isArchived"]);
  if (!list.ok) return { findings, errors: [`could not list ${owner}'s repos with gh (is gh installed and signed in?)`] };
  for (const r of JSON.parse(list.out) as { name: string; isArchived: boolean }[]) {
    if (r.isArchived) continue;
    const tree = gh(["api", `repos/${owner}/${r.name}/git/trees/HEAD?recursive=1`, "--jq", '.tree[] | select(.type=="blob") | [.path, .size] | @tsv']);
    if (!tree.ok) { errors.push(`${owner}/${r.name}: tree unreadable (empty repo?)`); continue; }
    const files = tree.out.split("\n").filter(Boolean).map((l) => { const [p, s] = l.split("\t"); return { p, size: Number(s) }; });
    findings.push(analyse(`${owner}/${r.name}`, { files, read: (p) => { const c = gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${owner}/${r.name}/contents/${p.split("/").map(encodeURIComponent).join("/")}`]); return c.ok ? c.out : undefined; } }));
  }
  return { findings, errors };
}

export interface CoverageReport {
  covered: { repo: string; connectors: string[] }[];
  uncovered: Finding[];
  pending: { repo: string; reason: string }[];
  exempt: { repo: string; reason: string }[];
  review: Finding[];
  problems: string[];
  /** Informational, never failing. */
  notes: string[];
}

const norm = (r: string) => r.toLowerCase();
/** Match by full name when both sides have an owner, else by the bare repo name (a local folder without a usable remote). */
const same = (a: string, b: string) => norm(a) === norm(b) || (!a.includes("/") || !b.includes("/")) && norm(a.split("/").pop()!) === norm(b.split("/").pop()!);

export function coverage(findings: Finding[], reg: Registry): CoverageReport {
  const rep: CoverageReport = { covered: [], uncovered: [], pending: [], exempt: [], review: [], problems: [], notes: [] };
  const entries = reg.connectors.filter((c) => c.googleOAuth);
  for (const c of entries) if (!c.repo) rep.problems.push(`registry entry ${c.id} has a googleOAuth block but no "repo": the guard cannot match it to a repo`);
  const ex = reg.googleOAuthExemptions ?? [];
  for (const f of findings) {
    const v = verdict(f);
    if (v === "none") continue;
    const ids = entries.filter((c) => c.repo && same(c.repo, f.repo)).map((c) => c.id);
    if (ids.length) { rep.covered.push({ repo: f.repo, connectors: ids }); continue; }
    const x = ex.find((e) => same(e.repo, f.repo));
    if (x) { (x.kind === "pending" ? rep.pending : rep.exempt).push({ repo: x.repo, reason: x.reason }); continue; }
    (v === "uses-google" ? rep.uncovered : rep.review).push(f);
  }
  for (const x of ex) {
    if (rep.covered.some((c) => same(c.repo, x.repo))) rep.problems.push(`exemption for ${x.repo} is stale: a registry entry now covers it, remove the exemption`);
    else if (!findings.some((f) => same(f.repo, x.repo) && verdict(f) !== "none")) rep.notes.push(`exemption for ${x.repo} matched nothing in this scan: it may be stale (or that repo was not scanned)`);
  }
  return rep;
}

export function formatReport(rep: CoverageReport): string[] {
  const L: string[] = [];
  for (const c of rep.covered) L.push(`covered    ${c.repo}  (registry: ${c.connectors.join(", ")})`);
  for (const x of rep.exempt) L.push(`exempt     ${x.repo}  - ${x.reason}`);
  for (const x of rep.pending) L.push(`PENDING    ${x.repo}  - ${x.reason}`);
  for (const f of rep.review) L.push(`review     ${f.repo}  - only generic OAuth words (${f.sourceTerms.join(", ")}); decide: add a googleOAuth block or an exemption`);
  for (const f of rep.uncovered) L.push(`UNCOVERED  ${f.repo}  - uses Google OAuth (${[...f.manifestTerms, ...f.sourceTerms].filter((t, i, a) => a.indexOf(t) === i).join(", ")}; e.g. ${f.files.slice(0, 2).join(", ")}) but no registry entry has a googleOAuth block for it`);
  for (const p of rep.problems) L.push(`problem    ${p}`);
  for (const n of rep.notes) L.push(`note       ${n}`);
  return L;
}
