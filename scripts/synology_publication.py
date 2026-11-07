#!/usr/bin/env python3
"""Verify both native SPKs and attach immutable assets to a protected stable release."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile

from nas_release import SHA, archive_file, preflight, run, source, stable_version, upload_verified_assets


def verify_payload(app, inventory):
    """Rehash actual tar members in the publish job without executing them."""
    seen, files, elf = set(), set(), {}
    total = 0
    for member in app:
        name = member.name.removeprefix('./')
        if name == '.' and member.isdir():
            continue
        path = PurePosixPath(name)
        if not name or path.is_absolute() or '..' in path.parts or str(path) != name or name in seen:
            raise ValueError('Unsafe or duplicate payload member')
        seen.add(name)
        if member.isdir():
            continue
        if not member.isfile() or member.mode & 0o7022:
            raise ValueError('Unsafe payload file')
        if name == 'payload-sha256.json':
            continue
        total += member.size
        if total > 512 * 1024 * 1024:
            raise ValueError('Oversized SPK payload')
        files.add(name)
        with app.extractfile(member) as stream:
            header = stream.read(4)
            digest = hashlib.sha256(header)
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        actual = digest.hexdigest()
        if inventory.get(name) != {'sha256': actual, 'executable': bool(member.mode & 0o111)}:
            raise ValueError('Payload inventory mismatch')
        if header == b'\x7fELF':
            elf[name] = actual
    if files != set(inventory):
        raise ValueError('Incomplete payload inventory')
    return elf


def verify_bundle(directory, version, sha):
    stable_version('v' + version)
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid source commit')
    lock = json.loads(run('git', 'show', f'{sha}:scripts/synology-runtime.lock.json'))
    node = json.loads(run('git', 'show', f'{sha}:scripts/fnos-runtime.lock.json'))
    rev = lock['revision']
    root = Path(directory)
    names = {arch: f'Motrix-{version}-{rev}-dsm-{arch}.spk' for arch in ['x64', 'arm64']}
    expected = {f + suffix for f in names.values() for suffix in ('', '.sha256', '.abi.json')}
    if {p.name for p in root.iterdir()} != expected or any(p.is_symlink() or not p.is_file() for p in root.iterdir()):
        raise ValueError('Both complete SPK/checksum/ABI sets of regular files are required')
    records = []
    for arch, name in names.items():
        path = root / name
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if (root / (name + '.sha256')).read_text() != f'{digest}  {name}\n':
            raise ValueError('SPK checksum mismatch')
        target = lock['targets'][arch]
        platforms = target['platforms']
        sdk = {key: profile['toolchain']['sha256'] for key, profile in platforms.items()}
        with tarfile.open(path) as outer:
            info = archive_file(outer, 'INFO', 65536).decode().splitlines()
            payload = archive_file(outer, 'package.tgz', 256 * 1024 * 1024)
        for key, value in {'package': 'Motrix', 'version': f'{version}-{rev}',
                           'os_min_ver': lock['dsmVersion'],
                           'arch': target.get('infoArch', ' '.join(platforms)),
                           'checksum': hashlib.md5(payload).hexdigest()}.items():
            if [line for line in info if line.startswith(key + '=')] != [f'{key}="{value}"']:
                raise ValueError(f'SPK INFO {key} mismatch')
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as app:
            receipt = json.loads(archive_file(app, 'synology-build.json', 65536))
            inventory = json.loads(archive_file(app, 'payload-sha256.json', 8 * 1024 * 1024))
            shipped_elf = verify_payload(app, inventory)
        required = dict(schemaVersion=2, architecture=arch, revision=rev, version=version, sourceCommit=sha,
                        sourceDirty=False, minimumDsm=lock['dsmVersion'], nodeArchiveSha256=node['node'][arch]['sha256'],
                        platforms=list(platforms), toolchainDigests=sdk)
        if any(receipt.get(k) != v for k, v in required.items()) or receipt.get('sourceDirty') is not False:
            raise ValueError('SPK source, runtime or architecture receipt mismatch')
        abi = json.loads((root / (name + '.abi.json')).read_text())
        if (abi.get('schemaVersion') != 3 or abi.get('spkSha256') != digest or abi.get('architecture') != arch
                or set(abi.get('platforms', {})) != set(platforms)):
            raise ValueError('ABI report does not cover this exact SPK')
        for platform, report in abi['platforms'].items():
            loaded = report['loaded']
            if (report['platform'] != platform or report['architecture'] != arch or report['toolchainSha256'] != sdk[platform]
                    or loaded != dict(arch=arch, glibc=lock['glibc'], node='v'+node['nodeVersion'], sqlite='read-write-ok')
                    or report.get('cpuEmulation') != target.get('cpu')):
                raise ValueError('DSM userspace or CPU validation mismatch')
            elf = {item['file']: item['sha256'] for item in report['elf']}
            required_elf = {'runtime/bin/node', 'server/bin/aria2c', 'server/bin/motrix-finalize-fs'}
            if (not required_elf <= elf.keys() or not any(f.endswith('.node') for f in elf)
                    or elf != shipped_elf or len(elf) != len(report['elf'])):
                raise ValueError('ABI evidence does not match the package inventory')
        records.append({'file': name, 'sha256': digest, 'arch': arch, 'platforms': list(platforms)})
    return records


def main():
    command, *args = sys.argv[1:]
    if command == 'preflight':
        values = preflight()
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            for key, value in values.items():
                output.write(f'{key}={value}\n')
        print(json.dumps(values))
    elif command == 'verify':
        print(json.dumps(verify_bundle(*args), indent=2))
    elif command == 'publish':
        directory, tag, sha, run_id = args
        current = source(tag, run_id)
        if current['source_sha'] != sha:
            raise ValueError('Release tag changed since preflight')
        records = verify_bundle(directory, current['version'], sha)
        upload_verified_assets(directory, tag)
        print(json.dumps({'source': current, 'packages': records}, indent=2))
    else:
        raise ValueError('Unsupported command')


if __name__ == '__main__':
    main()
