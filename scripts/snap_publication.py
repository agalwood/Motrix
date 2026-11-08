#!/usr/bin/env python3
"""Authenticate original Snap artifacts and assemble resumable publication evidence.

Only GitHub-hosted artifacts from successful jobs of the exact tag build are
accepted. Recovery runs execute tools from protected main, never artifact code.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import zipfile

ARCHES = ("amd64", "arm64")


class PublicationError(ValueError):
    """A sanitized publication validation failure safe to expose in CI."""


def require(condition, message):
    if not condition:
        raise PublicationError(message)


def positive(value):
    require(re.fullmatch(r"[1-9][0-9]*", str(value)) is not None, "Invalid positive ID")
    return str(value)


def command(args):
    return subprocess.check_output(args, text=True, timeout=120).strip()


def api(repo, endpoint, pages=False):
    args = ["gh", "api", f"repos/{repo}/{endpoint}"]
    if pages:
        args += ["--paginate", "--slurp"]
    return json.loads(command(args))


def workflow_run(repo, run_id, workflow):
    run = api(repo, f"actions/runs/{positive(run_id)}")
    identity = api(repo, f"actions/workflows/{workflow}")
    require(run["path"] == f".github/workflows/{workflow}" and
            run["workflow_id"] == identity["id"] and
            run["head_repository"]["full_name"] == repo, "Untrusted source workflow")
    require(re.fullmatch(r"[0-9a-f]{40}", run["head_sha"]) is not None, "Invalid source SHA")
    return run


def check_ancestry(sha):
    command(["git", "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"])
    command(["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"])


def validate_source(run, jobs, artifacts, repo, version, tag_sha):
    require(run["event"] == "push" and run["head_branch"] == f"v{version}" and
            run["head_sha"] == tag_sha, "Source is not the requested release tag")
    require(any(j["name"] == "Validate Snap source" and j["conclusion"] == "success"
                for j in jobs), "Protected tag preflight did not succeed")
    chosen = {}
    for arch in ARCHES:
        matches = [a for a in artifacts if a["name"] == f"snap-input-{arch}"]
        require(len(matches) == 1, "Missing or ambiguous original artifact")
        a = matches[0]
        require(not a["expired"] and re.fullmatch(r"sha256:[0-9a-f]{64}", a.get("digest", "")),
                "Expired artifact or missing archive digest")
        require(a["workflow_run"]["id"] == run["id"] and
                a["workflow_run"]["head_sha"] == tag_sha, "Artifact source mismatch")
        matching_jobs = [j for j in jobs if j["name"] == f"Build Snap / {arch}" and
                         j["conclusion"] == "success" and
                         j["started_at"] <= a["created_at"] <= j["completed_at"]]
        # GitHub repeats successful jobs in later failed-job attempts. Bind the
        # original execution interval, not the carried-forward attempt number.
        require(len({(j["started_at"], j["completed_at"]) for j in matching_jobs}) == 1,
                "Artifact is not from a successful architecture build")
        chosen[arch] = {"id": positive(a["id"]), "digest": a["digest"],
                        "build_attempt": min(j["run_attempt"] for j in matching_jobs)}
    return {"repository": repo, "run_id": positive(run["id"]), "sha": tag_sha,
            "version": version, "artifacts": chosen}


def original_source(repo, run_id, version):
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-beta\.[1-9][0-9]*)?", version),
            "Invalid release version")
    run = workflow_run(repo, run_id, "snap.yml")
    check_ancestry(run["head_sha"])
    command(["git", "fetch", "--no-tags", "--force", "origin",
             f"refs/tags/v{version}:refs/remotes/origin/snap-recovery-tag"])
    tag_sha = command(["git", "rev-parse", "refs/remotes/origin/snap-recovery-tag^{commit}"])
    package = json.loads(command(["git", "show", f"{tag_sha}:package.json"]))
    require(package["version"] == version, "Tag package version mismatch")
    jobs = [j for page in api(repo, f"actions/runs/{run_id}/jobs?filter=all&per_page=100", True)
            for j in page["jobs"]]
    artifacts = [a for page in api(repo, f"actions/runs/{run_id}/artifacts?per_page=100", True)
                 for a in page["artifacts"]]
    return validate_source(run, jobs, artifacts, repo, version, tag_sha)


def archive(repo, artifact):
    """Authenticate the zip before interpreting any of its contents."""
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", artifact["digest"]), "Invalid archive digest")
    with tempfile.TemporaryFile() as target:
        subprocess.run(["gh", "api", f"repos/{repo}/actions/artifacts/{positive(artifact['id'])}/zip"],
                       stdout=target, check=True, timeout=300)
        target.seek(0)
        require("sha256:" + hashlib.file_digest(target, "sha256").hexdigest() == artifact["digest"],
                "GitHub artifact archive digest mismatch")
        target.seek(0)
        with zipfile.ZipFile(target) as zipped:
            result = {}
            for entry in zipped.infolist():
                p = PurePosixPath(entry.filename)
                require(not p.is_absolute() and ".." not in p.parts and
                        not stat.S_ISLNK(entry.external_attr >> 16), "Unsafe artifact entry")
                if entry.is_dir():
                    continue
                require(entry.file_size <= 1024 ** 3, "Oversized artifact entry")
                require(entry.filename not in result, "Duplicate artifact entry")
                result[entry.filename] = zipped.read(entry)
            return result


def download_snap(source, arch):
    files = archive(source["repository"], source["artifacts"][arch])
    snaps = [(name, data) for name, data in files.items() if name.endswith(".snap")]
    require(len(snaps) == 1 and snaps[0][0].endswith(f"_{arch}.snap"), "Invalid architecture artifact")
    target = Path(f"release/snap-verified/motrix_verified_{arch}.snap")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(snaps[0][1])
    return hashlib.sha3_384(snaps[0][1]).hexdigest(), len(snaps[0][1])


def artifact_json(repo, a, filename):
    files = archive(repo, a)
    require(filename in files, "Missing publication evidence")
    return json.loads(files[filename])


def validate_receipt(receipt, source, arch, run_id, digest, size):
    require(receipt["source"] == source and receipt["architecture"] == arch and
            receipt["publication_run_id"] == str(run_id) and
            receipt["sha3_384"] == digest and receipt["size"] == size and
            receipt["status"] == "verified", "Architecture receipt identity mismatch")
    return positive(receipt["revision"])


def aggregate(source, repo, run_id):
    artifacts = [a for page in api(repo, f"actions/runs/{run_id}/artifacts?per_page=100", True)
                 for a in page["artifacts"]]
    receipts, revisions = {}, {}
    for arch in ARCHES:
        pattern = rf"snap-upload-{run_id}-{arch}-([1-9][0-9]*)"
        candidates = [(int(m[1]), a) for a in artifacts
                      if (m := re.fullmatch(pattern, a["name"])) and not a["expired"]]
        require(candidates, "Missing successful architecture receipt")
        attempt, a = max(candidates, key=lambda pair: pair[0])
        require(attempt <= int(os.environ["GITHUB_RUN_ATTEMPT"]), "Future upload receipt")
        receipt = artifact_json(repo, a, "snap-upload-receipt.json")
        digest, size = download_snap(source, arch)
        revisions[arch] = validate_receipt(receipt, source, arch, run_id, digest, size)
        receipts[arch] = receipt
    require(len(set(revisions.values())) == 2, "Architectures share a revision")
    write_json(Path(os.environ["SNAP_REVISION_FILE"]), revisions)
    write_json(Path("release/snap-provenance.json"),
               {"source": source, "publication_run_id": run_id, "receipts": receipts})


def verify_recovery_promotion(repo, run_id, attempt, version):
    run = workflow_run(repo, run_id, "snap-publish.yml")
    require(run["event"] == "workflow_dispatch" and run["head_branch"] == "main" and
            run["status"] == "completed" and run["conclusion"] == "success" and
            str(run["run_attempt"]) == attempt, "Untrusted recovery publication")
    check_ancestry(run["head_sha"])
    artifacts = [a for page in api(repo, f"actions/runs/{run_id}/artifacts?per_page=100", True)
                 for a in page["artifacts"]]
    matches = [a for a in artifacts if a["name"] == f"snap-release-revisions-{attempt}" and not a["expired"]]
    require(len(matches) == 1, "Missing recovery provenance")
    files = archive(repo, matches[0])
    proof = json.loads(files["snap-provenance.json"])
    revisions = json.loads(files["motrix-snap-revisions.json"])
    source = original_source(repo, proof["source"]["run_id"], version)
    require(proof["source"] == source and proof["publication_run_id"] == run_id,
            "Recovery is not bound to original tag artifacts")
    require(set(revisions) == set(ARCHES) and len(set(revisions.values())) == 2,
            "Incomplete revision set")
    for arch in ARCHES:
        digest, size = download_snap(source, arch)
        revision = validate_receipt(proof["receipts"][arch], source, arch, run_id, digest, size)
        require(revisions[arch] == revision, "Recovery revision mismatch")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def main():
    repo = os.environ["GITHUB_REPOSITORY"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository")
    mode = sys.argv[1]
    if mode == "source":
        require(os.environ["RELEASE_REF_PROTECTED"] == "true", "Publication requires protected ref")
        event, ref = os.environ["GITHUB_EVENT_NAME"], os.environ["GITHUB_REF"]
        require((event == "push" and ref == "refs/tags/v" + os.environ["EXPECTED_VERSION"] and
                 os.environ["SOURCE_RUN_ID"] == os.environ["GITHUB_RUN_ID"]) or
                (event == "workflow_dispatch" and ref == "refs/heads/main"),
                "Publication requires exact protected tag or protected-main recovery")
        source = original_source(repo, positive(os.environ["SOURCE_RUN_ID"]), os.environ["EXPECTED_VERSION"])
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("source=" + json.dumps(source, sort_keys=True) + "\n")
    elif mode == "promotion":
        verify_recovery_promotion(repo, positive(os.environ["SOURCE_RUN_ID"]),
                                  positive(os.environ["SOURCE_RUN_ATTEMPT"]), os.environ["EXPECTED_VERSION"])
    else:
        source = json.loads(os.environ["SNAP_SOURCE"])
        require(source["repository"] == repo, "Repository mismatch")
        if mode == "download":
            arch = os.environ["MOTRIX_SNAP_ARCH"]
            require(arch in ARCHES, "Unknown architecture")
            download_snap(source, arch)
        elif mode == "aggregate":
            aggregate(source, repo, positive(os.environ["GITHUB_RUN_ID"]))
        else:
            raise ValueError("Unknown publication operation")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid printing subprocess output, HTTP bodies, or authentication state.
        print(f"Snap provenance verification failed: {error if isinstance(error, PublicationError) else type(error).__name__}", file=sys.stderr)
        sys.exit(1)
