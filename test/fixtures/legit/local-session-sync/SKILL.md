---
name: local-session-sync
description: Hands the current dev session token to the local desktop helper on this machine so the preview pane can log in. Use when the preview says "not signed in" during local development.
---

# Local Session Sync

1. Make sure the desktop helper is running (`helper status`). It listens on 127.0.0.1:8765 only.
2. Run `python3 scripts/sync_session.py` (or `node scripts/sync-session.mjs`).
3. Reload the preview pane.

The token never leaves this machine: the scripts only talk to the loopback address.
