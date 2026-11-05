#!/usr/bin/env python3
"""Verify stable fnOS publication provenance and immutable release assets."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

REPOSITORY = 'agalwood/Motrix'
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def api(endpoint):
    return json.loads(run('gh', 'api', f'repos/{REPOSITORY}/{endpoint}'))


def stable_version(tag):
    if not isinstance(tag, str) or not tag.startswith('v') or not VERSION.fullmatch(tag[1:]):
        raise ValueError('fnOS publication requires a strict stable v<major.minor.patch> tag')
    return tag[1:]


def validate_run(value, tag, sha, workflow_id):
    if not (value.get('event') == 'push'
            and value.get('status') == 'completed'
            and value.get('conclusion') == 'success'
            and value.get('head_branch') == tag
            and value.get('head_sha') == sha
            and value.get('workflow_id') == workflow_id
            and value.get('path') == '.github/workflows/release.yml'
            and value.get('head_repository', {}).get('full_name') == REPOSITORY):
        raise ValueError('Missing successful protected-tag Build/Release provenance')


def validate_release(value, tag):
    if value.get('tag_name') != tag or value.get('draft') is not False or value.get('prerelease') is not False:
        raise ValueError('Target must be an existing public stable GitHub Release')


def source(tag, source_run_id=None):
    version = stable_version(tag)
    subprocess.run(['git', 'fetch', '--no-tags', 'origin',
                    'refs/heads/main:refs/remotes/origin/main'], check=True)
    subprocess.run(['git', 'fetch', '--no-tags', 'origin',
                    f'refs/tags/{tag}:refs/remotes/origin/fnos-source-tag'], check=True)
    sha = run('git', 'rev-parse', 'refs/remotes/origin/fnos-source-tag^{commit}')
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid source commit')
    subprocess.run(['git', 'merge-base', '--is-ancestor', sha, 'origin/main'], check=True)
    manifest = json.loads(run('git', 'show', f'{sha}:package.json'))
    if manifest.get('version') != version:
        raise ValueError('Tag and package version differ')
    workflow = api('actions/workflows/release.yml')
    if source_run_id:
        if not str(source_run_id).isdigit():
            raise ValueError('Invalid release workflow run ID')
        release_run = api(f'actions/runs/{source_run_id}')
        validate_run(release_run, tag, sha, workflow['id'])
    else:
        runs = api(f'actions/workflows/release.yml/runs?branch={tag}&event=push&status=success&per_page=100')['workflow_runs']
        release_run = None
        for candidate in runs:
            try:
                validate_run(candidate, tag, sha, workflow['id'])
                release_run = candidate
                break
            except ValueError:
                continue
        if release_run is None:
            raise ValueError('No successful formal release workflow for this exact tag and commit')
    validate_release(api(f'releases/tags/{tag}'), tag)
    return {'tag': tag, 'version': version, 'source_sha': sha,
            'release_run_id': str(release_run['id'])}


def preflight():
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise ValueError('Publication is restricted to the official repository')
    if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_REF_PROTECTED') != 'true':
        raise ValueError('Publication tooling must run from protected main')
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    event_name = os.environ.get('GITHUB_EVENT_NAME')
    if event_name == 'workflow_run':
        triggering_run = event['workflow_run']
        tag = triggering_run.get('head_branch', '')
        # Beta releases have no native fnOS package version.
        if re.fullmatch(r'v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-beta\.(?:0|[1-9][0-9]*)', tag):
            return {'publish': 'false'}
        result = source(tag, triggering_run['id'])
    elif event_name == 'workflow_dispatch':
        result = source(event.get('inputs', {}).get('release_tag', ''))
    else:
        raise ValueError('Unsupported publication trigger')
    return {'publish': 'true', **result}


def archive_file(archive, name, limit):
    matches = [m for m in archive.getmembers() if m.name.removeprefix('./') == name]
    if len(matches) != 1 or not matches[0].isfile() or not 0 < matches[0].size <= limit:
        raise ValueError(f'Invalid archive member: {name}')
    return archive.extractfile(matches[0]).read()


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
    release = api(f'releases/tags/{tag}')
    files = sorted(Path(directory).iterdir())
    # Preflight every collision before uploading anything. Never replace assets.
    missing = []
    for file in files:
        matches = [a for a in release['assets'] if a['name'] == file.name]
        if len(matches) > 1:
            raise ValueError('Duplicate existing release asset')
        if not matches:
            missing.append(file)
            continue
        asset = matches[0]
        digest = 'sha256:' + hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
        if asset.get('size') != file.stat().st_size or asset.get('digest') != digest:
            raise ValueError(f'Existing immutable release asset differs: {file.name}')
    if missing:
        subprocess.run(['gh', 'release', 'upload', tag, '--repo', REPOSITORY,
                        *map(str, missing)], check=True)
    published = api(f'releases/tags/{tag}')
    for file in files:
        asset = next(a for a in published['assets'] if a['name'] == file.name)
        digest = 'sha256:' + hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()
        if asset.get('digest') != digest or asset['size'] != file.stat().st_size:
            raise ValueError('Published fnOS asset digest or size mismatch')
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
