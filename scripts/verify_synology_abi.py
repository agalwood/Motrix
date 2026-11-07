"""Inspect the final SPK ELF files, then run them against the target DSM sysroot."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=120, **kwargs)


def verify(app_dir, sdk_dir, arch, platform):
    lock = json.loads(Path(__file__).with_name('synology-runtime.lock.json').read_text())
    target = lock['targets'][arch]
    profile = target['platforms'][platform]
    app = Path(app_dir).resolve()
    sysroot = Path(sdk_dir).resolve() / target['sysroot']
    libraries = [sysroot / 'lib', sysroot / 'usr/lib']
    loader = sysroot / target['loader']
    loader_args = [str(loader), '--inhibit-cache', '--library-path', ':'.join(map(str, libraries))]
    emulator = ['qemu-aarch64', '-cpu', target['cpu']] if arch == 'arm64' else []
    files = []
    for file in sorted(app.rglob('*')):
        if not file.is_file():
            continue
        with file.open('rb') as stream:
            header = stream.read(20)
        if not header.startswith(b'\x7fELF'):
            continue
        if header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != target['machine']:
            raise ValueError('Foreign ELF: ' + str(file))
        # The cross SDK tools themselves may be x86 executables. Native GNU
        # readelf can inspect both targets without executing anything from the SDK.
        dynamic = run('readelf', '-d', str(file))
        needed = re.findall(r'\(NEEDED\).*\[([^\]]+)\]', dynamic)
        missing = [name for name in needed if not any((directory / name).is_file() for directory in libraries)]
        versions = run('readelf', '--version-info', str(file))
        required = set(re.findall(r'Name: ((?:GLIBC|GLIBCXX|CXXABI)_[\w.]+)', versions))
        if missing or 'RPATH' in dynamic or 'RUNPATH' in dynamic:
            raise ValueError(f'{file.name}: missing DSM libraries {missing} or embedded search paths')
        for soname, section in re.findall(r'File: (\S+).*?Cnt: \d+(.*?)(?=\n\s*0x[\da-f]+:\s+Version:|\Z)', versions, re.S):
            demands = set(re.findall(r'Name: ((?:GLIBC|GLIBCXX|CXXABI)_[\w.]+)', section))
            if not demands:
                continue
            library = next((directory / soname for directory in libraries if (directory / soname).is_file()), None)
            if not library:
                raise ValueError(f'{file.name}: missing DSM library {soname}')
            supplied = set(re.findall(r'Name: (\S+)', run('readelf', '--version-info', str(library))))
            if demands - supplied:
                raise ValueError(f'{file.name}: {soname} lacks {sorted(demands - supplied)}')
        files.append({'file': str(file.relative_to(app)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                      'needed': needed, 'versions': sorted(required)})
    by_name = {item['file']: item for item in files}
    entries = ['runtime/bin/node', 'server/bin/aria2c', 'server/bin/motrix-finalize-fs']
    if not all(name in by_name for name in entries) or not any(name.endswith('.node') for name in by_name):
        raise ValueError('Missing required runtime ELF or SQLite addon')

    def execute(name, *args):
        prefix = loader_args if by_name[name]['needed'] else []
        return run(*emulator, *prefix, str(app / name), *args, cwd=app, input='',
                   env={'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C'})

    code = """const DB=require('./server/node_modules/better-sqlite3');
const db=new DB(':memory:'); db.exec('create table t(v);insert into t values(42)');
if(db.prepare('select v from t').get().v!==42)process.exit(1);
console.log(JSON.stringify({node:process.version, arch:process.arch,
glibc:process.report.getReport().header.glibcVersionRuntime,sqlite:'read-write-ok'}));db.close()"""
    loaded = json.loads(execute(entries[0], '-e', code))
    if loaded['glibc'] != lock['glibc'] or loaded['arch'] != arch:
        raise ValueError('Node did not load the target DSM libc and SQLite')
    aria = execute(entries[1], '--version').splitlines()[0]
    execute(entries[2])
    return {'schemaVersion': 2, 'scope': f"DSM {lock['dsmVersion']} {platform} userspace on Linux host kernel",
            'platform': platform, 'toolchainSha256': profile['toolchain']['sha256'],
            'architecture': arch, 'cpuEmulation': target.get('cpu'), 'deviceAcceptance': 'not-run',
            'hostKernel': os.uname().release, 'loaded': loaded, 'aria2': aria, 'elf': files}


if __name__ == '__main__':
    app, sdk, output, arch, platform = sys.argv[1:]
    Path(output).write_text(json.dumps(verify(app, sdk, arch, platform), indent=2) + '\n')
