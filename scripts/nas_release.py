"""Shared stable-tag provenance and immutable GitHub asset upload for NAS packages."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = 'agalwood/Motrix'
VERSION = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def api(endpoint):
    return json.loads(run('gh', 'api', f'repos/{REPOSITORY}/{endpoint}'))


def stable_version(tag):
    if not isinstance(tag, str) or not tag.startswith('v') or not VERSION.fullmatch(tag[1:]):
        raise ValueError('NAS package publication requires a strict stable v<major.minor.patch> tag')
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
                    f'refs/tags/{tag}:refs/remotes/origin/nas-source-tag'], check=True)
    sha = run('git', 'rev-parse', 'refs/remotes/origin/nas-source-tag^{commit}')
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
        # Native NAS packages currently use stable application versions.
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


def upload_verified_assets(directory, tag):
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
            raise ValueError('Published release asset digest or size mismatch')
