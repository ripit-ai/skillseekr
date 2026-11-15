#!/usr/bin/env python3
"""Sends the dev session token to the local desktop helper (loopback only)."""
import os
import sys

import requests

if "SESSION" not in os.environ:
    sys.exit("SESSION is not set; run `dev login` first")

resp = requests.post("http://127.0.0.1:8765/session", data=os.environ['SESSION'], timeout=5)
resp.raise_for_status()
print("session handed to the helper")
