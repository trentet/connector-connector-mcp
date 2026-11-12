import type { ResolveDeps } from "../src/core/secrets.js";
import type { Registry, Source } from "../src/core/types.js";
import { loadAccounts } from "../src/core/accounts.js";

/** ACCT-C05: runs name their account, and a fake session "is signed in as" that account's email. */
export const MAIN_EMAIL = loadAccounts().accounts.find((a) => a.id === "main")?.email;
export const signedInAsMain = async (): Promise<string | undefined> => MAIN_EMAIL;

/** Every Source object reachable from the registry (url, urlByPlatform, auth.headerValue, template variables). */
function sourcesOf(node: unknown, out: Source[] = []): Source[] {
  if (Array.isArray(node)) node.forEach((n) => sourcesOf(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.type === "string" && ["literal", "env", "envFile", "fileRegex", "vault", "template"].includes(o.type)) out.push(o as unknown as Source);
    for (const v of Object.values(o)) sourcesOf(v, out);
  }
  return out;
}

/** Text a fileRegex pattern will match: its literal prefix (regex escapes removed) up to the first character class, plus a fake value. */
function synthesize(pattern: string, fake: string): string {
  const literal = pattern.replace(/\[.*$/, "").replace(/\\(.)/g, "$1");
  return `${literal}${fake}`;
}

/**
 * Fake secret store derived entirely from the registry, so a registry-only change never needs a test edit.
 * Every envFile key, env var and fileRegex file the registry references gets a unique fake value; `secrets` lists them
 * all for the no-leak assertions.
 */
export function registryFixture(reg: Registry): { deps: ResolveDeps; secrets: string[] } {
  const srcs = sourcesOf(reg.connectors);
  const env: Record<string, string> = {};
  const files: Record<string, string> = {};
  const secrets: string[] = [];
  const fake = (label: string) => { const v = `fake-${label}-${secrets.length}-Zq9x4Tt`; secrets.push(v); return v; };
  const envFiles = new Map<string, Record<string, string>>(); // one fake file per distinct path list
  for (const s of srcs) {
    if (s.type === "env") env[s.name] ??= fake(s.name);
    else if (s.type === "envFile") {
      for (const p of s.paths) {
        const f = envFiles.get(p) ?? {};
        f[s.key] ??= fake(s.key);
        envFiles.set(p, f);
      }
    } else if (s.type === "fileRegex") {
      const v = fake("file");
      files[s.path] = `# fixture\n${synthesize(s.pattern, v)}\n`;
      if (!new RegExp(s.pattern).test(files[s.path])) throw new Error(`fixture cannot synthesize a match for pattern ${s.pattern}`);
    }
  }
  for (const [p, kv] of envFiles) files[p] = Object.entries(kv).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n";
  const vaultSecret = "pw-FIXTURE-vault-9999";
  secrets.push(vaultSecret);
  return {
    secrets,
    deps: {
      env,
      readFile: (p) => files[p],
      vault: async () => ({ username: "u@example.com", password: vaultSecret }),
    },
  };
}

/** Number of (production connector x enabled platform) pairs a "*" run over `platforms` covers; the rest are skipped. */
export function expectedCounts(reg: Registry, platforms: string[], includeTest = false) {
  const cs = reg.connectors.filter((c) => includeTest || c.tier !== "test");
  const planned = cs.flatMap((c) => platforms.map((p) => ({ enabled: (c.platforms as string[]).includes(p) })));
  return { dry: planned.filter((x) => x.enabled).length, skipped: planned.filter((x) => !x.enabled).length };
}
