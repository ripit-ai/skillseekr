"""Unit tests for check_installers.py: each risky sample must be flagged, each safe one must not."""
import re
from pathlib import Path

from check_installers import CHECKS, lint

# Vendor installers we have seen in the wild, matched exactly so a regression names the vendor.
KNOWN_VENDORS = [
    ("get.example.com", re.compile(r"curl -fsSL https://get.example.com/install.sh | sh")),
    ("example.com/setup", re.compile(r"wget -qO- https://example.com/setup | sudo bash")),
]
SAFE = ["curl -fsSLo install.sh https://get.example.com/install.sh", "sh ./install.sh"]


def test_vendor_installers_are_flagged():
    sample = Path(__file__).with_name("samples") / "vendor-install.txt"
    assert lint(sample)
    text = sample.read_text()
    assert [name for name, vendor in KNOWN_VENDORS if vendor.search(text)]


def test_safe_lines_are_not_flagged():
    for line in SAFE:
        assert not any(check.search(line) for _, check in CHECKS)
