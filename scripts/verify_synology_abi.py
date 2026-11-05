"""Check every shipped ELF against the pinned DSM sysroot, then load Node/SQLite.

This is a DSM userspace ABI check on a Linux host kernel, not DSM device acceptance.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=60, **kwargs)


def verify(app_dir, sdk_dir):
    app = pathlib.Path(app_dir).resolve()
    sdk = pathlib.Path(sdk_dir).resolve()
    sysroot = sdk / 'x86_64-pc-linux-gnu/sys-root'
    readelf = str(sdk / 'bin/x86_64-pc-linux-gnu-readelf')
    libraries = [sysroot / 'lib', sysroot / 'usr/lib']
    versions = set()
    for directory in libraries:
        for library in directory.glob('*.so*'):
            if library.is_file() and library.open('rb').read(4) == b'\x7fELF':
                versions.update(re.findall(r'Name: ((?:GLIBC|GLIBCXX|CXXABI)_[\w.]+)', run(readelf, '--version-info', str(library))))
    results = []
    for file in sorted(app.rglob('*')):
        if not file.is_file() or file.open('rb').read(4) != b'\x7fELF':
            continue
        header = file.open('rb').read(20)
        if header[4:6] != b'\x02\x01' or int.from_bytes(header[18:20], 'little') != 62:
            raise ValueError('Foreign ELF: ' + str(file))
        dynamic = run(readelf, '-d', str(file))
        needed = re.findall(r'\(NEEDED\).*\[([^\]]+)\]', dynamic)
        missing = [name for name in needed if not any((directory / name).is_file() for directory in libraries)]
        required = set(re.findall(r'Name: ((?:GLIBC|GLIBCXX|CXXABI)_[\w.]+)', run(readelf, '--version-info', str(file))))
        if missing or required - versions:
            raise ValueError(f'{file.name}: missing libraries {missing}, versions {sorted(required - versions)}')
        if 'RPATH' in dynamic or 'RUNPATH' in dynamic:
            raise ValueError('Unexpected ELF search path: ' + str(file))
        results.append({'file': str(file.relative_to(app)), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'needed': needed, 'versions': sorted(required)})
    loader = sysroot / 'lib/ld-linux-x86-64.so.2'
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'LANG': 'C'}
    code = "const DB=require('./server/node_modules/better-sqlite3'); const db=new DB(':memory:'); db.exec('create table t(v);insert into t values(42)'); if(db.prepare('select v from t').get().v!==42)process.exit(1); console.log(JSON.stringify({node:process.version,glibc:process.report.getReport().header.glibcVersionRuntime,sqlite:'read-write-ok'})); db.close()"
    loaded = json.loads(run(str(loader), '--inhibit-cache', '--library-path', ':'.join(map(str, libraries)), str(app / 'runtime/bin/node'), '-e', code, cwd=app, env=env))
    if loaded['glibc'] != '2.36':
        raise ValueError('Node did not use the DSM sysroot libc')
    aria = run(str(app / 'server/bin/aria2c'), '--version', env=env).splitlines()[0]
    return {'schemaVersion': 1, 'scope': 'DSM 7.2.2 Gemini Lake userspace on Linux host kernel', 'deviceAcceptance': 'not-run', 'hostKernel': os.uname().release, 'loaded': loaded, 'aria2': aria, 'elf': results}


if __name__ == '__main__':
    pathlib.Path(sys.argv[3]).write_text(json.dumps(verify(sys.argv[1], sys.argv[2]), indent=2) + '\n')
