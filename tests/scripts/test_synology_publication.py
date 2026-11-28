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
SHA = pub.run('git', 'rev-parse', 'HEAD')
TEMPLATES = pub.package_templates(SHA)
VERSION = '2.3.0'
ENGINES = {'assets': {}}
for arch, target in LOCK['targets'].items():
    header = bytearray(20)
    header[:6] = b'\x7fELF\x02\x01'
    header[18:20] = target['machine'].to_bytes(2, 'little')
    digest = hashlib.sha256(header).hexdigest()
    NODE['node'][arch]['binarySha256'] = digest
    ENGINES['assets'][f'linux-{arch}'] = {'binarySha256': digest}


def tar(files, mode, executable=()):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode=mode) as archive:
        for name, content in files.items():
            entry = tarfile.TarInfo(name)
            entry.mode = 0o755 if name in executable else 0o644
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    return out.getvalue()


def fixture(directory, arch, *, replace_payload=False, source=SHA, outer_changes=None, wrong_machine=False, foreign_node=False):
    target = LOCK['targets'][arch]
    profiles = target['platforms']
    rev = LOCK['revision']
    name = f'Motrix-{VERSION}-{rev}-dsm-{arch}.spk'
    receipt = dict(schemaVersion=2, architecture=arch, revision=rev, version=VERSION, sourceCommit=source,
                   sourceDirty=False, minimumDsm=LOCK['dsmVersion'], nodeArchiveSha256=NODE['node'][arch]['sha256'],
                   platforms=list(profiles), toolchainDigests={k: v['toolchain']['sha256'] for k, v in profiles.items()})
    header = bytearray(20)
    header[:6] = b'\x7fELF\x02\x01'
    header[18:20] = (0 if wrong_machine else target['machine']).to_bytes(2, 'little')
    files = {f: bytes(header) for f in ['runtime/bin/node', 'server/bin/aria2c', 'server/bin/motrix-finalize-fs', 'server/sqlite.node']}
    if foreign_node:
        files['runtime/bin/node'] += b'untrusted executable'
    elf = [{'file': f, 'sha256': hashlib.sha256(b).hexdigest()} for f, b in files.items()]
    app_exec = set(files) - {'server/sqlite.node'}
    for k,(blob,is_exec) in TEMPLATES.items():
        if k.startswith('app/'):
            name_in_app = k.removeprefix('app/')
            files[name_in_app] = blob
            if is_exec:
                app_exec.add(name_in_app)
    files['synology-build.json'] = json.dumps(receipt).encode()
    files['payload-sha256.json'] = json.dumps(
        {f: {'sha256': hashlib.sha256(b).hexdigest(), 'executable': f in app_exec} for f, b in files.items()}).encode()
    if replace_payload:
        files['runtime/bin/node'] += b'fixture changed after validation'
    payload = tar(files, 'w:gz', app_exec)
    outer = {k: v[0] for k,v in TEMPLATES.items() if not k.startswith('app/')}
    outer['INFO'] = pub.render_info(outer['INFO'],VERSION,rev,target.get('infoArch',' '.join(profiles)),payload)
    outer['package.tgz'] = payload
    outer.update(outer_changes or {})
    package = tar(outer,'w',{k for k,v in TEMPLATES.items() if v[1]})
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
        patcher = patch.object(pub, 'run', side_effect=lambda *args: json.dumps(LOCK if 'synology' in args[-1] else ENGINES if 'engine.lock' in args[-1] else NODE))
        patcher.start()
        self.addCleanup(patcher.stop)

    def verify(self):
        return pub.verify_bundle(self.root, VERSION, SHA)

    def test_self_consistent_foreign_node(self):
        fixture(self.root, 'arm64', foreign_node=True)
        with self.assertRaisesRegex(ValueError, 'binary differs'):
            self.verify()

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

    def test_modified_install_code_and_privilege_denied_with_consistent_digests(self):
        for name, data in [('scripts/postinst',b'#!/bin/sh\nexit 0'),('conf/privilege',b'{"defaults":{"run-as":"root"}}'),('unexpected',b'extra')]:
            with self.subTest(member=name):
                fixture(self.root, 'arm64', outer_changes={name:data})
                with self.assertRaisesRegex(ValueError, 'template|Unexpected'):
                    self.verify()

    def test_wrong_elf_machine_denied_with_consistent_metadata(self):
        fixture(self.root, 'arm64', wrong_machine=True)
        with self.assertRaisesRegex(ValueError, 'Foreign ELF'):
            self.verify()

    def test_missing_architecture(self):
        self.arm.unlink()
        with self.assertRaisesRegex(ValueError, 'Both complete'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
