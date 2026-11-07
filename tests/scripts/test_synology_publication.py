"""Exercise release verification without writing to GitHub."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import synology_publication as pub

LOCK = json.loads((ROOT / 'scripts/synology-runtime.lock.json').read_text())
NODE = json.loads((ROOT / 'scripts/fnos-runtime.lock.json').read_text())
SHA = 'a' * 40
VERSION = '2.3.0'


def tar(files, mode):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode=mode) as archive:
        for name, content in files.items():
            entry = tarfile.TarInfo(name)
            entry.mode = 0o644
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    return out.getvalue()


def fixture(directory, arch, *, replace_payload=False, source=SHA):
    target = LOCK['targets'][arch]
    profiles = target['platforms']
    rev = LOCK['revision']
    name = f'Motrix-{VERSION}-{rev}-dsm-{arch}.spk'
    receipt = dict(schemaVersion=2, architecture=arch, revision=rev, version=VERSION, sourceCommit=source,
                   sourceDirty=False, minimumDsm=LOCK['dsmVersion'], nodeArchiveSha256=NODE['node'][arch]['sha256'],
                   platforms=list(profiles), toolchainDigests={k: v['toolchain']['sha256'] for k, v in profiles.items()})
    files = {f: b'\x7fELFtest' for f in ['runtime/bin/node', 'server/bin/aria2c', 'server/bin/motrix-finalize-fs', 'server/sqlite.node']}
    elf = [{'file': f, 'sha256': hashlib.sha256(b).hexdigest()} for f, b in files.items()]
    files['synology-build.json'] = json.dumps(receipt).encode()
    files['payload-sha256.json'] = json.dumps(
        {f: {'sha256': hashlib.sha256(b).hexdigest(), 'executable': False} for f, b in files.items()}).encode()
    if replace_payload:
        files['runtime/bin/node'] = b'fixture changed after validation'
    payload = tar(files, 'w:gz')
    info = dict(package='Motrix', version=f'{VERSION}-{rev}', os_min_ver=LOCK['dsmVersion'],
                arch=target.get('infoArch', ' '.join(profiles)), checksum=hashlib.md5(payload).hexdigest())
    package = tar({'INFO': '\n'.join(f'{key}="{value}"' for key, value in info.items()).encode(), 'package.tgz': payload}, 'w')
    digest = hashlib.sha256(package).hexdigest()
    (directory / name).write_bytes(package)
    (directory / (name+'.sha256')).write_text(f'{digest}  {name}\n')
    reports = {k: dict(architecture=arch, platform=k, cpuEmulation=target.get('cpu'), toolchainSha256=v['toolchain']['sha256'],
                       loaded=dict(arch=arch, glibc=LOCK['glibc'], node='v'+NODE['nodeVersion'], sqlite='read-write-ok'), elf=elf)
               for k, v in profiles.items()}
    abi = directory / (name+'.abi.json')
    abi.write_text(json.dumps(dict(schemaVersion=3, architecture=arch, spkSha256=digest, platforms=reports)))
    return abi


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        fixture(self.root, 'x64')
        self.arm = fixture(self.root, 'arm64')
        patcher = patch.object(pub, 'run', side_effect=lambda *args: json.dumps(LOCK if 'synology' in args[-1] else NODE))
        patcher.start()
        self.addCleanup(patcher.stop)

    def verify(self):
        return pub.verify_bundle(self.root, VERSION, SHA)

    def test_exact_set(self):
        self.assertEqual([r['arch'] for r in self.verify()], ['x64', 'arm64'])

    def test_incomplete_platform_proof(self):
        doc = json.loads(self.arm.read_text())
        del doc['platforms']['armada37xx']
        self.arm.write_text(json.dumps(doc))
        with self.assertRaisesRegex(ValueError, 'ABI report'):
            self.verify()

    def test_wrong_source(self):
        fixture(self.root, 'arm64', source='b'*40)
        with self.assertRaisesRegex(ValueError, 'source'):
            self.verify()

    def test_modified_payload_with_new_outer_checksums(self):
        fixture(self.root, 'arm64', replace_payload=True)
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.verify()

    def test_missing_architecture(self):
        self.arm.unlink()
        with self.assertRaisesRegex(ValueError, 'Both complete'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
