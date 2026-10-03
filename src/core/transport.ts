import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GoogleOAuthDef } from "./types.js";

/**
 * Where a connector's secrets live and how to reach them: this machine, or another one over ssh/scp. `cc reauth` only needs five
 * things from a host - read a file, replace a file atomically, run a command, fetch a health URL, and join a path - so that is all this exposes.
 * Nothing here ever prints file contents or command output beyond what the caller asks for; callers redact before logging.
 */
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface Transport {
  /** "this machine" or "user@host" - for log lines. */
  readonly where: string;
  join(dir: string, name: string): string;
  /** File contents, or undefined when the file does not exist. */
  readFile(file: string): Promise<string | undefined>;
  /** Replace `file` with `content` without ever leaving a half-written file at `file` (write beside it, then move over). */
  replaceFile(file: string, content: string): Promise<void>;
  exec(command: string, timeoutMs?: number): Promise<ExecResult>;
  /** GET a URL as seen from that host (a connector's health URL is usually 127.0.0.1-only). Returns body text, or undefined if it did not answer. */
  fetchText(url: string): Promise<string | undefined>;
}

/** `%NAME%` -> process.env.NAME (this machine only; unknown names are left as written so the failure is visible). */
export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => env[n] ?? m);
}

const run = (file: string, args: string[], opts: { shell?: boolean; timeoutMs?: number; input?: string } = {}): Promise<ExecResult> =>
  new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const child = spawn(file, args, { shell: opts.shell ?? false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (r: ExecResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ code: -1, stdout, stderr: stderr + "\n(timed out)" }); }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => finish({ code: -1, stdout, stderr: String(e.message) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });

export class LocalTransport implements Transport {
  readonly where = "this machine";
  join(dir: string, name: string): string { return path.join(dir, name); }
  async readFile(file: string): Promise<string | undefined> { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined; }
  async replaceFile(file: string, content: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.new`;
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file); // atomic replace on the same volume
  }
  exec(command: string, timeoutMs?: number): Promise<ExecResult> { return run(command, [], { shell: true, timeoutMs }); }
  async fetchText(url: string): Promise<string | undefined> {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.text() : undefined; } catch { return undefined; }
  }
}

/** ssh/scp with a key file, never a password, never a prompt (BatchMode). The remote shell is cmd.exe on Windows and sh elsewhere. */
export class SshTransport implements Transport {
  readonly where: string;
  private readonly os: "windows" | "posix";
  constructor(private readonly host: NonNullable<GoogleOAuthDef["host"]>, private readonly runner = run) {
    this.where = host.ssh;
    this.os = host.os ?? "windows";
  }
  private get opts(): string[] {
    return ["-i", expandEnv(this.host.keyFile), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", ...(this.host.port ? ["-p", String(this.host.port)] : [])];
  }
  private get scpOpts(): string[] {
    return ["-i", expandEnv(this.host.keyFile), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", ...(this.host.port ? ["-P", String(this.host.port)] : [])];
  }
  join(dir: string, name: string): string { return this.os === "windows" ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : `${dir.replace(/\/+$/, "")}/${name}`; }
  /** scp wants forward slashes even for Windows paths. */
  private scpPath(p: string): string { return p.replace(/\\/g, "/"); }
  /** Quote only what needs it: plain paths and URLs go through ssh and the remote shell untouched. */
  private q(p: string): string {
    if (/^[\w:\\/.@%+=,-]+$/.test(p)) return p;
    return this.os === "windows" ? `"${p.replace(/"/g, "")}"` : `'${p.replace(/'/g, `'\\''`)}'`;
  }
  exec(command: string, timeoutMs?: number): Promise<ExecResult> { return this.runner("ssh", [...this.opts, this.host.ssh, command], { timeoutMs }); }
  async readFile(file: string): Promise<string | undefined> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fetch-"));
    const local = path.join(dir, "f");
    try {
      const r = await this.runner("scp", [...this.scpOpts, `${this.host.ssh}:${this.scpPath(file)}`, local], { timeoutMs: 60_000 });
      return r.code === 0 && fs.existsSync(local) ? fs.readFileSync(local, "utf8") : undefined;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  async replaceFile(file: string, content: string): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-put-"));
    const local = path.join(dir, "f");
    try {
      fs.writeFileSync(local, content, { encoding: "utf8", mode: 0o600 });
      const staged = `${file}.new`;
      const up = await this.runner("scp", [...this.scpOpts, local, `${this.host.ssh}:${this.scpPath(staged)}`], { timeoutMs: 60_000 });
      if (up.code !== 0) throw new Error(`could not upload to ${this.where} (scp exit ${up.code})`);
      const mv = await this.exec(this.os === "windows" ? `move /Y ${this.q(staged)} ${this.q(file)}` : `mv -f ${this.q(staged)} ${this.q(file)}`, 60_000);
      if (mv.code !== 0) throw new Error(`could not move the uploaded file into place on ${this.where} (exit ${mv.code})`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  async fetchText(url: string): Promise<string | undefined> {
    const r = await this.exec(`${this.os === "windows" ? "curl.exe" : "curl"} -s -m 6 ${this.q(url)}`, 30_000);
    return r.code === 0 && r.stdout.trim() ? r.stdout : undefined;
  }
}

export function transportFor(def: GoogleOAuthDef): Transport {
  return def.host ? new SshTransport(def.host) : new LocalTransport();
}
