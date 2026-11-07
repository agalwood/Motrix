#!/usr/bin/env python3
"""Verify both native SPKs and attach immutable assets to a protected stable release."""
from functools import lru_cache
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import subprocess
import tarfile

from nas_release import SHA, preflight, run, source, stable_version, upload_verified_assets


@lru_cache(maxsize=2)
def package_templates(sha):
    """Read DSM-controlled files from the approved Git tree, independent of the SPK."""
    prefix = 'packaging/synology/'
    entries = subprocess.check_output(['git', 'ls-tree', '-rz', sha, '--', prefix, 'LICENSE'])
    result = {}
    for entry in entries.split(b'\0'):
        if not entry:
            continue
        meta, raw_name = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        name = raw_name.decode().removeprefix(prefix)
        if name in ('README.md', 'README.zh-CN.md'):
            continue
        if kind != 'blob' or mode not in ('100644', '100755'):
            raise ValueError('Unsafe DSM template in source tree')
        result[name] = (subprocess.check_output(['git', 'cat-file', 'blob', oid]), mode == '100755')
    return result


def member_name(member, seen):
    name = member.name.removeprefix('./')
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or '..' in path.parts or str(path) != name or name in seen
            or member.mode & 0o7022 or not (member.isfile() or member.isdir())):
        raise ValueError('Unsafe or duplicate SPK member')
    seen.add(name)
    if len(seen) > 50000:
        raise ValueError('Too many SPK members')
    return name


def render_info(template, version, rev, arch, payload):
    for key, value in {'VERSION': version, 'REVISION': str(rev), 'ARCH': arch,
                       'CHECKSUM': hashlib.md5(payload).hexdigest()}.items():
        template = template.replace(f'@{key}@'.encode(), value.encode())
    return template


def verify_outer(package, templates, version, rev, arch):
    expected = {k: v for k, v in templates.items() if not k.startswith('app/')}
    directories = {str(parent) for name in expected for parent in PurePosixPath(name).parents}
    seen = set()
    info = payload = None
    with tarfile.open(package, 'r|*') as outer:
        for member in outer:
            name = member_name(member, seen)
            if member.isdir() and name in directories:
                continue
            if not member.isfile():
                raise ValueError('Unexpected SPK directory')
            if name == 'package.tgz' and 0 < member.size <= 256 * 1024 * 1024 and not member.mode & 0o111:
                payload = outer.extractfile(member).read()
            elif name == 'INFO' and member.size <= 65536 and not member.mode & 0o111:
                info = outer.extractfile(member).read()
            elif name in expected:
                blob, executable = expected[name]
                if (member.size != len(blob) or bool(member.mode & 0o111) != executable
                        or outer.extractfile(member).read() != blob):
                    raise ValueError(f'SPK template differs from release source: {name}')
            else:
                raise ValueError(f'Unexpected SPK member: {name}')
    if not expected.keys() <= seen or payload is None or info != render_info(expected['INFO'][0], version, rev, arch, payload):
        raise ValueError('Missing source template or incorrect SPK INFO')
    return payload


def verify_payload(payload, templates, machine):
    """Stream members once, checking bounds before reading or skipping their data."""
    seen, files, elf = set(), {}, {}
    static = {k.removeprefix('app/'): v for k, v in templates.items() if k.startswith('app/')}
    total = 0
    inventory = receipt = None
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r|gz') as app:
        for member in app:
            name = member_name(member, seen)
            if member.isdir():
                continue
            total += member.size
            if total > 512 * 1024 * 1024:
                raise ValueError('Oversized SPK payload')
            with app.extractfile(member) as stream:
                if name == 'payload-sha256.json':
                    if member.size > 8 * 1024 * 1024:
                        raise ValueError('Oversized SPK inventory')
                    inventory = json.load(stream)
                    continue
                header = stream.read(20)
                digest = hashlib.sha256(header)
                if name == 'synology-build.json':
                    if member.size > 65536:
                        raise ValueError('Oversized SPK build receipt')
                    tail = stream.read()
                    receipt = json.loads(header + tail)
                    digest.update(tail)
                else:
                    for block in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(block)
                actual = digest.hexdigest()
                executable = bool(member.mode & 0o111)
                files[name] = {'sha256': actual, 'executable': executable}
                if name in static:
                    blob, expected_mode = static[name]
                    if actual != hashlib.sha256(blob).hexdigest() or executable != expected_mode:
                        raise ValueError(f'SPK app template differs from release source: {name}')
                if header.startswith(b'\x7fELF'):
                    if len(header) < 20 or header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != machine:
                        raise ValueError('Foreign ELF in SPK payload')
                    elf[name] = actual
    if inventory != files or not static.keys() <= files.keys() or receipt is None:
        raise ValueError('Payload inventory mismatch')
    return receipt, elf


def verify_bundle(directory, version, sha):
    stable_version('v' + version)
    if not SHA.fullmatch(sha):
        raise ValueError('Invalid source commit')
    lock = json.loads(run('git', 'show', f'{sha}:scripts/synology-runtime.lock.json'))
    node = json.loads(run('git', 'show', f'{sha}:scripts/fnos-runtime.lock.json'))
    engines = json.loads(run('git', 'show', f'{sha}:scripts/engine.lock.json'))['assets']
    templates = package_templates(sha)
    rev = lock['revision']
    root = Path(directory)
    names = {arch: f'Motrix-{version}-{rev}-dsm-{arch}.spk' for arch in ['x64', 'arm64']}
    expected = {f + suffix for f in names.values() for suffix in ('', '.sha256', '.abi.json')}
    if {p.name for p in root.iterdir()} != expected or any(p.is_symlink() or not p.is_file() for p in root.iterdir()):
        raise ValueError('Both complete SPK/checksum/ABI sets of regular files are required')
    records = []
    for arch, name in names.items():
        path = root / name
        if path.stat().st_size > 300 * 1024 * 1024:
            raise ValueError('Oversized SPK')
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if (root / (name + '.sha256')).read_text() != f'{digest}  {name}\n':
            raise ValueError('SPK checksum mismatch')
        target = lock['targets'][arch]
        platforms = target['platforms']
        sdk = {key: profile['toolchain']['sha256'] for key, profile in platforms.items()}
        payload = verify_outer(path, templates, version, rev, target.get('infoArch', ' '.join(platforms)))
        receipt, shipped_elf = verify_payload(payload, templates, target['machine'])
        node_digest = node['node'][arch].get('binarySha256')
        if ((rev >= 13 and not node_digest) or (node_digest and shipped_elf.get('runtime/bin/node') != node_digest)
                or shipped_elf.get('server/bin/aria2c') != engines[f'linux-{arch}']['binarySha256']):
            raise ValueError('SPK binary differs from the release lock')
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
