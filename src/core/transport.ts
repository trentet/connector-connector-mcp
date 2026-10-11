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

const GATE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const GATE_MAX_BYTES = 64 * 1024;
const RENEWED_RECORD = "token.renewed.json";

/**
 * A forced-command ssh login (the NAS `helm-renew` gate) that allows exactly `put <container> <file>` (content on stdin, written atomically by the gate)
 * and `health <container>` (the body of the container's /health, then a last line `HTTP <code>`). Nothing can be read back and no command can run, so:
 * credentials.json and a mirror of every file cc delivered live in `gate.localDir` on this machine, and the last renewal time is the `renewedAt`
 * the health body echoes (the one fact only the server knows). A "permission denied" from the login means the gate needs repair: cc does not retry it.
 */
export class GateTransport implements Transport {
  readonly where: string;
  private readonly local: string;
  private readonly container: string;
  constructor(private readonly host: NonNullable<GoogleOAuthDef["host"]>, private readonly runner = run) {
    if (!host.gate) throw new Error("GateTransport needs host.gate");
    this.where = host.ssh;
    this.container = host.gate.container;
    this.local = expandEnv(host.gate.localDir);
  }
  private get opts(): string[] {
    return ["-i", expandEnv(this.host.keyFile), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", ...(this.host.port ? ["-p", String(this.host.port)] : [])];
  }
  join(dir: string, name: string): string { return `${dir.replace(/\/+$/, "")}/${name}`; }
  private nameOf(file: string): string { return path.posix.basename(file.replace(/\\/g, "/")); }
  private gate(command: string, input?: string, timeoutMs = 60_000): Promise<ExecResult> { return this.runner("ssh", [...this.opts, this.host.ssh, command], { timeoutMs, input }); }
  /** The body of the container's /health, or undefined when the gate or the container did not answer 2xx. */
  private async health(): Promise<string | undefined> {
    const r = await this.gate(`health ${this.container}`, undefined, 30_000);
    if (r.code !== 0) return undefined;
    const lines = r.stdout.replace(/\s+$/, "").split(/\r?\n/);
    const m = /^HTTP (\d{3})$/.exec(lines[lines.length - 1] ?? "");
    if (!m || m[1][0] !== "2") return undefined;
    const body = lines.slice(0, -1).join("\n");
    return body.trim() ? body : undefined;
  }
  async readFile(file: string): Promise<string | undefined> {
    const name = this.nameOf(file);
    if (name === RENEWED_RECORD) {
      const body = await this.health();
      if (body === undefined) return undefined;
      try { const at = (JSON.parse(body) as { renewedAt?: unknown }).renewedAt; return typeof at === "string" ? JSON.stringify({ renewedAt: at }) : undefined; } catch { return undefined; }
    }
    const f = path.join(this.local, name);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
  }
  async replaceFile(file: string, content: string): Promise<void> {
    const name = this.nameOf(file);
    if (!GATE_FILE.test(name)) throw new Error(`the gate does not accept the file name "${name}"`);
    if (Buffer.byteLength(content, "utf8") > GATE_MAX_BYTES) throw new Error(`${name} is over the gate's 64 KiB limit`);
    const r = await this.gate(`put ${this.container} ${name}`, content);
    if (r.code !== 0 || !/^ok\b/.test(r.stdout.trim())) {
      const denied = /permission denied/i.test(r.stderr);
      throw new Error(`the gate on ${this.where} did not accept ${name} (exit ${r.code}${denied ? ", permission denied: the login needs repair, tell the operator, do not retry" : ""})`);
    }
    fs.mkdirSync(this.local, { recursive: true });
    const tmp = path.join(this.local, `${name}.new`);
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, path.join(this.local, name));
  }
  async exec(): Promise<ExecResult> { throw new Error(`the login on ${this.where} is a gate: it allows only put and health, so no command can be run through it`); }
  /** The health URL in the registry is the container's own; the gate always asks its own container, so the URL is not used. */
  async fetchText(): Promise<string | undefined> { return this.health(); }
}

export function transportFor(def: GoogleOAuthDef): Transport {
  if (def.host?.gate) return new GateTransport(def.host);
  return def.host ? new SshTransport(def.host) : new LocalTransport();
}
