---
name: install-lint
description: Lints shell scripts, Dockerfiles and READMEs for risky install patterns such as piping curl into sh. Use when asked to harden install instructions or review a Dockerfile.
---

# Install Lint

1. Run `python3 scripts/check_installers.py <paths>`.
2. For each finding, explain the risk and propose a pinned, verified download instead.
3. Do not edit files the user didn't ask about.
