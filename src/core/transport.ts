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

const GATE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const GATE_MAX_BYTES = 64 * 1024;
const RENEWED_RECORD = "token.renewed.json"; // = RENEWED_FILE in reauth.ts (not imported: reauth.ts imports this file)

/**
 * A NAS login whose ssh key is bound to a forced command ("the gate") that allows exactly two requests: `put <container> <file>` (content on stdin, up to 64 KiB,
 * written under a temporary name and renamed in one step; answers `ok <bytes>`) and `health <container>` (answers the /health body, then a last line `HTTP <code>`).
 * Anything else is refused by the gate (exit 3); this class never even sends it. There is no read: `credentials.json` is read from a local file, and the files cc itself
 * delivered are mirrored locally (mode 0600) so the previous token and renewal record can be put back, and `--only-if-older-than` has a record to read.
 * The mirror is per machine and used only to put the previous token back; the last renewal time is read from the health body's `renewedAt`, so both renewers share it.
 */
export class GateTransport implements Transport {
  readonly where: string;
  readonly container: string;
  private readonly mirror: string;
  constructor(private readonly def: GoogleOAuthDef, private readonly runner = run, mirrorRoot = process.env.CC_GATE_MIRROR ?? path.join(os.homedir(), ".cc", "gate-mirror")) {
    const host = def.host!;
    this.where = host.ssh;
    this.container = def.secretsDir.replace(/\/+$/, "").split("/").pop() ?? "";
    if (!GATE_NAME.test(this.container)) throw new Error(`gate transport: "${def.secretsDir}" does not end in a container folder name`);
    this.mirror = path.join(mirrorRoot, this.container);
  }
  private get opts(): string[] {
    const h = this.def.host!;
    return ["-i", expandEnv(h.keyFile), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=15", ...(h.port ? ["-p", String(h.port)] : [])];
  }
  join(dir: string, name: string): string { return `${dir.replace(/\/+$/, "")}/${name}`; }
  private nameOf(file: string): string {
    const n = file.split(/[\\/]/).pop() ?? "";
    if (!GATE_NAME.test(n)) throw new Error(`the gate accepts only plain file names (letters, digits, dot, dash, underscore), not "${n}"`);
    return n;
  }
  /** One request to the gate. Only `put` and `health` can be built here. */
  private async gate(verb: "put" | "health", args: string[], input?: string, timeoutMs = 60_000): Promise<ExecResult> {
    const r = await this.runner("ssh", [...this.opts, this.where, [verb, this.container, ...args].join(" ")], { timeoutMs, input });
    if (/permission denied/i.test(r.stderr)) throw new Error(`the gate login on ${this.where} refused the key (permission denied): tell the operator, do not retry (it can also mean the NAS restarted less than two minutes ago)`);
    if (r.code === 3) throw new Error(`the gate on ${this.where} refused the request (exit 3)`);
    return r;
  }
  async readFile(file: string): Promise<string | undefined> {
    const n = this.nameOf(file);
    if (n === "credentials.json") {
      const f = expandEnv(this.def.host!.credentialsFile ?? "");
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
    }
    // The renewal record is the SERVER's fact: the health body echoes the renewedAt of the record it loaded, so every renewer sees the same time (a per-machine mirror would
    // never show the other renewer's renewal). No answer, or no renewedAt in it, reads as "no record" and the caller renews (the safe direction).
    if (n === RENEWED_RECORD) {
      const body = await this.fetchText("");
      if (body === undefined) return undefined;
      try { const at = (JSON.parse(body) as { renewedAt?: unknown }).renewedAt; return typeof at === "string" ? JSON.stringify({ renewedAt: at }) : undefined; } catch { return undefined; }
    }
    const m = path.join(this.mirror, n); // only what this machine delivered itself: the previous token, put back when a new one fails
    return fs.existsSync(m) ? fs.readFileSync(m, "utf8") : undefined;
  }
  async replaceFile(file: string, content: string): Promise<void> {
    const n = this.nameOf(file);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes === 0 || bytes > GATE_MAX_BYTES) throw new Error(`the gate accepts 1 to ${GATE_MAX_BYTES} bytes, not ${bytes}`);
    const r = await this.gate("put", [n], content);
    if (r.code !== 0 || r.stdout.trim() !== `ok ${bytes}`) throw new Error(`could not put ${n} through the gate on ${this.where} (exit ${r.code}${r.stdout.trim() ? `, answer "${r.stdout.trim().slice(0, 40)}"` : ""})`);
    fs.mkdirSync(this.mirror, { recursive: true, mode: 0o700 });
    const m = path.join(this.mirror, n);
    fs.writeFileSync(`${m}.new`, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(`${m}.new`, m);
  }
  /** The gate runs no commands. */
  async exec(command: string): Promise<ExecResult> { return { code: 3, stdout: "", stderr: `refused: the gate allows only put and health, not "${command.split(/\s/)[0]}"` }; }
  /** `health <container>`: the gate knows the port; the URL in the registry is not sent. A non-2xx answer counts as no answer. */
  async fetchText(_url: string): Promise<string | undefined> {
    const r = await this.gate("health", [], undefined, 30_000);
    if (r.code !== 0) return undefined;
    const lines = r.stdout.replace(/\s+$/, "").split(/\r?\n/);
    const m = /^HTTP (\d{3})$/.exec(lines.pop() ?? "");
    const body = lines.join("\n");
    return m && m[1].startsWith("2") && body.trim() ? body : undefined;
  }
}

export function transportFor(def: GoogleOAuthDef): Transport {
  if (def.host?.transport === "gate") return new GateTransport(def);
  return def.host ? new SshTransport(def.host) : new LocalTransport();
}
