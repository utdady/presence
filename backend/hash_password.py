#!/usr/bin/env python3
"""Hash a password for users.json. Usage: python hash_password.py [password]"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

# Allow running from backend/ without installing the package
sys.path.insert(0, str(Path(__file__).resolve().parent))

from argon2 import PasswordHasher


def main() -> None:
    parser = argparse.ArgumentParser(description="Hash a password with Argon2id")
    parser.add_argument("password", nargs="?", help="Password to hash (prompted if omitted)")
    args = parser.parse_args()
    password = args.password or getpass.getpass("Password: ")
    if not password:
        print("Empty password", file=sys.stderr)
        sys.exit(1)
    print(PasswordHasher().hash(password))


if __name__ == "__main__":
    main()
