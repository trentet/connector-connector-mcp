#!/usr/bin/env python3
"""Self-test of scripts/req_gate.py (REQ-G001, REQ-G002): builds throwaway git repositories and checks that the
gate accepts a traced ledger and refuses each kind of gap. Exit 0 = all cases behaved."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().with_name("req_gate.py")

GOOD = """gate:
  id_pattern: '\\b(?:REQ-[UDG]\\d{3}|ACCT-(?:\\d{3}|[PCV]\\d{2}))\\b'
  code: ['^src/.+\\.js$']
  tests: ['^test/.+\\.js$']
  tool_files: ['^src/.+\\.js$']
requirements:
- id: REQ-U001
  kind: user
  status: decided
  source: owner chat t1 2026-01-01
  quotes: [Every tool must check the account]
  implemented_by: [ACCT-001]
- id: ACCT-001
  kind: derived
  status: decided
  title: check the account
  files: ['src/main.js']
  tools: [do_thing]
  decision: {quote: Every tool must check the account, at: 2026-01-01, source: owner chat t1, from: REQ-U001}
- id: REQ-D001
  kind: legacy_doc
  status: decided
  title: readme behaviour
  files: ['src/legacy.js']
  source: {path: README.md, section: Usage, quote: the tool does a thing}
- id: ACCT-002
  kind: derived
  status: needs_discussion
  title: open question
"""
FILES = {
    "README.md": "# x\n## Usage\nThe tool does a thing.\n".replace("The", "the"),
    "src/main.js": "server.registerTool(\"do_thing\", {}, () => 1);\n",
    "src/legacy.js": "module.exports = 1;\n",
    "test/main.test.js": "// ACCT-001 REQ-D001 do_thing\n",
}


def run(cwd, *a, stdin=None):
    return subprocess.run(list(a), cwd=cwd, capture_output=True, input=stdin, text=True)


def repo(mut=None) -> str:
    d = tempfile.mkdtemp(prefix="reqgate-")
    files = dict(FILES)
    files["docs/requirements.yaml"] = GOOD
    if mut:
        mut(files)
    for p, c in files.items():
        f = Path(d, p)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(c, encoding="utf-8")
    run(d, "git", "init", "-q")
    run(d, "git", "config", "user.email", "t@example.test")
    run(d, "git", "config", "user.name", "t")
    run(d, "git", "add", "-A")
    return d


def gate(d, *a, stdin=None):
    return run(d, sys.executable, str(GATE), *a, stdin=stdin)


CASES = []


def case(name, mut, want_ok, mode="static"):
    CASES.append((name, mut, want_ok, mode))


case("traced ledger passes", None, True)
case("decided requirement cited in no test is refused",
     lambda f: f.__setitem__("test/main.test.js", "// REQ-D001 do_thing\n"), False)
case("code file covered by no requirement is refused",
     lambda f: f.__setitem__("src/other/x.js", "1;\n"), False)
case("registered tool mapped to no requirement is refused",
     lambda f: f.__setitem__("src/main.js", f["src/main.js"] + "server.registerTool(\"other_tool\", {}, () => 1);\n"), False)
case("a tool outside gate.tools_in_scope is not checked; one inside it is",
     lambda f: (f.__setitem__("src/main.js", f["src/main.js"] + "server.registerTool(\"old_tool\", {}, () => 1);\n"),
                f.__setitem__("docs/requirements.yaml", f["docs/requirements.yaml"].replace("tool_files:", "tools_in_scope: [do_thing]\n  tool_files:"))), True)
case("a code file outside gate.code is not checked",
     lambda f: f.__setitem__("lib/old.js", "1;\n"), True)
case("decision quote that is not the owner's verbatim words is refused",
     lambda f: f.__setitem__("docs/requirements.yaml", f["docs/requirements.yaml"].replace("quote: Every tool must check the account,", "quote: Tools should check,")), False)
case("legacy_doc quote missing from its file is refused",
     lambda f: f.__setitem__("README.md", "# x\n"), False)
case("code citing a blocked (needs_discussion) requirement is refused",
     lambda f: f.__setitem__("src/legacy.js", "// ACCT-002\nmodule.exports = 1;\n"), False)
case("untraced entry with a why passes",
     lambda f: (f.__setitem__("test/main.test.js", "// ACCT-001 do_thing\n"), f.__setitem__("docs/requirements.yaml", f["docs/requirements.yaml"] + "untraced:\n- {id: REQ-D001, why: no test can reach it yet}\n")), True)
case("untraced entry without a why is refused",
     lambda f: (f.__setitem__("test/main.test.js", "// ACCT-001 do_thing\n"), f.__setitem__("docs/requirements.yaml", f["docs/requirements.yaml"] + "untraced:\n- {id: REQ-D001}\n")), False)
case("test citing an unknown id is refused",
     lambda f: f.__setitem__("test/main.test.js", f["test/main.test.js"] + "// ACCT-099\n"), False)


def main() -> int:
    bad = 0
    for name, mut, want_ok, mode in CASES:
        d = repo(mut)
        r = gate(d, mode)
        ok = r.returncode == 0
        if ok != want_ok:
            bad += 1
            print(f"FAIL {name}: exit {r.returncode}\n{r.stdout}{r.stderr}")
        else:
            print(f"ok   {name}")
    # commit-msg
    d = repo()
    for msg, want in (("Add the check (ACCT-001)", True), ("Add the check", False), ("Add (ACCT-002)", False), ("Add (ACCT-077)", False)):
        p = Path(d, "MSG"); p.write_text(msg, encoding="utf-8")
        ok = gate(d, "commit-msg", str(p)).returncode == 0
        print(("ok   " if ok == want else "FAIL ") + f"commit-msg {msg!r} -> {'accepted' if ok else 'refused'}")
        bad += ok != want
    # pre-commit diff: removing a blocked entry is refused
    d = repo()
    run(d, "git", "commit", "-q", "--no-verify", "-m", "base ACCT-001")
    led = Path(d, "docs/requirements.yaml")
    led.write_text(led.read_text().split("- id: ACCT-002")[0], encoding="utf-8")
    run(d, "git", "add", "-A")
    ok = gate(d, "pre-commit").returncode == 0
    print(("ok   " if not ok else "FAIL ") + "pre-commit: removing a blocked requirement is refused")
    bad += ok
    # pre-commit: clean change passes
    d = repo()
    run(d, "git", "commit", "-q", "--no-verify", "-m", "base ACCT-001")
    Path(d, "src/legacy.js").write_text("module.exports = 2;\n", encoding="utf-8")
    run(d, "git", "add", "-A")
    r = gate(d, "pre-commit")
    print(("ok   " if r.returncode == 0 else "FAIL ") + "pre-commit: a traced change passes")
    bad += r.returncode != 0
    # pre-commit: a file covered only by an undecided entry cannot change
    def frozen(f):
        f["src/frozen.js"] = "1;\n"
        f["docs/requirements.yaml"] = f["docs/requirements.yaml"].replace("  title: open question\n", "  title: open question\n  files: ['src/frozen.js']\n")
    d = repo(frozen)
    run(d, "git", "commit", "-q", "--no-verify", "-m", "base ACCT-001")
    Path(d, "src/frozen.js").write_text("2;\n", encoding="utf-8")
    run(d, "git", "add", "-A")
    ok = gate(d, "pre-commit").returncode == 0
    print(("ok   " if not ok else "FAIL ") + "pre-commit: a file covered only by an undecided requirement cannot change")
    bad += ok
    # pre-push: a pushed commit whose message cites nothing is refused
    d = repo()
    run(d, "git", "commit", "-q", "--no-verify", "-m", "no id here")
    sha = run(d, "git", "rev-parse", "HEAD").stdout.strip()
    ok = gate(d, "pre-push", stdin=f"refs/heads/main {sha} refs/heads/main {'0'*40}\n").returncode == 0
    print(("ok   " if not ok else "FAIL ") + "pre-push: a commit without a requirement id is refused")
    bad += ok
    print(f"req_gate selftest: {'ok' if not bad else f'{bad} FAILED'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
