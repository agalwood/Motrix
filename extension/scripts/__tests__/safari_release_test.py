#!/usr/bin/env python3
"""Adversarial tests of the data-only Safari signing boundary."""
import copy
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('safari_release', Path(__file__).resolve().parents[1] / 'safari-release.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
META = s.metadata('a' * 40, '0.1.14', '22', '7VMB56CA56')


def fixture():
    files = {name: bytes.fromhex('cafebabe') + b'fixture' for name in s.BINARIES}
    for prefix, identifier, executable, kind in (
        ('', s.APP_ID, 'Motrix Extension for Safari', 'APPL'),
        (s.EXT + '/', s.EXT_ID, 'Motrix Extension for Safari Extension', 'XPC!'),
    ):
        info = dict(CFBundleIdentifier=identifier, CFBundleExecutable=executable,
                    CFBundlePackageType=kind, CFBundleShortVersionString=META['version'],
                    CFBundleVersion=META['build'], LSMinimumSystemVersion='13.0',
                    MotrixNotificationGroup=META['team'] + '.app.motrix.shared', MotrixNotificationDelivery='candidate')
        if prefix:
            info.update(MotrixBootstrapIPC=s.ipc(META['team']), NSExtension={'NSExtensionPointIdentifier': 'com.apple.Safari.web-extension'})
        files[prefix + 'Contents/Info.plist'] = plistlib.dumps(info)
    web = s.EXT + '/Contents/Resources/'
    files[web + 'manifest.json'] = json.dumps(dict(name='Motrix Extension', version='0.1.14.22', permissions=['nativeMessaging'], background={'scripts': ['native-worker.js']})).encode()
    files[web + 'native-worker.js'] = b"import './service-worker-loader.js';\n"
    files[web + 'native-probe.js'] = b'export {}\n'
    return files


class SigningBoundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.app = self.root / s.APP
        self.files = fixture()
        for name, data in self.files.items():
            path = self.app / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.archive = self.root / 'input.zip'
        self.digest = s.pack(self.app, self.archive, META)

    def tearDown(self):
        self.tmp.cleanup()

    def rewrite(self, mutate):
        with zipfile.ZipFile(self.archive) as source:
            entries = [(e, source.read(e)) for e in source.infolist()]
        mutate(entries)
        with zipfile.ZipFile(self.archive, 'w') as dest:
            for e, data in entries:
                dest.writestr(e, data)
        return s.sha(self.archive.read_bytes())

    def test_roundtrip_and_restored_modes(self):
        app = s.verify(self.archive, self.digest, META, self.root / 'verified')
        for name, data in self.files.items():
            self.assertEqual((app / name).read_bytes(), data)
            self.assertEqual(stat.S_IMODE((app / name).stat().st_mode), 0o755 if name in s.BINARIES else 0o644)

    def test_refuses_existing_destination(self):
        with self.assertRaises(FileExistsError):
            s.verify(self.archive, self.digest, META, self.root)

    def test_digest_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            s.verify(self.archive, '0' * 64, META)

    def test_source_version_build_team_bound(self):
        for key, value in [('commit', 'b' * 40), ('version', '0.1.15'), ('build', '23'), ('team', 'AAAAAAAAAA')]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Provenance'):
                s.verify(self.archive, self.digest, {**META, key: value})

    def test_bad_metadata(self):
        for key, value in [('commit', '$(id)'), ('version', '1.2.3\n'), ('build', '01'), ('build', '65536'), ('team', '7VMB56CA56\n')]:
            args = {k: META[k] for k in ('commit', 'version', 'build', 'team')}
            args[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                s.metadata(**args)

    def test_traversal_and_aliases(self):
        for name in ('../escape', '/tmp/escape', 'a/../../b', 'a//b', 'a/./b', 'a\\b', 'a:b', 'a\x00b', 'a/..', 'a/file.'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                s.safe_path(name)
        for names in (['A', 'a'], ['caf\u00e9', 'cafe\u0301'], ['a', 'a/b'], ['x', 'x']):
            with self.subTest(names=names), self.assertRaises(ValueError):
                s.check_paths(names)

    def test_zip_traversal_rejected_before_extract(self):
        digest = self.rewrite(lambda entries: entries.append((zipfile.ZipInfo(s.APP + '/../escape'), b'bad')))
        with self.assertRaises(ValueError):
            s.verify(self.archive, digest, META, self.root / 'verified')
        self.assertFalse((self.root / 'verified').exists())

    def test_symlink_zip_rejected(self):
        def mutate(entries):
            entries[1][0].external_attr = (stat.S_IFLNK | 0o777) << 16
        digest = self.rewrite(mutate)
        with self.assertRaisesRegex(ValueError, 'special mode'):
            s.verify(self.archive, digest, META)

    def test_manifest_and_file_tampering(self):
        def mutate(entries):
            entry, data = entries[-1]
            entries[-1] = (entry, data + b'tamper')
        digest = self.rewrite(mutate)
        with self.assertRaisesRegex(ValueError, 'tampered'):
            s.verify(self.archive, digest, META)

    def test_missing_file(self):
        digest = self.rewrite(lambda entries: entries.pop())
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            s.verify(self.archive, digest, META)

    def test_extra_root(self):
        digest = self.rewrite(lambda entries: entries.append((zipfile.ZipInfo('sign.py'), b'bad')))
        with self.assertRaisesRegex(ValueError, 'root'):
            s.verify(self.archive, digest, META)

    def test_no_duplicate_json_keys(self):
        with self.assertRaises(ValueError):
            s.read_json(b'{"team":"expected","team":"forged"}')

    def test_pack_rejects_local_symlink(self):
        (self.app / 'Contents/link').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'Links'):
            s.pack(self.app, self.root / 'bad.zip', META)

    def test_extra_code_and_signing_policy(self):
        for name, data in (
            ('Contents/Frameworks/evil', b'bad'),
            ('Contents/frameworks/evil', b'bad'),
            ('Contents/LaunchAgents/evil.plist', b'bad'),
            ('Contents/Resources/evil', bytes.fromhex('feedfacf')),
            ('Contents/Resources/script', b'#!/bin/sh\n'),
            ('Contents/MacOS/helper', b'bad'),
            ('Contents/PlugIns/Other.appex/data', b'bad'),
            ('Contents/embedded.provisionprofile', b'bad'),
            ('Contents/embedded.PROVISIONPROFILE', b'bad'),
            ('Contents/policy.entitlements', b'bad'),
            ('Contents/Resources/test.js.map', b'{}'),
            ('Contents/Resources/test.js', b'safariNativeProbe'),
            ('Contents/Resources/options-preview.html', b'preview'),
        ):
            with self.subTest(name=name), self.assertRaises(ValueError):
                s.validate_payload({**self.files, name: data}, META)

    def test_modified_bundle_identity_or_loader_environment(self):
        for key, value in [('CFBundleExecutable', '../../helper'), ('CFBundleIdentifier', 'evil'), ('LSEnvironment', {'DYLD_INSERT_LIBRARIES': '/tmp/evil'})]:
            files = copy.copy(self.files)
            info = plistlib.loads(files['Contents/Info.plist'])
            info[key] = value
            files['Contents/Info.plist'] = plistlib.dumps(info)
            with self.subTest(key=key), self.assertRaises(ValueError):
                s.validate_payload(files, META)

    def test_ipc_team_cannot_be_forged(self):
        files = copy.copy(self.files)
        path = s.EXT + '/Contents/Info.plist'
        info = plistlib.loads(files[path])
        info['MotrixBootstrapIPC']['TeamIdentifier'] = 'AAAAAAAAAA'
        files[path] = plistlib.dumps(info)
        with self.assertRaisesRegex(ValueError, 'IPC'):
            s.validate_payload(files, META)

    def test_native_probe_cannot_be_reenabled(self):
        files = copy.copy(self.files)
        files[s.EXT + '/Contents/Resources/native-probe.js'] = b'console.log(1)'
        with self.assertRaisesRegex(ValueError, 'inert'):
            s.validate_payload(files, META)

    def test_archive_size_limits(self):
        with patch.object(s, 'MAX_FILE', 1), self.assertRaisesRegex(ValueError, 'size limit'):
            s.verify(self.archive, self.digest, META)
        with patch.object(s, 'MAX_FILES', 1), self.assertRaisesRegex(ValueError, 'entry limit'):
            s.verify(self.archive, self.digest, META)

    def test_entitlements_are_fixed_not_artifact_controlled(self):
        entitlements = s.signing_entitlements(META['team'])
        self.assertEqual(set(entitlements), {'com.apple.security.app-sandbox', 'com.apple.security.network.client', 'com.apple.security.application-groups'})
        self.assertEqual(entitlements['com.apple.security.application-groups'], ['7VMB56CA56.app.motrix.shared'])

    def test_invalid_artifact_never_reaches_security_tool(self):
        with patch.object(s.sys, 'platform', 'darwin'), patch.object(s, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                s.sign(self.archive, '0' * 64, META, self.root / 'output')
            command.assert_not_called()

    def test_timeout_does_not_disclose_secret_argv(self):
        command = ['/usr/bin/security', 'import', '-P', 'private-test-password']
        with patch.object(s.subprocess, 'run', side_effect=subprocess.TimeoutExpired(command, 1)):
            with self.assertRaises(RuntimeError) as error:
                s.run(*command)
            self.assertNotIn('private-test-password', str(error.exception))
            self.assertTrue(error.exception.__suppress_context__)

    def test_codesign_failure_has_bounded_escaped_diagnostic(self):
        diagnostic = b'errSecInternalComponent\n::warning::untrusted' + b'x' * 9000
        with patch.object(s.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', diagnostic)):
            with self.assertRaises(ValueError) as error:
                s.run('/usr/bin/codesign', '--sign', 'public-identity', 'app')
            self.assertIn('errSecInternalComponent', str(error.exception))
            self.assertNotIn('\n', str(error.exception))
            self.assertLess(len(str(error.exception)), 8400)

    def test_credential_tool_failure_never_discloses_output_or_argv(self):
        secret = b'private-test-password'
        with patch.object(s.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, secret, secret)):
            with self.assertRaises(ValueError) as error:
                s.run('/usr/bin/security', 'import', '-P', secret.decode())
            self.assertNotIn(secret.decode(), str(error.exception))

    def test_codesign_failure_restores_keychain_search_list(self):
        self.exercise_signer('--sign')

    def exercise_signer(self, fail_at=None):
        calls = []
        def command(*args, **kwargs):
            calls.append(args)
            if fail_at and fail_at in args:
                raise ValueError('Injected failure')
            if args == ('/usr/bin/security', 'list-keychains', '-d', 'user'):
                return b'    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/tmp/with space.keychain-db"\n'
            if 'find-identity' in args:
                return ('1) ' + 'B' * 40 + ' "Developer ID Application: Test (7VMB56CA56)"').encode()
            if args[0] == '/usr/bin/ditto':
                Path(args[-1]).write_bytes(b'zip fixture')
            if 'submit' in args:
                return json.dumps(dict(id='11111111-1111-1111-1111-111111111111', status='Accepted')).encode()
            if 'log' in args:
                return b'{"status":"Accepted"}'
            return b''
        credentials = dict(MAC_CERTS='dGVzdA==', MAC_CERTS_PASSWORD='fixture-password', API_KEY='-----BEGIN PRIVATE KEY-----\nfixture', API_KEY_ID='ABCDEFGHIJ', API_KEY_ISSUER_ID='11111111-1111-1111-1111-111111111111', RUNNER_TEMP=str(self.root))
        with patch.dict(s.os.environ, credentials), patch.object(s.sys, 'platform', 'darwin'), patch.object(s, 'inspect_macho'), patch.object(s, 'verify_signature'), patch.object(s, 'run', side_effect=command), patch.object(s.subprocess, 'run') as cleanup:
            cleanup.return_value = subprocess.CompletedProcess([], 0)
            if fail_at:
                with self.assertRaisesRegex(ValueError, 'Injected failure'):
                    s.sign(self.archive, self.digest, META, self.root / 'signed')
                self.assertFalse((self.root / 'signed').exists())
            else:
                s.sign(self.archive, self.digest, META, self.root / 'signed')
                receipt = json.loads((self.root / 'signed/safari-release-receipt.json').read_text())
                self.assertEqual(receipt['input_sha256'], self.digest)
                self.assertEqual(receipt['status'], 'Accepted')
            self.assertEqual(cleanup.call_args_list[-2].args[0], ['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db', '/tmp/with space.keychain-db'])
            self.assertEqual(cleanup.call_args_list[-1].args[0][1], 'delete-keychain')
        self.assertFalse(list(self.root.glob('safari-sign-*')))
        return calls

    def test_successful_signing_orders_nested_signing_stapling_and_final_zip(self):
        calls = self.exercise_signer()
        signed = [a[-1] for a in calls if a[0] == '/usr/bin/codesign']
        self.assertTrue(signed[0].endswith('.appex'))
        self.assertTrue(signed[1].endswith('.app'))
        configured = next(i for i, a in enumerate(calls) if 'list-keychains' in a and '-s' in a)
        first_sign = next(i for i, a in enumerate(calls) if a[0] == '/usr/bin/codesign')
        self.assertLess(configured, first_sign)
        self.assertEqual(calls[configured][-2:], ('/Users/runner/Library/Keychains/login.keychain-db', '/tmp/with space.keychain-db'))
        stapled = next(i for i, a in enumerate(calls) if 'staple' in a)
        last_zip = max(i for i, a in enumerate(calls) if a[0] == '/usr/bin/ditto')
        self.assertLess(stapled, last_zip)

    def test_signing_failure_removes_keychain_and_exports_nothing(self):
        self.exercise_signer('import')

    def test_notary_failure_removes_keychain_and_exports_nothing(self):
        self.exercise_signer('submit')

    def test_staple_failure_exports_nothing(self):
        self.exercise_signer('staple')


if __name__ == '__main__':
    unittest.main()
