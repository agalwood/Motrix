#!/usr/bin/env python3
"""Reconcile immutable Snap bytes with Store revisions before any upload.

Uses Snapcraft 9's bundled authentication client for the documented v2 API:
https://dashboard.snapcraft.io/docs/reference/v2/en/snaps.html
Never retries an ambiguous write. Subsequent attempts first query Store hashes.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urljoin, urlparse

from snap_publication import PublicationError, positive, require, write_json

BASE = "https://dashboard.snapcraft.io"
ENDPOINT = BASE + "/api/v2/snaps/motrix/releases"
READY = {"Published", "Unpublished"}


def list_revisions(get):
    url, seen, revisions = ENDPOINT + "?size=500", set(), {}
    for _ in range(100):
        require(url not in seen, "Store pagination loop")
        seen.add(url)
        data = get(url)
        require(data["snap"]["name"] == "motrix" and isinstance(data["revisions"], list),
                "Unexpected Store snapshot")
        for revision in data["revisions"]:
            identity = positive(revision["revision"])
            # Pagination may repeat revisions in overlapping release contexts.
            require(identity not in revisions or revisions[identity] == revision,
                    "Store changed during pagination")
            revisions[identity] = revision
        next_link = data["_links"].get("next")
        if not next_link:
            return list(revisions.values())
        url = urljoin(url, next_link)
        parsed = urlparse(url)
        require(parsed.scheme == "https" and parsed.netloc == "dashboard.snapcraft.io" and
                parsed.path == "/api/v2/snaps/motrix/releases" and not parsed.fragment,
                "Unsafe Store pagination link")
    raise PublicationError("Store pagination exceeded limit")


def matching_revision(revisions, digest, size, arch, version):
    matches = [r for r in revisions if r.get("sha3-384") == digest]
    require(len(matches) <= 1, "Ambiguous Store hash match")
    if not matches:
        return None
    revision = matches[0]
    require(revision["size"] == size and revision["architectures"] == [arch] and
            revision["version"] == version and revision["confinement"] == "strict" and
            revision["grade"] == "stable", "Store hash metadata mismatch")
    positive(revision["revision"])
    return revision


def reconcile(*, lookup, upload, save_state, sleep=time.sleep):
    """At most one write, even when upload succeeds remotely but loses its response."""
    revision = lookup()  # Read failure must prevent upload.
    if revision is not None:
        save_state({"state": "existing", "revision": positive(revision["revision"]),
                    "store_status": revision["status"]})
        require(revision["status"] in READY, "Existing revision requires Store review; do not reupload")
        return revision
    save_state({"state": "upload_started"})
    try:
        upload()
    except Exception:
        # The server may have accepted the bytes. Reconcile without another POST.
        save_state({"state": "upload_outcome_unknown"})
    for attempt in range(4):
        if attempt:
            sleep(10)
        try:
            revision = lookup()
        except Exception:
            continue
        if revision is not None:
            save_state({"state": "reconciled", "revision": positive(revision["revision"]),
                        "store_status": revision["status"]})
            require(revision["status"] in READY, "Uploaded revision requires Store review")
            return revision
    raise PublicationError("Upload unresolved; inspect Store processing before another attempt")


def store_getter():
    # Fail closed if the installed Snapcraft API changes. Never implement or log
    # macaroon handling ourselves, and never send credentials to pagination hosts.
    from snapcraft.store.client import get_client
    client = get_client(ephemeral=False)

    def get(url):
        try:
            response = client.request("GET", url, headers={"Accept": "application/json"},
                                      timeout=60, allow_redirects=False)
        except Exception as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            detail = str(status) if isinstance(status, int) else "unavailable"
            raise PublicationError(f"Store read failed (HTTP {detail})") from None
        require(response.status_code == 200, f"Store read failed (HTTP {response.status_code})")
        return response.json()
    return get


def identity(path):
    require(path.is_file() and not path.is_symlink(), "Missing regular Snap file")
    with path.open("rb") as payload:
        return hashlib.file_digest(payload, "sha3_384").hexdigest(), path.stat().st_size


def verify_before_release(get):
    proof = json.loads(Path("release/snap-provenance.json").read_text())
    revisions = json.loads(Path(os.environ["SNAP_REVISION_FILE"]).read_text())
    snapshot = list_revisions(get)
    for arch in ("amd64", "arm64"):
        receipt = proof["receipts"][arch]
        found = matching_revision(snapshot, receipt["sha3_384"], receipt["size"], arch,
                                  proof["source"]["version"])
        require(found is not None and found["status"] in READY and
                positive(found["revision"]) == revisions[arch], "Store receipt no longer releaseable")


def publication_architecture():
    # SNAP_ARCH belongs to snapd and describes the tooling snap's host, not
    # the package being published by a cross-architecture upload runner.
    arch = os.environ["MOTRIX_SNAP_ARCH"]
    require(arch in ("amd64", "arm64"), "Invalid architecture")
    return arch


def main():
    if sys.argv[1:] == ["check-client"]:
        # Exercise the real factory without credentials, network, or a host
        # keyring (headless runners may have no desktop secret service).
        import keyring
        from craft_store.auth import MemoryKeyring
        keyring.set_keyring(MemoryKeyring())
        store_getter()
        require(publication_architecture() == "arm64", "Publication architecture was overwritten")
        print("Snapcraft authenticated Store adapter initialization passed")
        return
    get = store_getter()
    if len(sys.argv) == 2 and sys.argv[1] == "verify":
        verify_before_release(get)
        return
    arch = publication_architecture()
    source = json.loads(os.environ["SNAP_SOURCE"])
    version = os.environ["EXPECTED_VERSION"]
    require(source["version"] == version, "Source version mismatch")
    path = Path(f"release/snap-verified/motrix_verified_{arch}.snap")
    digest, size = identity(path)
    state_path = Path("release/snap-upload-state.json")

    def lookup():
        return matching_revision(list_revisions(get), digest, size, arch, version)

    def upload():
        # Do not persist raw Snapcraft logs: they can contain authentication or
        # upload URLs. The durable state contains only fixed status and identity.
        subprocess.run(["/snap/bin/snapcraft", "upload", str(path)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=True, timeout=600)

    revision = reconcile(lookup=lookup, upload=upload,
                         save_state=lambda state: write_json(state_path, state))
    write_json(Path("release/snap-upload-receipt.json"), {
        "source": source, "publication_run_id": positive(os.environ["GITHUB_RUN_ID"]),
        "architecture": arch, "sha3_384": digest, "size": size,
        "revision": positive(revision["revision"]), "status": "verified",
    })
    print(f"Verified {arch} revision {positive(revision['revision'])} against original artifact hash")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Snap upload reconciliation stopped: {error if isinstance(error, PublicationError) else type(error).__name__}; inspect sanitized state", file=sys.stderr)
        sys.exit(1)
