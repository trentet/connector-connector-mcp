#!/usr/bin/env python3
"""Requirement gate: spec before code, and requirement-to-test traceability.

Owner rules REQ-U001 (requirements in the specification before development) and REQ-U002 (no PR without
traceability from requirement down to test cases); see docs/requirements.yaml. Standalone: stdlib + PyYAML only.

Scope: the gate covers only what the ledger puts in scope. gate.code lists the code files in scope (files this
ledger's requirements add or change); gate.tools_in_scope, when set, limits the MCP tool checks to those tools.
Existing code outside that scope is not covered yet (owner t117u, 2026-11-11: backfill is a separate job).

Ledger: docs/requirements.yaml
  gate:          per-repo patterns (id, code files, test files, MCP tool registration)
  requirements:  entries {id, title, status, kind, ...}
    status   decided | needs_discussion | unauthorized_pending_review
    kind     user        the owner's verbatim words (quotes, source, date); implemented_by lists decided ids
             derived     a requirement written from owner words; decided only with decision {quote, at, source, from}
                         where `from` is a kind:user entry whose quotes contain the quote verbatim
             legacy_doc  behaviour that shipped before this gate, as written in a repository file; decided only when
                         source.quote is found verbatim in source.path (checked in the tree being gated)
    files    globs of the code files the entry covers (every code file must be covered by a decided entry)
    tools    MCP tool names the entry covers (every registered tool must be covered and named in a test)
  untraced:      [{id, why}] decided entries with no test file to cite them yet (said why, never given a fake test)

Checks
  static     ledger valid; every decided derived/legacy_doc entry is cited (its id appears) in a test file or listed
             under untraced with a why; every code file covered by a logged entry; every registered tool covered by a
             decided entry and named in a test; blocked ids appear only in docs/.
  pre-commit static on the staged tree, plus diff checks against HEAD.
  commit-msg the message cites at least one id, and every cited id is known and decided.
  pre-push   commit-msg check on every pushed commit, static + diff checks on the pushed tip.
  diff       blocked entries cannot be removed or have their status changed outside the owner's decision;
             no added code/test line cites a blocked id; a code file covered only by undecided entries cannot change.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

LEDGER = "docs/requirements.yaml"
STATUSES = ("decided", "needs_discussion", "unauthorized_pending_review")
BLOCKED = ("needs_discussion", "unauthorized_pending_review")
KINDS = ("user", "derived", "legacy_doc")
ZERO = "0" * 40


def _norm(t: str) -> str:
    return t.replace("\r\n", "\n").lstrip("\ufeff")


def _git(*a: str, cwd: Optional[str] = None, stdin: Optional[bytes] = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, input=stdin)


class WorkTree:
    def __init__(self, root: str = "."):
        self.root = Path(root)

    def read(self, path: str) -> Optional[str]:
        p = self.root / path
        return _norm(p.read_text(encoding="utf-8", errors="replace")) if p.is_file() else None

    def files(self) -> list[str]:
        r = _git("ls-files", "--cached", "--others", "--exclude-standard", cwd=str(self.root))
        return sorted(x for x in r.stdout.decode("utf-8").splitlines() if (self.root / x).is_file())


class IndexTree:
    """The staged tree (what the commit will contain)."""

    def read(self, path: str) -> Optional[str]:
        r = _git("show", f":{path}")
        return _norm(r.stdout.decode("utf-8", errors="replace")) if r.returncode == 0 else None

    def files(self) -> list[str]:
        return sorted(_git("ls-files", "--cached").stdout.decode("utf-8").splitlines())


class GitTree:
    def __init__(self, rev: str):
        self.rev = rev

    def read(self, path: str) -> Optional[str]:
        r = _git("cat-file", "blob", f"{self.rev}:{path}")
        return _norm(r.stdout.decode("utf-8", errors="replace")) if r.returncode == 0 else None

    def files(self) -> list[str]:
        r = _git("ls-tree", "-r", "--name-only", self.rev)
        return sorted(r.stdout.decode("utf-8").splitlines()) if r.returncode == 0 else []


class EmptyTree:
    def read(self, path: str) -> Optional[str]:
        return None

    def files(self) -> list[str]:
        return []


def load(src) -> dict:
    import yaml
    text = src.read(LEDGER)
    return (yaml.safe_load(text) if text else None) or {}


def entries(led: dict) -> dict[str, dict]:
    return {str(r.get("id")): r for r in (led.get("requirements") or []) if isinstance(r, dict)}


def gate_cfg(led: dict) -> dict:
    g = led.get("gate") or {}
    return {
        "id": re.compile(g.get("id_pattern") or r"\b(?:REQ-[UD]\d{3}|ACCT-(?:\d{3}|[PCV]\d{2}))\b"),
        "code": [re.compile(p) for p in (g.get("code") or [r"^src/.+\.(ts|js|mjs)$"])],
        "tests": [re.compile(p) for p in (g.get("tests") or [r"^test/.+\.(ts|js|mjs)$"])],
        "tool_re": re.compile(g.get("tool_pattern") or r"registerTool\(\s*[\"']([a-z0-9_]+)[\"']"),
        "tool_files": [re.compile(p) for p in (g.get("tool_files") or [r"^src/.+\.(ts|js)$"])],
        "tools_in_scope": None if g.get("tools_in_scope") is None else {str(t) for t in g.get("tools_in_scope")},
    }


def _ws(s) -> str:
    return " ".join(str(s or "").split())


def _glob(pattern: str) -> "re.Pattern[str]":
    """Path glob: ** matches across folders, * and ? stay inside one folder."""
    out, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"; i += 3; continue
        if pattern.startswith("**", i):
            out += ".*"; i += 2; continue
        out += "[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c)
        i += 1
    return re.compile(out + r"\Z")


def globmatch(path: str, pattern: str) -> bool:
    return bool(_glob(pattern).match(path))


def _match(path: str, pats) -> bool:
    return any(p.search(path) for p in pats)


def ledger_problems(led: dict, src) -> list[str]:
    out = []
    es = entries(led)
    if not es:
        return [f"{LEDGER}: no requirements"]
    seen = set()
    for r in led.get("requirements") or []:
        i = str(r.get("id"))
        if i in seen:
            out.append(f"{i}: duplicate id")
        seen.add(i)
    cfg = gate_cfg(led)
    for i, r in es.items():
        if not cfg["id"].fullmatch(i):
            out.append(f"{i}: id does not match gate.id_pattern")
        s, k = r.get("status"), r.get("kind")
        if s not in STATUSES:
            out.append(f"{i}: status {s!r} is not one of {', '.join(STATUSES)}")
            continue
        if k not in KINDS:
            out.append(f"{i}: kind {k!r} is not one of {', '.join(KINDS)}")
            continue
        if k == "user":
            if not r.get("quotes") or not r.get("source"):
                out.append(f"{i}: kind:user needs the owner's verbatim quotes and the source message")
            for d in r.get("implemented_by") or []:
                if str(d) not in es:
                    out.append(f"{i}: implemented_by {d} is not a ledger entry")
            continue
        if s != "decided":
            continue
        if k == "derived":
            why = decision_problem(es, r)
            if why:
                out.append(f"{i}: may be decided only on the owner's recorded words: {why}")
        elif k == "legacy_doc":
            why = legacy_problem(r, src)
            if why:
                out.append(f"{i}: legacy_doc source not verified: {why}")
    return out


def decision_problem(es: dict, r: dict) -> Optional[str]:
    d = r.get("decision")
    if not isinstance(d, dict):
        return "no decision block"
    q = _ws(d.get("quote"))
    if not q:
        return "decision quote is empty"
    if not d.get("at") or not d.get("source"):
        return "decision needs a time (at) and a source message (source)"
    froms = d.get("from") if isinstance(d.get("from"), list) else [d.get("from")]
    for f in froms:
        src = es.get(str(f))
        if src is None:
            return f"decision.from {f!r} is not a ledger entry"
        if src.get("kind") != "user":
            return f"decision.from {f} is kind {src.get('kind')!r}; only kind:user (owner) words count"
    if not any(q in _ws(x) for f in froms for x in (es[str(f)].get("quotes") or [])):
        return "decision quote is not verbatim in the cited owner quotes"
    return None


def legacy_problem(r: dict, src) -> Optional[str]:
    s = r.get("source")
    if not isinstance(s, dict) or not s.get("path") or not s.get("quote") or not s.get("section"):
        return "needs source {path, section, quote}"
    text = src.read(str(s["path"]))
    if text is None:
        return f"{s['path']} is not in the tree"
    if _ws(s["quote"]) not in _ws(text):
        return f"quote not found verbatim in {s['path']}"
    return None


def trace_problems(led: dict, src) -> list[str]:
    out = []
    cfg = gate_cfg(led)
    es = entries(led)
    files = src.files()
    tests = {f: src.read(f) or "" for f in files if _match(f, cfg["tests"])}
    code = [f for f in files if _match(f, cfg["code"])]
    decided = {i: r for i, r in es.items() if r.get("status") == "decided" and r.get("kind") in ("derived", "legacy_doc")}
    blocked = {i for i, r in es.items() if r.get("status") in BLOCKED}
    cited = set()
    for t in tests.values():
        cited |= set(cfg["id"].findall(t))
    untraced = untraced_ids(led)
    for u in led.get("untraced") or []:
        if not isinstance(u, dict) or str(u.get("id")) not in decided or not _ws(u.get("why")):
            out.append(f"untraced: {u!r} must name a decided derived/legacy_doc entry and say why it has no test")
    for i in sorted(decided):
        if i not in cited and i not in untraced:
            out.append(f"{i}: decided but cited in no test file (or listed under untraced with a why)")
    for f in code:
        if not covering(led, f):
            out.append(f"{f}: code file not covered by any logged requirement (files:)")
    tools = set()
    for f in files:
        if _match(f, cfg["tool_files"]):
            tools |= set(cfg["tool_re"].findall(src.read(f) or ""))
    if cfg["tools_in_scope"] is not None:
        tools &= cfg["tools_in_scope"]
    covered_tools = {str(t) for r in decided.values() for t in (r.get("tools") or [])}
    alltests = "\n".join(tests.values())
    for t in sorted(tools):
        if t not in covered_tools:
            out.append(f"tool {t}: registered but mapped to no decided requirement (tools:)")
        if t not in alltests:
            out.append(f"tool {t}: registered but named in no test file")
    for t in sorted(covered_tools - tools):
        out.append(f"tool {t}: listed in the ledger but not registered in code")
    for f in files:
        if f.startswith("docs/") or not (_match(f, cfg["code"]) or f in tests):
            continue
        hit = sorted(set(cfg["id"].findall(src.read(f) or "")) & blocked)
        if hit:
            out.append(f"{f}: cites blocked requirement(s) {', '.join(hit)} (not decided by the owner; must not be built)")
    unknown = set()
    for f in list(tests) + code:
        unknown |= set(cfg["id"].findall(src.read(f) or "")) - set(es)
    for i in sorted(unknown):
        out.append(f"{i}: cited in code or tests but not in the ledger")
    for i, r in es.items():
        if r.get("kind") == "user" and r.get("status") == "decided":
            missing = [d for d in (r.get("implemented_by") or []) if str(d) in es and es[str(d)].get("status") != "decided"]
            if missing:
                out.append(f"{i}: implemented_by entries not decided: {', '.join(map(str, missing))}")
    return out


def untraced_ids(led: dict) -> set[str]:
    return {str(u.get("id")) for u in (led.get("untraced") or []) if isinstance(u, dict)}


def covering(led: dict, path: str) -> list[str]:
    """Ids of the non-user entries whose files: globs cover path."""
    return [i for i, r in entries(led).items()
            if r.get("kind") != "user" and any(globmatch(path, g) for g in (r.get("files") or []))]


def static(src) -> list[str]:
    led = load(src)
    if not led:
        return [f"{LEDGER} missing or empty"]
    return ledger_problems(led, src) + trace_problems(led, src)


def diff_problems(old, new, added_lines: list[tuple[str, str]]) -> list[str]:
    out = []
    o, n = entries(load(old)), entries(load(new))
    led_new = load(new)
    for i, r in o.items():
        if r.get("status") in BLOCKED:
            if i not in n:
                out.append(f"{i}: a blocked requirement cannot be removed")
            elif n[i].get("status") == "decided" and decision_problem(n, n[i]) and n[i].get("kind") != "user":
                out.append(f"{i}: changed from {r.get('status')} to decided without the owner's recorded words")
    if not led_new:
        return out
    cfg = gate_cfg(led_new)
    blocked = {i for i, r in n.items() if r.get("status") in BLOCKED}
    changed = sorted({p for p, _ in added_lines})
    for path in changed:
        if _match(path, cfg["code"]):
            cov = covering(led_new, path)
            if cov and all(n[i].get("status") in BLOCKED for i in cov):
                out.append(f"{path}: covered only by undecided {', '.join(cov)}; it may not change until the owner decides")
    for path, line in added_lines:
        if path.startswith("docs/"):
            continue
        if _match(path, cfg["code"]) or _match(path, cfg["tests"]):
            hit = sorted(set(cfg["id"].findall(line)) & blocked)
            if hit:
                out.append(f"{path}: added line cites blocked {', '.join(hit)}")
    return out


def _added(args: list[str]) -> list[tuple[str, str]]:
    r = _git("diff", "--unified=0", "--no-color", *args)
    out, path = [], None
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("+") and path:
            out.append((path, line[1:]))
    return out


def message_problems(msg: str, led: dict) -> list[str]:
    body = "\n".join(l for l in _norm(msg).splitlines() if not l.startswith("#"))
    if re.match(r"^(Merge|Revert) ", body):
        return []
    cfg = gate_cfg(led)
    es = entries(led)
    ids = sorted(set(cfg["id"].findall(body)))
    if not ids:
        return ["commit message cites no requirement id"]
    out = []
    for i in ids:
        if i not in es:
            out.append(f"commit message cites unknown {i}")
        elif es[i].get("status") != "decided":
            out.append(f"commit message cites {i}, which is {es[i].get('status')} (not decided by the owner)")
    return out


def _report(problems: list[str], what: str) -> int:
    if problems:
        print(f"req_gate {what}: REFUSED ({len(problems)} problem(s))", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print(f"req_gate {what}: ok")
    return 0


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "static"
    if mode == "static":
        src = GitTree(argv[2]) if len(argv) > 2 else WorkTree(".")
        return _report(static(src), "static")
    if mode == "pre-commit":
        head = GitTree("HEAD") if _git("rev-parse", "--verify", "-q", "HEAD").returncode == 0 else EmptyTree()
        idx = IndexTree()
        return _report(static(idx) + diff_problems(head, idx, _added(["--cached"])), "pre-commit")
    if mode == "commit-msg":
        msg = Path(argv[2]).read_text(encoding="utf-8", errors="replace")
        return _report(message_problems(msg, load(IndexTree())), "commit-msg")
    if mode == "pre-push":
        problems = []
        for line in sys.stdin.read().splitlines():
            parts = line.split()
            if len(parts) < 4 or parts[1] == ZERO:
                continue
            local, remote = parts[1], parts[3]
            rng = [local, "--not", "--remotes"] if remote == ZERO else [f"{remote}..{local}"]
            revs = _git("rev-list", *rng).stdout.decode().split()
            for c in revs:
                msg = _git("log", "-1", "--format=%B", c).stdout.decode("utf-8", errors="replace")
                problems += [f"{c[:7]}: {p}" for p in message_problems(msg, load(GitTree(c)))]
            tip = GitTree(local)
            problems += [f"{local[:7]}: {p}" for p in static(tip)]
            base = GitTree(remote) if remote != ZERO and _git("cat-file", "-e", remote).returncode == 0 else EmptyTree()
            added = _added([remote, local]) if isinstance(base, GitTree) else []
            problems += [f"{local[:7]}: {p}" for p in diff_problems(base, tip, added)]
        return _report(problems, "pre-push")
    print(f"usage: req_gate.py static [REV] | pre-commit | commit-msg FILE | pre-push", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
