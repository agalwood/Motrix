#!/usr/bin/env python3
"""Verify Snapcraft's reported credential scope without accessing the credential.

Snapcraft 9 emits six plain mapping fields, with comma-separated permissions and
channels or the literal "no restrictions". Parse that complete record, including
indented plain-scalar continuations, rather than searching arbitrary log text.
Source: https://github.com/canonical/snapcraft/blob/9.1.3/snapcraft/commands/account.py
"""

import argparse
import fnmatch
import re
import subprocess
import sys


FIELDS = {"email", "username", "id", "permissions", "channels", "expires"}
SCOPES = {"permissions", "channels"}


class ScopeError(ValueError):
    """A credential's release scope could not be established."""


def parse_whoami(output: str) -> dict[str, str]:
    if len(output) > 65536 or any(
        ord(character) < 32 and character not in "\r\n" for character in output
    ):
        raise ScopeError("Snapcraft whoami returned an invalid record")
    fields: dict[str, str] = {}
    previous = None
    for line in output.strip().splitlines():
        if line.startswith(" "):
            continuation = line.strip()
            if previous not in SCOPES or not continuation or ":" in continuation:
                raise ScopeError("Snapcraft whoami returned an ambiguous continuation")
            fields[previous] += " " + continuation
            continue
        match = re.fullmatch(r"([a-z]+):(?: (.*))?", line)
        if not match:
            raise ScopeError("Snapcraft whoami returned an invalid record")
        key, value = match.groups()
        if key not in FIELDS or key in fields:
            raise ScopeError("Snapcraft whoami returned unknown or duplicate fields")
        fields[key] = value or ""
        previous = key
    if fields.keys() != FIELDS:
        raise ScopeError("Snapcraft whoami is missing required fields")
    return fields


def scope_items(value: str) -> list[str] | None:
    if value == "no restrictions":
        return None
    items = [item.strip() for item in value.split(",")]
    if not items or any(
        not item or any(character.isspace() for character in item) for item in items
    ):
        raise ScopeError("Snapcraft whoami returned an invalid scope list")
    return items


def verify_scope(output: str, channel: str) -> None:
    match = re.fullmatch(
        r"([A-Za-z0-9][A-Za-z0-9._-]*)/(stable|candidate|beta|edge)", channel
    )
    if not match:
        raise ScopeError("Expected a track/risk target channel")
    track, risk = match.groups()
    # Match the exact channel argument sent by release-snap-build-set.mjs.
    release_channel = risk if track == "latest" else channel
    fields = parse_whoami(output)
    permissions = scope_items(fields["permissions"])
    channels = scope_items(fields["channels"])
    # Snap Store documents package_upload as including package_release.
    # https://dashboard.snapcraft.io/docs/reference/v1/macaroon.html
    if permissions is not None and not {"package_release", "package_upload"}.intersection(
        permissions
    ):
        raise ScopeError("Snap credential does not permit releasing existing revisions")
    # Store channel restrictions use Python fnmatch against the release request.
    # https://dashboard.snapcraft.io/docs/reference/v1/snap.html
    if channels is not None and not any(
        fnmatch.fnmatchcase(release_channel, pattern) for pattern in channels
    ):
        raise ScopeError(f"Snap credential does not permit release to {channel}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapcraft", default="/snap/bin/snapcraft")
    parser.add_argument("--channel", required=True)
    options = parser.parse_args()
    try:
        result = subprocess.run(
            [options.snapcraft, "whoami", "--verbosity", "brief"],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        raise ScopeError(
            "Snapcraft whoami failed; credential scope was not verified"
        ) from None
    if result.returncode != 0 or result.stderr.strip():
        raise ScopeError(
            "Snapcraft whoami failed or emitted diagnostics; "
            "credential scope was not verified"
        )
    verify_scope(result.stdout, options.channel)
    print(f"Verified Snap credential permits release to {options.channel}")


if __name__ == "__main__":
    try:
        main()
    except ScopeError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
