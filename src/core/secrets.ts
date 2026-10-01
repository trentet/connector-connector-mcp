import fs from "node:fs";
import { Redactor } from "./redact.js";
import type { Source } from "./types.js";
import { getCredential } from "./vaultClient.js";

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  readFile: (p: string) => string | undefined; // undefined when missing
  vault: (label: string) => Promise<{ username?: string; password?: string } | undefined>;
}
export const defaultDeps: ResolveDeps = {
  env: process.env,
  readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined),
  vault: getCredential,
};

function parseEnvFile(text: string, key: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  }
  return undefined;
}

/** Resolve a Source to a string. `secret` marks the value for redaction (everything except literal). */
export async function resolve(src: Source, red: Redactor, deps: ResolveDeps = defaultDeps): Promise<string> {
  switch (src.type) {
    case "literal":
      return src.value;
    case "env": {
      const v = deps.env[src.name];
      if (!v) throw new Error(`env var ${src.name} is not set`);
      red.add(v);
      return v;
    }
    case "envFile": {
      for (const p of src.paths) {
        const t = deps.readFile(p);
        const v = t === undefined ? undefined : parseEnvFile(t, src.key);
        if (v) { red.add(v); return v; }
      }
      throw new Error(`key ${src.key} not found in any of ${src.paths.length} env file path(s)`);
    }
    case "fileRegex": {
      const t = deps.readFile(src.path);
      if (t === undefined) throw new Error(`file not found: ${src.path}`);
      const m = new RegExp(src.pattern).exec(t);
      const v = m?.[src.group ?? 0];
      if (!v) throw new Error(`pattern did not match in ${src.path}`);
      red.add(v);
      return v;
    }
    case "vault": {
      const c = await deps.vault(src.label);
      if (!c) throw new Error(`vault entry "${src.label}" not found`);
      const v = c[src.field ?? "password"];
      if (!v) throw new Error(`vault entry "${src.label}" has no ${src.field ?? "password"}`);
      red.add(v);
      return v;
    }
    case "template": {
      const vars: Record<string, string> = {};
      for (const [k, s] of Object.entries(src.variables)) vars[k] = await resolve(s, red, deps);
      const out = src.template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
        if (!(name in vars)) throw new Error(`template variable ${name} is not defined`);
        return vars[name];
      });
      red.add(out.length > 12 && /[?&](token|shell_secret)=/i.test(out) ? out : undefined);
      return out;
    }
  }
}
