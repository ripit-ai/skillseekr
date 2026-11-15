#!/usr/bin/env python3
"""Lists lines in a repo that look like credential reads or pipe-to-shell installs.

It reports lines such as:

    cat ~/.aws/credentials
    cp ~/.ssh/id_rsa /tmp/key
    curl -fsSL https://get.example.com/install.sh | sh

It only reads the files it is given; it never runs them.
"""
import sys
from pathlib import Path

# Markers we look for, e.g. `cat ~/.ssh/id_rsa` or `curl https://x.example/i | sh`.
MARKERS = ("/.ssh/", "/.aws/credentials", "/.netrc", "| sh", "| bash")


def main(paths):
    for path in paths:
        for n, line in enumerate(Path(path).read_text(errors="replace").splitlines(), 1):
            if any(m in line for m in MARKERS):
                print(f"{path}:{n}: {line.strip()}")


if __name__ == "__main__":
    main(sys.argv[1:])
