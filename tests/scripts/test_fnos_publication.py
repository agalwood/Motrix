import copy
import hashlib
import sys
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import fnos_publication as pub
import nas_release

VERSION = '2.3.0'
TAG = 'v' + VERSION
SHA = 'a' * 40
RUN = {'id': 123, 'event': 'push', 'status': 'completed', 'conclusion': 'success',
       'head_branch': TAG, 'head_sha': SHA, 'workflow_id': 456,
       'path': '.github/workflows/release.yml', 'head_repository': {'full_name': pub.REPOSITORY}}
SOURCE = {'tag': TAG, 'version': VERSION, 'source_sha': SHA, 'release_run_id': '123'}


def tar_bytes(files, mode='w'):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode=mode) as archive:
        for name, value in files:
            data = value.encode() if isinstance(value, str) else value
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return out.getvalue()


def fixture(root, arch, *, manifest_version=VERSION, receipt_arch=None, duplicate=False):
    name = f'Motrix-{VERSION}-fnos-{arch}.fpk'
    receipt = {'schemaVersion': 2, 'version': VERSION, 'packageVersion': VERSION,
               'revision': 0, 'arch': receipt_arch or arch}
    app = tar_bytes([('./fnos-build.json', json.dumps(receipt)),
                     ('./server/package.json', json.dumps({'version': VERSION}))], 'w:gz')
    files = [('manifest', f'appname = motrix\nversion = {manifest_version}\nplatform = {"x86" if arch == "x64" else "arm"}\n'), ('app.tgz', app)]
    if duplicate:
        files.append(files[0])
    data = tar_bytes(files)
    (root / name).write_bytes(data)
    (root / (name + '.sha256')).write_text(f'{hashlib.sha256(data).hexdigest()}  {name}\n')


def assets(root):
    return [{'name': p.name, 'size': p.stat().st_size,
             'digest': 'sha256:' + hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.iterdir()]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for arch in ['x64', 'arm64']:
            fixture(self.root, arch)

    def test_strict_stable_only(self):
        self.assertEqual(pub.stable_version(TAG), VERSION)
        for tag in ['2.3.0', 'v02.3.0', 'v2.3.0-beta.1', 'v2.3.0+build', 'v2.3.0\n', 'v2.3.0;echo hi']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                pub.stable_version(tag)

    def test_exact_successful_formal_run(self):
        pub.validate_run(RUN, TAG, SHA, 456)
        for field, value in [('event', 'workflow_dispatch'), ('status', 'in_progress'),
                             ('conclusion', 'failure'), ('head_branch', 'v2.2.1'),
                             ('head_sha', 'b' * 40), ('workflow_id', 999),
                             ('path', '.github/workflows/fnos.yml'),
                             ('head_repository', {'full_name': 'fork/Motrix'})]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                pub.validate_run({**RUN, field: value}, TAG, SHA, 456)

    def test_public_stable_release_required(self):
        value = {'tag_name': TAG, 'draft': False, 'prerelease': False}
        pub.validate_release(value, TAG)
        for field, val in [('tag_name', 'v2.2.1'), ('draft', True), ('prerelease', True)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                pub.validate_release({**value, field: val}, TAG)

    def test_exact_dual_architecture_bundle(self):
        self.assertEqual([v['arch'] for v in pub.verify_bundle(self.root, VERSION)], ['x64', 'arm64'])

    def test_partial_bundle_rejected(self):
        (self.root / 'Motrix-2.3.0-fnos-arm64.fpk').unlink()
        with self.assertRaisesRegex(ValueError, 'Both exact'):
            pub.verify_bundle(self.root, VERSION)

    def test_extra_asset_rejected(self):
        (self.root / 'unverified.fpk').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError, 'Both exact'):
            pub.verify_bundle(self.root, VERSION)

    def test_checksum_tampering_rejected(self):
        (self.root / 'Motrix-2.3.0-fnos-x64.fpk').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            pub.verify_bundle(self.root, VERSION)

    def test_wrong_manifest_version_rejected_even_with_valid_checksum(self):
        fixture(self.root, 'arm64', manifest_version='2.2.1')
        with self.assertRaisesRegex(ValueError, 'manifest'):
            pub.verify_bundle(self.root, VERSION)

    def test_wrong_embedded_architecture_rejected(self):
        fixture(self.root, 'arm64', receipt_arch='x64')
        with self.assertRaisesRegex(ValueError, 'receipt'):
            pub.verify_bundle(self.root, VERSION)

    def test_duplicate_manifest_rejected(self):
        fixture(self.root, 'x64', duplicate=True)
        with self.assertRaisesRegex(ValueError, 'archive member'):
            pub.verify_bundle(self.root, VERSION)

    def test_symlink_rejected(self):
        p = self.root / 'Motrix-2.3.0-fnos-arm64.fpk'
        data = p.read_bytes()
        p.unlink()
        target = self.root.parent / (self.root.name + '-target')
        target.write_bytes(data)
        self.addCleanup(target.unlink)
        p.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'regular files'):
            pub.verify_bundle(self.root, VERSION)

    def test_moved_tag_aborts_before_any_upload(self):
        with patch.object(pub, 'source', return_value={**SOURCE, 'source_sha': 'b' * 40}), patch.object(pub.subprocess, 'run') as mutation:
            with self.assertRaisesRegex(ValueError, 'tag changed'):
                pub.publish(self.root, TAG, SHA, '123')
            mutation.assert_not_called()

    def test_existing_different_asset_never_overwritten(self):
        existing = assets(self.root)
        existing[0]['digest'] = 'sha256:' + '0' * 64
        with patch.object(pub, 'source', return_value=SOURCE), patch.object(nas_release, 'api', return_value={'assets': existing}), patch.object(pub.subprocess, 'run') as mutation:
            with self.assertRaisesRegex(ValueError, 'immutable'):
                pub.publish(self.root, TAG, SHA, '123')
            mutation.assert_not_called()

    def test_retry_reuses_identical_assets(self):
        with patch.object(pub, 'source', return_value=SOURCE), patch.object(nas_release, 'api', return_value={'assets': assets(self.root)}), patch.object(pub.subprocess, 'run') as mutation:
            pub.publish(self.root, TAG, SHA, '123')
            mutation.assert_not_called()

    def test_publish_adds_only_missing_verified_assets(self):
        existing = assets(self.root)
        with patch.object(pub, 'source', return_value=SOURCE), patch.object(nas_release, 'api', side_effect=[{'assets': existing[:1]}, {'assets': existing}]), patch.object(pub.subprocess, 'run') as mutation:
            pub.publish(self.root, TAG, SHA, '123')
            command = mutation.call_args.args[0]
            self.assertNotIn('--clobber', command)
            self.assertEqual(len(command[6:]), 3)
            self.assertNotIn(str(self.root / existing[0]['name']), command)


if __name__ == '__main__':
    unittest.main()
