#!/usr/bin/env node
// check-hidden-launch.mjs: engineering standard E13 (helm-engineering-standards #4, helm-host-kit #14).
//
// Principle: a process started for unattended work (a scheduled task, a watchdog, a restart helper)
// starts hidden: no window, no taskbar entry, no focus taken. The only exception is a process that
// needs the screen; it says why with "foreground: <reason>" on its launcher line or the lines just
// above it, or with "foreground-file: <reason>" anywhere in a file that is run by hand.
//
// What it refuses, per file kind (zero dependencies, reads text only, changes nothing):
//   task-console          a scheduled task (New-ScheduledTaskAction, schtasks /create /TR, task XML)
//                         that starts anything but wscript.exe in the logged-on session. A console
//                         program started by the scheduler gets a window before it can hide itself,
//                         so "powershell.exe -WindowStyle Hidden" still flashes. A task that runs
//                         without a desktop (S4U, password, SYSTEM) cannot show a window and passes.
//   start-process-visible Start-Process with WindowStyle Normal, Minimized or Maximized, or with none
//                         of -WindowStyle Hidden, -NoNewWindow, -RedirectStandard* (it opens a window).
//   vbs-run-visible       WScript.Shell .Run with a window style other than 0, or .Exec.
//   batch-start-visible   "start" in a .bat or .cmd file without /b.
//   cmd-start-visible     "cmd /c start" from any language, without /b.
//   node-detached-visible a Node child started with detached: true and without windowsHide: true.
//
// Usage: node check-hidden-launch.mjs [path ...] [--json] [--pinned <sha256 file>]
// Exit codes: 0 nothing refused; 1 something refused (listed); 2 the check itself failed, or a pinned copy drifted.
// Paths listed one per line in .hidden-launch-ignore at a scanned root are skipped (prefix match).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const KINDS = {
  '.ps1': 'ps', '.psm1': 'ps',
  '.bat': 'bat', '.cmd': 'bat',
  '.vbs': 'vbs',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.mts': 'js', '.cts': 'js',
  '.xml': 'xml',
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const DECLARATION_REACH = 3; // lines above a launcher that a "foreground:" note may sit on
const PLACEHOLDERS = new Set(['', 'todo', 'tbd', 'reason', 'none', 'n/a', '-', '...']);
const WINDOWLESS = new Set(['wscript', 'wscript.exe']);

const FIX = 'Start it through "wscript.exe //B run-hidden.vbs <program> <args>" (helm-host-kit), run it without a desktop, '
  + 'or, only if it truly needs the screen, write "foreground: <why>" on the launcher line or just above it.';

const MESSAGES = {
  'start-process-visible': (why) => `Start-Process ${why}, which shows a window.`,
  'vbs-run-visible': (why) => `WScript.Shell ${why}, which shows a window.`,
  'batch-start-visible': () => '"start" without /b opens a new window.',
  'cmd-start-visible': () => '"cmd /c start" without /b opens a new window.',
  'node-detached-visible': () => 'a detached Node child without windowsHide: true gets its own console window.',
};

function validReason(text) {
  const reason = text.replace(/-->\s*$/, '').trim();
  return !PLACEHOLDERS.has(reason.toLowerCase()) && !/^<[^>]*>$/.test(reason);
}

function declarations(rawLines) {
  let file = false;
  const lines = new Set();
  rawLines.forEach((l, i) => {
    const f = l.match(/foreground-file:(.*)$/i);
    if (f && validReason(f[1])) file = true;
    const d = l.match(/foreground:(.*)$/i);
    if (d && !/foreground-file:/i.test(l) && validReason(d[1])) lines.add(i + 1);
  });
  return { file, covers: (line) => file || [...Array(DECLARATION_REACH + 1).keys()].some((k) => lines.has(line - k)) };
}

// Blank out comments while keeping line numbers. Quote-aware enough for launcher lines.
function stripComments(text, kind) {
  if (kind === 'xml') return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  if (kind === 'js') text = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  if (kind === 'ps') text = text.replace(/<#[\s\S]*?#>/g, (m) => m.replace(/[^\n]/g, ' '));
  return text.split('\n').map((line) => {
    if (kind === 'bat') return /^\s*(@\s*)?(rem\b|::)/i.test(line) ? '' : line;
    if (kind === 'vbs' && /^\s*rem\b/i.test(line)) return '';
    const marker = { ps: '#', vbs: "'", js: '//' }[kind];
    if (!marker) return line;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (kind === 'vbs' ? c === '"' : (c === '"' || c === "'" || (kind === 'js' && c === '`'))) { quote = c; continue; }
      if (line.startsWith(marker, i)) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

// Join continued lines (PowerShell backtick, batch caret); each logical line keeps its first line number.
function logicalLines(text, kind) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i + 1;
    let line = lines[i].replace(/\r$/, '');
    const cont = kind === 'ps' ? /`\s*$/ : kind === 'bat' ? /\^\s*$/ : null;
    while (cont && cont.test(line) && i + 1 < lines.length) line = line.replace(cont, ' ') + lines[++i].replace(/\r$/, '');
    out.push({ line: start, text: line });
  }
  return out;
}

function programName(value) {
  if (value == null) return null;
  const v = value.trim().replace(/^["']|["']$/g, '');
  if (!v || /^[$%]/.test(v) || /\$\(/.test(v)) return null;
  return v.split(/[\\/]/).pop().toLowerCase();
}

function firstToken(command) {
  const c = command.trim().replace(/\\"/g, '"');
  const m = c.match(/^"([^"]*)"|^(\S+)/);
  return m ? (m[1] ?? m[2]) : null;
}

function psExecuteValue(rest, fileText) {
  const m = rest.match(/-Execute\s+("([^"]*)"|'([^']*)'|\(([^)]*)\)|(\$[\w:.]+)|([^\s)]+))/i);
  if (!m) return null;
  if (m[2] != null) return m[2];
  if (m[3] != null) return m[3];
  if (m[4] != null) { const lits = [...m[4].matchAll(/["']([^"']+)["']/g)]; return lits.length ? lits.at(-1)[1] : null; }
  if (m[5] != null) return psVariableValue(m[5], fileText);
  return m[6];
}

// The literal last assigned to a simple PowerShell variable, or null when it cannot be read.
function psVariableValue(ref, fileText) {
  if (/\./.test(ref.slice(1))) return null;
  const name = ref.slice(1).replace(/^(script|global|local):/i, '');
  const assign = [...fileText.matchAll(new RegExp(`\\$${name}\\s*=\\s*(?:"((?:\`"|[^"])*)"|'([^']*)')`, 'gi'))];
  return assign.length ? (assign.at(-1)[1] ?? assign.at(-1)[2]).replace(/`"/g, '"') : null;
}

function psNoDesktop(code) {
  return /-LogonType\s+['"]?(S4U|Password|ServiceAccount)\b/i.test(code)
    || /-UserId\s+['"]?(NT AUTHORITY\\)?(SYSTEM|LOCAL ?SERVICE|NETWORK ?SERVICE)['"]?(\s|$|\))/im.test(code)
    || /Register-ScheduledTask\b[^\n]*-Password\b/i.test(code);
}

function taskFinding(prog, raw) {
  if (prog == null) {
    return { rule: 'task-console', message: `this scheduled task's program (${raw.trim().slice(0, 80)}) cannot be read here, so the check cannot tell whether it opens a window.` };
  }
  if (WINDOWLESS.has(prog)) return null;
  return { rule: 'task-console', message: `this scheduled task starts ${prog} in the logged-on session, which opens a window (-WindowStyle Hidden still flashes one).` };
}

function startProcessProblem(rest, fileText) {
  const visible = rest.match(/-WindowStyle\s+['"]?(Normal|Minimized|Maximized)\b/i);
  if (visible) return `uses -WindowStyle ${visible[1]}`;
  if (/-WindowStyle\s+['"]?Hidden\b/i.test(rest) || /-NoNewWindow\b/i.test(rest) || /-RedirectStandard(Output|Error|Input)\b/i.test(rest)) return null;
  const splat = rest.match(/@(\w+)/);
  if (splat) {
    const n = splat[1];
    const table = fileText.match(new RegExp(`\\$${n}\\s*=\\s*@\\{([\\s\\S]*?)\\}`, 'i'));
    const body = (table ? table[1] : '') + '\n' + [...fileText.matchAll(new RegExp(`\\$${n}\\.(\\w+)\\s*=\\s*([^\\n;]+)`, 'gi'))].map((x) => `${x[1]} = ${x[2]}`).join('\n');
    const sv = body.match(/WindowStyle['"]?\s*=\s*['"]?(Normal|Minimized|Maximized)\b/i);
    if (sv) return `uses WindowStyle ${sv[1]}`;
    if (/WindowStyle['"]?\s*=\s*['"]?Hidden\b/i.test(body) || /NoNewWindow['"]?\s*=\s*\$true/i.test(body) || /RedirectStandard(Output|Error|Input)/i.test(body)) return null;
  }
  return 'sets none of -WindowStyle Hidden, -NoNewWindow or -RedirectStandard*';
}

function splitArgs(s) {
  const out = []; let cur = ''; let depth = 0; let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') { if (depth === 0) break; depth--; }
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function checkText(path, text) {
  const kind = KINDS[extname(path).toLowerCase()];
  if (!kind) return [];
  text = text.replace(/\r\n/g, '\n');
  const raw = text.split('\n');
  const decl = declarations(raw);
  const code = stripComments(text, kind);
  const lines = logicalLines(code, kind);
  const found = [];
  const add = (line, rule, message) => { if (!decl.covers(line)) found.push({ path, line, rule, message, fix: FIX }); };

  if (kind === 'xml') {
    const cmd = code.match(/<Exec>[\s\S]*?<Command>([^<]*)<\/Command>/i);
    if (cmd) {
      const noDesktop = /<LogonType>\s*(S4U|Password)\s*<\/LogonType>/i.test(code) || /<UserId>\s*(S-1-5-18|SYSTEM|NT AUTHORITY\\SYSTEM)\s*<\/UserId>/i.test(code);
      const line = code.slice(0, code.indexOf(cmd[0]) + cmd[0].indexOf('<Command>')).split('\n').length;
      const f = noDesktop ? null : taskFinding(programName(cmd[1]), cmd[1]);
      if (f) add(line, f.rule, f.message);
    }
    return found;
  }

  for (const { line, text: l } of lines) {
    const st = l.match(/\bschtasks(?:\.exe)?['"]?\s+\/create\b(.*)$/i);
    if (st) {
      const rest = st[1];
      const noDesktop = /\/RU\s+['"]?(NT AUTHORITY\\)?SYSTEM\b/i.test(rest) || /\/(NP|RP)\b/i.test(rest);
      const tr = rest.match(/\/TR\s+("((?:\\"|[^"])*)"|(\S+))/i);
      let value = tr ? (tr[2] ?? tr[3]) : null;
      if (kind === 'ps' && value && value.startsWith('$')) value = psVariableValue(value, code);
      const f = noDesktop ? null : taskFinding(value == null ? null : programName(firstToken(value)), value ?? '(no /TR)');
      if (f) add(line, f.rule, f.message);
    }
    const cs = l.match(/\bcmd(?:\.exe)?['"]?\s*,?\s*\[?\s*['"]?\/[ck]['"]?\s*,?\s*['"]?start\b(.{0,40})/i);
    if (cs && !/^['"]?\s*,?\s*['"]?\/b\b/i.test(cs[1])) add(line, 'cmd-start-visible', MESSAGES['cmd-start-visible']());

    if (kind === 'ps') {
      const act = l.match(/\bNew-ScheduledTaskAction\b(.*)$/i);
      if (act && !psNoDesktop(code)) {
        const value = psExecuteValue(act[1], code);
        const f = taskFinding(programName(value), (act[1].match(/-Execute\s+(\S+)/i) || [, '?'])[1]);
        if (f) add(line, f.rule, f.message);
      }
      const sp = l.match(/\bStart-Process\b(.*)$/i);
      if (sp) {
        const why = startProcessProblem(sp[1], code);
        if (why) add(line, 'start-process-visible', MESSAGES['start-process-visible'](why));
      }
    }
    if (kind === 'vbs') {
      const run = l.match(/\.Run\b\s*(.*)$/i);
      if (run) {
        const args = splitArgs(run[1].replace(/^\(/, ''));
        if (args.length < 2 || args[1] !== '0') add(line, 'vbs-run-visible', MESSAGES['vbs-run-visible'](args.length < 2 ? '.Run has no window style (default is a normal window)' : `.Run uses window style ${args[1]}`));
      }
      if (/\.Exec\s*\(/i.test(l)) add(line, 'vbs-run-visible', MESSAGES['vbs-run-visible']('.Exec always opens a console'));
    }
    if (kind === 'bat') {
      const s = l.match(/(?:^|[&|(])\s*@?\s*start(?:\.exe)?\s+(.*)$/i);
      if (s && !/(^|\s)\/b\b/i.test(s[1])) add(line, 'batch-start-visible', MESSAGES['batch-start-visible']());
    }
  }

  if (kind === 'js') {
    for (const m of code.matchAll(/\bdetached\s*:\s*true\b/g)) {
      const open = code.lastIndexOf('{', m.index);
      const close = code.indexOf('}', m.index);
      const obj = code.slice(open < 0 ? 0 : open, close < 0 ? code.length : close);
      if (!/\bwindowsHide\s*:\s*true\b/.test(obj)) add(code.slice(0, m.index).split('\n').length, 'node-detached-visible', MESSAGES['node-detached-visible']());
    }
  }
  return found;
}

function walk(root, ignore, out) {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(full, ignore, out); continue; }
    if (KINDS[extname(name).toLowerCase()]) out.push(full);
  }
  return out.filter((f) => !ignore.some((p) => relative(ignore.root, f).split(sep).join('/').startsWith(p)));
}

export function checkPaths(paths) {
  const findings = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isFile()) { findings.push(...checkText(p, readFileSync(p, 'utf8'))); continue; }
    const listFile = join(p, '.hidden-launch-ignore');
    const ignore = existsSync(listFile) ? readFileSync(listFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
    ignore.root = p;
    for (const f of walk(p, ignore, [])) findings.push(...checkText(relative(process.cwd(), f) || f, readFileSync(f, 'utf8')));
  }
  return findings;
}

// --pinned <file>: a repository's copy of this script refuses to run when its own bytes differ from the
// sha256 recorded in <file> (the first 64-hex token), so a copy cannot drift from the release it was taken from.
export function pinnedProblem(pinFile, selfPath = fileURLToPath(import.meta.url)) {
  const want = (readFileSync(pinFile, 'utf8').match(/\b[0-9a-f]{64}\b/i) || [])[0];
  if (!want) return `${pinFile} holds no sha256`;
  const have = createHash('sha256').update(readFileSync(selfPath)).digest('hex');
  return have === want.toLowerCase() ? null : `this copy (sha256 ${have}) differs from the release recorded in ${pinFile} (${want}); copy the release file again instead of editing it`;
}

function main(argv) {
  const json = argv.includes('--json');
  const pi = argv.indexOf('--pinned');
  if (pi > -1) {
    const problem = pinnedProblem(argv[pi + 1]);
    if (problem) { process.stderr.write(`check-hidden-launch: ${problem}\n`); return 2; }
  }
  const paths = argv.filter((a, i) => a !== '--json' && a !== '--pinned' && !(pi > -1 && i === pi + 1));
  const findings = checkPaths(paths.length ? paths : ['.']);
  if (json) process.stdout.write(JSON.stringify({ refused: findings.length, findings }, null, 2) + '\n');
  else if (!findings.length) process.stdout.write('check-hidden-launch: nothing refused\n');
  else {
    for (const f of findings) process.stdout.write(`${f.path}:${f.line} [${f.rule}] ${f.message}\n`);
    process.stdout.write(`\ncheck-hidden-launch: ${findings.length} refused. Fix: ${FIX}\n`);
  }
  return findings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`check-hidden-launch: failed: ${e.message}\n`); process.exitCode = 2; }
}
