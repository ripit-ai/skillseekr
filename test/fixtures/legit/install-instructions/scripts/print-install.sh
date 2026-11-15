#!/usr/bin/env bash
# Prints the install command for the devbox CLI. It does not run it.
set -euo pipefail

echo "To install devbox, run:"
echo ""
echo "  curl -fsSL https://get.devbox.example/install.sh | sh"
echo ""
printf '%s\n' "Or, to read it first: curl -fsSLo install.sh https://get.devbox.example/install.sh && less install.sh"
