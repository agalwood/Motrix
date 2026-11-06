import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  applyPendingSettings,
  configure,
} from '../../packaging/synology/app/lifecycle.mjs'
import { payloadInventory } from '../../scripts/verify-synology-package.mjs'

it.skipIf(process.platform === 'win32')(
  'replays pending settings after an interrupted apply and preserves the journal on failure',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-pending-'))
    try {
      const value = {
        roots: ['/volume1/motrix', '/volume1/downloads'],
        clientPort: 16812,
        extensionUrl: 'wss://nas.test:5001/motrix/bridge',
        operatorUrl: 'https://nas.test:5001/motrix/',
        allowHttp: false,
      }
      await writeFile(
        path.join(root, 'pending-settings.json'),
        JSON.stringify(value),
        { mode: 0o600 }
      )
      const { mkdir } = await import('node:fs/promises')
      await mkdir(path.join(root, 'directories.json'))
      await expect(
        applyPendingSettings({ SYNOPKG_PKGVAR: root })
      ).rejects.toThrow()
      expect(
        JSON.parse(
          await readFile(path.join(root, 'pending-settings.json'), 'utf8')
        )
      ).toEqual(value)
      await rm(path.join(root, 'directories.json'), { recursive: true })
      await applyPendingSettings({ SYNOPKG_PKGVAR: root })
      expect(
        JSON.parse(
          await readFile(path.join(root, 'package-settings.json'), 'utf8')
        )
      ).toMatchObject({ clientPort: 16812, extensionUrl: value.extensionUrl })
      expect(
        JSON.parse(await readFile(path.join(root, 'directories.json'), 'utf8'))
      ).toEqual({ roots: value.roots })
      await expect(
        readFile(path.join(root, 'pending-settings.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await applyPendingSettings({ SYNOPKG_PKGVAR: root })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('preserves package settings on upgrade and rejects invalid client ports before writing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-config-'))
  try {
    const env = { SYNOPKG_PKGVAR: root, wizard_client_port: '65536' }
    await expect(configure(env)).rejects.toThrow()
    await configure({ ...env, wizard_client_port: '16812' })
    const before = await readFile(
      path.join(root, 'package-settings.json'),
      'utf8'
    )
    await configure({
      ...env,
      wizard_client_port: '16820',
      wizard_allow_operator_http: 'true',
    })
    expect(
      await readFile(path.join(root, 'package-settings.json'), 'utf8')
    ).toBe(before)
    expect(JSON.parse(before)).toMatchObject({
      clientPort: 16812,
      allowHttp: false,
      extensionUrl: '',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('detects changed and additional payload bytes, including executable permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-hash-'))
  try {
    await writeFile(path.join(root, 'file'), 'original', { mode: 0o644 })
    const before = await payloadInventory(root)
    await writeFile(path.join(root, 'file'), 'tampered')
    expect(await payloadInventory(root)).not.toEqual(before)
    await writeFile(path.join(root, 'extra'), 'extra')
    expect(Object.keys(await payloadInventory(root))).toEqual(['extra', 'file'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses traversal, symlinks, macOS metadata and duplicate names in an SPK', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-archive-'))
  try {
    for (const kind of ['traversal', 'link', 'metadata', 'duplicate']) {
      const archive = path.join(root, `${kind}.tar`)
      execFileSync('python3', [
        '-c',
        `import tarfile,sys\nt=tarfile.open(sys.argv[1],'w')\nk=sys.argv[2]\na=tarfile.TarInfo('../outside' if k=='traversal' else '._file' if k=='metadata' else 'file')\nif k=='link': a.type=tarfile.SYMTYPE; a.linkname='/tmp'\nt.addfile(a)\nif k=='duplicate': t.addfile(a)\nt.close()`,
        archive,
        kind,
      ])
      expect(() =>
        execFileSync(
          'python3',
          ['scripts/spk_archive.py', archive, path.join(root, kind)],
          { stdio: 'pipe' }
        )
      ).toThrow()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
