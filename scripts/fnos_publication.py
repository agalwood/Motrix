#!/usr/bin/env python3
"""Verify stable fnOS publication provenance and immutable release assets."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

from nas_release import (
    REPOSITORY, archive_file, preflight, source, stable_version, upload_verified_assets,
    validate_release, validate_run,
)


def verify_bundle(directory, version):
    stable_version('v' + version)
    root = Path(directory)
    expected = {f'Motrix-{version}-fnos-{arch}.fpk{suffix}'
                for arch in ['x64', 'arm64'] for suffix in ['', '.sha256']}
    if {p.name for p in root.iterdir()} != expected:
        raise ValueError('Both exact architecture packages and checksums are required')
    results = []
    for arch, platform in [('x64', 'x86'), ('arm64', 'arm')]:
        name = f'Motrix-{version}-fnos-{arch}.fpk'
        package = root / name
        checksum = root / (name + '.sha256')
        if any(p.is_symlink() or not p.is_file() for p in [package, checksum]):
            raise ValueError('Release assets must be regular files')
        digest = hashlib.file_digest(package.open('rb'), 'sha256').hexdigest()
        if checksum.read_text() != f'{digest}  {name}\n':
            raise ValueError('FPK checksum mismatch')
        # Read only bounded regular members; never extract archive paths to disk.
        with tarfile.open(package) as archive:
            manifest = dict(tuple(part.strip() for part in line.split('=', 1)) for line in archive_file(archive, 'manifest', 65536).decode().splitlines() if '=' in line)
            if manifest.get('appname') != 'motrix' or manifest.get('version') != version or manifest.get('platform') != platform:
                raise ValueError('FPK manifest version or architecture mismatch')
            payload = archive_file(archive, 'app.tgz', 1024 ** 3)
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            receipt = json.loads(archive_file(archive, 'fnos-build.json', 65536))
            server = json.loads(archive_file(archive, 'server/package.json', 65536))
        if not (receipt.get('schemaVersion') == 2 and receipt.get('version') == version
                and receipt.get('packageVersion') == version and receipt.get('revision') == 0
                and receipt.get('arch') == arch and server.get('version') == version):
            raise ValueError('FPK build receipt differs from the approved version')
        results.append({'file': name, 'sha256': digest, 'arch': arch})
    return results


def publish(directory, tag, sha, release_run_id):
    current = source(tag, release_run_id)
    if current['source_sha'] != sha:
        raise ValueError('Release tag changed since build preflight')
    records = verify_bundle(directory, current['version'])
    upload_verified_assets(directory, tag)
    print(json.dumps({'source': current, 'packages': records}, indent=2))


def main():
    command = sys.argv[1]
    if command == 'preflight':
        outputs = preflight()
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key, value in outputs.items():
                output.write(f'{key}={value}\n')
        print(json.dumps(outputs))
    elif command == 'verify':
        print(json.dumps(verify_bundle(sys.argv[2], sys.argv[3])))
    elif command == 'publish':
        publish(*sys.argv[2:])
    else:
        raise ValueError('Unsupported command')


if __name__ == '__main__':
    main()
