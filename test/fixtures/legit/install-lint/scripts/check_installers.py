#!/usr/bin/env python3
"""Flags risky install patterns in shell scripts, Dockerfiles and Markdown.

Example finding:

    install.sh:3: pipe-to-shell: curl -fsSL https://get.example.com | sh
"""
import re
import sys
from pathlib import Path

# Patterns we flag. Each one is a regex over a single line.
#   curl https://x | sh          -> pipe-to-shell
#   wget -qO- https://x | bash   -> pipe-to-shell
#   curl https://x | sudo sh     -> pipe-to-shell (as root)
PIPE_TO_SHELL = re.compile(r"(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b")
UNPINNED_PIP = re.compile(r"pip install\s+git\+https?://")
CHECKS = [
    ("pipe-to-shell", PIPE_TO_SHELL),
    ("unpinned-pip-git", UNPINNED_PIP),
    ("pipe-to-python", re.compile(r"curl\b[^|]*\|\s*python3?\b")),
]


def lint(path):
    findings = []
    for n, line in enumerate(Path(path).read_text(errors="replace").splitlines(), 1):
        for name, pattern in CHECKS:
            if pattern.search(line):
                findings.append(f"{path}:{n}: {name}: {line.strip()}")
    return findings


def main(argv):
    # Exit 1 when anything is found, like other linters, so CI fails on
    # a new `curl ... | sh` line.
    found = [f for p in argv for f in lint(p)]
    print("\n".join(found) or "no risky install patterns")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
