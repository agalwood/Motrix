#!/usr/bin/env python3
"""Safari direct distribution boundary. Standard library only; run with python3 -I.

The signer is loaded from the workflow commit, NEVER from the build artifact.
An input digest binds the handoff, not the safety of arbitrary application code.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
import zipfile

APP = 'Motrix Extension for Safari.app'
EXT = 'Contents/PlugIns/Motrix Extension for Safari Extension.appex'
APP_ID = 'app.motrix.safari'
EXT_ID = APP_ID + '.extension'
BINARIES = {
    'Contents/MacOS/Motrix Extension for Safari',
    EXT + '/Contents/MacOS/Motrix Extension for Safari Extension',
}
MAX_FILES = 6000
MAX_FILE = 40 * 1024 * 1024
MAX_TOTAL = 160 * 1024 * 1024
MAX_MANIFEST = 2 * 1024 * 1024
MACH = {bytes.fromhex(x) for x in ('feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca')}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def read_json(data):
    return json.loads(data, object_pairs_hook=unique_object)


def metadata(commit, version, build, team):
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Invalid source commit')
    require(re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version), 'Invalid version')
    require(all(int(x) <= 65535 for x in version.split('.')), 'Version exceeds manifest bounds')
    require(re.fullmatch(r'[1-9][0-9]{0,4}', build) and int(build) <= 65535, 'Invalid build number')
    require(re.fullmatch(r'[A-Z0-9]{10}', team), 'Invalid Team ID')
    return dict(schema=1, commit=commit, version=version, build=build, team=team)


def safe_path(name):
    require(isinstance(name, str) and 0 < len(name.encode('utf-8')) < 1024, 'Invalid path length')
    require('\\' not in name and ':' not in name and all(ord(c) >= 32 and ord(c) != 127 for c in name), 'Unsafe path')
    parts = name.split('/')
    require(all(p not in ('', '.', '..') and not p.endswith((' ', '.')) for p in parts), 'Unsafe path segment')
    require(not PurePosixPath(name).is_absolute(), 'Absolute path')
    return unicodedata.normalize('NFD', name).casefold()


def check_paths(names):
    seen = set()
    for name in names:
        normalized = safe_path(name)
        require(normalized not in seen, 'Duplicate or case/Unicode alias path')
        seen.add(normalized)
    for name in seen:
        require(not any('/'.join(name.split('/')[:i]) in seen for i in range(1, len(name.split('/')))), 'File/directory collision')


def ipc(team):
    return dict(TeamIdentifier=team, ClientBundleIdentifier=EXT_ID,
                ServiceBundleIdentifier='app.motrix.safari.bootstrap',
                AppGroupIdentifier=team + '.app.motrix.shared')


def validate_payload(files, meta):
    require(0 < len(files) <= MAX_FILES, 'Invalid file count')
    check_paths(files)
    total = 0
    for name, data in files.items():
        require(name.startswith('Contents/'), 'Unexpected app root content')
        require(len(data) <= MAX_FILE, 'Oversized file')
        total += len(data)
        require(total <= MAX_TOTAL, 'Oversized app')
        # This product has two executable code objects, no helpers or frameworks.
        parts = name.casefold().split('/')
        require(not any(p in ('_codesignature', 'frameworks', 'launchservices', 'launchagents', 'xpcservices') for p in parts), 'Unexpected nested code or signature')
        require(not name.casefold().endswith(('.provisionprofile', '.mobileprovision', '.entitlements', '.dylib', '.so')), 'Untrusted signing input')
        require(not name.startswith('Contents/PlugIns/') or name.startswith(EXT + '/'), 'Unexpected extension')
        require('/MacOS/' not in name or name in BINARIES, 'Unexpected executable')
        if data[:4] in MACH or data.startswith(b'#!'):
            require(name in BINARIES and data[:4] in MACH, 'Unexpected executable content')
        if name.endswith(('.js', '.html', '.map')):
            require(not name.endswith('.map'), 'Source map in release')
            require(not re.search(rb'sourceMappingURL|motrix\.safari\.featureProbe\.v1|safariNativeProbe|Motrix Native Verification|@vite/client', data), 'Development code in release')
        require(not name.endswith(('popup-preview.html', 'options-preview.html')), 'Preview in release')
    for binary in BINARIES:
        require(binary in files and files[binary][:4] in MACH, 'Missing Mach-O executable')
    for prefix, identifier, executable, package in (
        ('', APP_ID, 'Motrix Extension for Safari', 'APPL'),
        (EXT + '/', EXT_ID, 'Motrix Extension for Safari Extension', 'XPC!'),
    ):
        info = plistlib.loads(files[prefix + 'Contents/Info.plist'])
        for key, value in dict(CFBundleIdentifier=identifier, CFBundleExecutable=executable,
                               CFBundlePackageType=package, CFBundleShortVersionString=meta['version'],
                               CFBundleVersion=meta['build'], LSMinimumSystemVersion='13.0',
                               MotrixNotificationGroup=meta['team'] + '.app.motrix.shared',
                               MotrixNotificationDelivery='candidate').items():
            require(info.get(key) == value, 'Unexpected Info.plist field: ' + key)
        require(not any(k.startswith('DYLD_') for k in info), 'Dynamic loader override')
        require('LSEnvironment' not in info, 'Application environment override')
        if prefix:
            require(info.get('MotrixBootstrapIPC') == ipc(meta['team']), 'Unexpected IPC configuration')
            require(info.get('NSExtension', {}).get('NSExtensionPointIdentifier') == 'com.apple.Safari.web-extension', 'Unexpected extension point')
    web = EXT + '/Contents/Resources/'
    manifest = read_json(files[web + 'manifest.json'])
    require(manifest.get('name') == 'Motrix Extension', 'Unexpected extension name')
    require(manifest.get('version') == meta['version'] + '.' + meta['build'], 'Unexpected web version')
    require('nativeMessaging' in manifest.get('permissions', []), 'Missing nativeMessaging')
    require(manifest.get('background', {}).get('scripts') == ['native-worker.js'], 'Unexpected background entry')
    require(files[web + 'native-worker.js'] == b"import './service-worker-loader.js';\n", 'Unexpected native loader')
    require(files[web + 'native-probe.js'].strip() == b'export {}', 'Native probe must be inert')


def pack(app, output, meta):
    require(app.name == APP and app.is_dir() and not app.is_symlink(), 'Invalid app directory')
    files = {}
    total = 0
    for parent, dirs, names in os.walk(app, followlinks=False):
        for name in dirs + names:
            path = Path(parent) / name
            mode = path.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), 'Links and special files are forbidden')
        for name in names:
            path = Path(parent) / name
            require(path.stat().st_size <= MAX_FILE, 'Oversized file')
            total += path.stat().st_size
            require(total <= MAX_TOTAL and len(files) < MAX_FILES, 'App size or file count limit')
            files[path.relative_to(app).as_posix()] = path.read_bytes()
    validate_payload(files, meta)
    manifest = {**meta, 'files': {n: dict(sha256=sha(d), size=len(d)) for n, d in sorted(files.items())}}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, sort_keys=True))
        for name, data in sorted(files.items()):
            entry = zipfile.ZipInfo(APP + '/' + name)
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | (0o755 if name in BINARIES else 0o644)) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    return sha(output.read_bytes())


def verify(archive_path, expected_digest, meta, destination=None):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_digest), 'Invalid expected digest')
    require(archive_path.is_file() and not archive_path.is_symlink() and archive_path.stat().st_size <= MAX_TOTAL, 'Invalid archive')
    require(sha(archive_path.read_bytes()) == expected_digest, 'Artifact digest mismatch')
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        require(0 < len(entries) <= MAX_FILES + 1, 'Archive entry limit')
        check_paths([e.filename for e in entries])
        total = 0
        for entry in entries:
            require(entry.orig_filename == entry.filename, 'Noncanonical ZIP filename')
            require(not entry.is_dir() and not entry.flag_bits & 1, 'Directory or encrypted entry')
            require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported compression')
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG) and not mode & 0o7000, 'Link or special mode')
            limit = MAX_MANIFEST if entry.filename == 'manifest.json' else MAX_FILE
            require(0 <= entry.file_size <= limit, 'Archive file size limit')
            total += entry.file_size
            require(total <= MAX_TOTAL, 'Archive total size limit')
            require(entry.filename == 'manifest.json' or entry.filename.startswith(APP + '/'), 'Unexpected archive root')
        manifest = read_json(archive.read('manifest.json'))
        require(set(manifest) == set(meta) | {'files'}, 'Unexpected manifest fields')
        require({k: manifest[k] for k in meta} == meta, 'Provenance mismatch')
        files = {e.filename[len(APP) + 1:]: archive.read(e) for e in entries if e.filename != 'manifest.json'}
        require(manifest['files'] == {n: dict(sha256=sha(d), size=len(d)) for n, d in files.items()}, 'Incomplete or tampered file manifest')
        validate_payload(files, meta)
    if destination is not None:
        # Never use extractall: only validated regular files enter a fresh tree.
        destination.mkdir(mode=0o700, parents=False, exist_ok=False)
        app = destination / APP
        for name, data in files.items():
            path = app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as stream:
                stream.write(data)
            path.chmod(0o755 if name in BINARIES else 0o644)
        return app
    return manifest


def run(*args, timeout=180):
    # Never log argv: security/notarytool arguments may include secrets.
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise RuntimeError(Path(args[0]).name + ' could not complete') from None
    if result.returncode != 0:
        message = Path(args[0]).name + ' failed; exit ' + str(result.returncode)
        # Only codesign receives public paths/identity hashes, never credentials.
        # JSON escaping prevents diagnostic text from becoming workflow commands.
        if args[0] == '/usr/bin/codesign':
            message += '; diagnostic=' + json.dumps(result.stderr[:8192].decode('utf-8', errors='replace'))
        raise ValueError(message)
    return result.stdout


def inspect_macho(app):
    for name in BINARIES:
        binary = str(app / name)
        require(set(run('/usr/bin/lipo', '-archs', binary).decode().split()) == {'arm64', 'x86_64'}, 'Expected universal binary')
        for arch in ('arm64', 'x86_64'):
            linked = run('/usr/bin/otool', '-arch', arch, '-L', binary).decode().splitlines()[1:]
            for line in linked:
                library = line.strip().split(' (', 1)[0]
                require(library.startswith(('/usr/lib/', '/System/Library/')), 'Non-system dynamic library')
            commands = run('/usr/bin/otool', '-arch', arch, '-l', binary).decode()
            require('LC_DYLD_ENVIRONMENT' not in commands, 'Dynamic loader environment command')


def signing_entitlements(team):
    return {'com.apple.security.app-sandbox': True,
            'com.apple.security.network.client': True,
            'com.apple.security.application-groups': [team + '.app.motrix.shared']}


def verify_signature(app, team, entitlements):
    for path, identifier in ((app / EXT, EXT_ID), (app, APP_ID)):
        requirement = (f'=anchor apple generic and certificate leaf[subject.OU] = "{team}" '
                       f'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "{identifier}"')
        run('/usr/bin/codesign', '--verify', '--strict', '--all-architectures', '-R', requirement, str(path))
        for arch in ('arm64', 'x86_64'):
            actual = run('/usr/bin/codesign', '-d', '--arch', arch, '--entitlements', ':-', str(path))
            require(plistlib.loads(actual) == entitlements, 'Signed entitlements mismatch')
            details = subprocess.run(['/usr/bin/codesign', '-d', '--arch', arch, '--verbose=4', str(path)], capture_output=True, check=True).stderr.decode()
            require('runtime' in details and 'Timestamp=' in details, 'Missing hardened runtime or secure timestamp')
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', '--all-architectures', str(app))


def sign(archive, digest, meta, output):
    require(sys.platform == 'darwin', 'Signing requires macOS')
    require(not output.exists(), 'Output directory already exists')
    verify(archive, digest, meta)
    names = ('MAC_CERTS', 'MAC_CERTS_PASSWORD', 'API_KEY', 'API_KEY_ID', 'API_KEY_ISSUER_ID')
    credentials = {name: os.environ.pop(name, '') for name in names}
    require(all(credentials.values()), 'Missing signing or notarization credentials')
    require(re.fullmatch(r'[A-Z0-9]{10}', credentials['API_KEY_ID']), 'Invalid API key ID')
    require(re.fullmatch(r'[0-9a-fA-F-]{36}', credentials['API_KEY_ISSUER_ID']), 'Invalid API issuer')
    require(len(credentials['MAC_CERTS']) <= 192 * 1024 and len(credentials['API_KEY']) <= 16384, 'Credential size limit')
    require('-----BEGIN PRIVATE KEY-----' in credentials['API_KEY'], 'Invalid API key format')
    parent = os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix='safari-sign-', dir=parent) as temporary:
        work = Path(temporary)
        app = verify(archive, digest, meta, work / 'input')
        inspect_macho(app)
        p12 = work / 'certificate.p12'
        p12.write_bytes(base64.b64decode(''.join(credentials['MAC_CERTS'].split()), validate=True))
        p12.chmod(0o600)
        key = work / 'AuthKey.p8'
        key.write_text(credentials['API_KEY'])
        key.chmod(0o600)
        keychain = str(work / 'signing.keychain-db')
        password = secrets.token_hex(32)
        original_keychains = shlex.split(run('/usr/bin/security', 'list-keychains', '-d', 'user').decode())
        try:
            run('/usr/bin/security', 'create-keychain', '-p', password, keychain)
            run('/usr/bin/security', 'set-keychain-settings', '-lut', '7200', keychain)
            run('/usr/bin/security', 'unlock-keychain', '-p', password, keychain)
            run('/usr/bin/security', 'import', str(p12), '-P', credentials['MAC_CERTS_PASSWORD'], '-k', keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security')
            run('/usr/bin/security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain)
            # codesign also needs the private key and certificate chain discoverable.
            run('/usr/bin/security', 'list-keychains', '-d', 'user', '-s', keychain, *original_keychains)
            listing = run('/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning', keychain).decode()
            identities = re.findall(r'\b([A-Fa-f0-9]{40}) "Developer ID Application: [^"\n]+ \(' + meta['team'] + r'\)"', listing)
            require(len(identities) == 1, 'Expected one valid Developer ID Application identity for this team')
            entitlements = signing_entitlements(meta['team'])
            entitlement_file = work / 'entitlements.plist'
            entitlement_file.write_bytes(plistlib.dumps(entitlements))
            for bundle in (app / EXT, app):
                run('/usr/bin/codesign', '--force', '--sign', identities[0], '--keychain', keychain,
                    '--timestamp', '--options', 'runtime', '--generate-entitlement-der', '--entitlements', str(entitlement_file), str(bundle))
            verify_signature(app, meta['team'], entitlements)
            submission = work / 'submission.zip'
            run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(submission))
            auth = ('--key', str(key), '--key-id', credentials['API_KEY_ID'], '--issuer', credentials['API_KEY_ISSUER_ID'])
            result = read_json(run('/usr/bin/xcrun', 'notarytool', 'submit', str(submission), *auth, '--wait', '--timeout', '30m', '--output-format', 'json', timeout=1900))
            require(re.fullmatch(r'[0-9a-fA-F-]{36}', result.get('id', '')), 'Invalid notary submission ID')
            print('Notarization submission:', result['id'], 'status:', result.get('status'), flush=True)
            log = run('/usr/bin/xcrun', 'notarytool', 'log', result['id'], *auth)
            require(result.get('status') == 'Accepted', 'Notarization rejected; inspect submission ID with notarytool log')
            run('/usr/bin/xcrun', 'stapler', 'staple', str(app))
            run('/usr/bin/xcrun', 'stapler', 'validate', str(app))
            verify_signature(app, meta['team'], entitlements)
            run('/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=4', str(app))
            output.mkdir(parents=True)
            filename = f'motrix-extension-{meta["version"]}-safari-macos-universal.zip'
            final = output / filename
            run('/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(final))
            (output / 'SHA256SUMS-safari.txt').write_text(sha(final.read_bytes()) + '  ' + filename + '\n')
            (output / 'safari-release-receipt.json').write_text(json.dumps({**meta, 'input_sha256': digest, 'zip_sha256': sha(final.read_bytes()), 'notarization_id': result['id'], 'status': 'Accepted'}, indent=2) + '\n')
            (output / 'safari-notarization-log.json').write_bytes(log)
        finally:
            restored = subprocess.run(['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *original_keychains], capture_output=True, check=False)
            deleted = subprocess.run(['/usr/bin/security', 'delete-keychain', keychain], capture_output=True, check=False)
            require(restored.returncode == 0 and deleted.returncode == 0, 'Signing keychain cleanup failed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('pack', 'verify', 'sign'))
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--digest')
    parser.add_argument('--native', action='store_true', help='Inspect both Mach-O architectures before signing')
    for name in ('commit', 'version', 'build', 'team'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    meta = metadata(args.commit, args.version, args.build, args.team)
    if args.command == 'pack':
        require(args.output is not None, 'Missing output')
        print(pack(args.input, args.output, meta))
    elif args.command == 'verify':
        verify(args.input, args.digest or '', meta)
        if args.native:
            require(sys.platform == 'darwin', 'Native inspection requires macOS')
            with tempfile.TemporaryDirectory(prefix='safari-inspect-') as temporary:
                app = verify(args.input, args.digest or '', meta, Path(temporary) / 'input')
                inspect_macho(app)
        print('Verified Safari signing input')
    else:
        require(args.output is not None, 'Missing output')
        sign(args.input, args.digest or '', meta, args.output)


if __name__ == '__main__':
    main()
