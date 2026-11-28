import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  applyPendingSettings,
  configure,
  runtimeEnvironment,
} from '../../packaging/synology/app/lifecycle.mjs'
import { payloadInventory } from '../../scripts/verify-synology-package.mjs'

it.skipIf(process.platform === 'win32')(
  'rejects unsafe package settings before starting either runtime',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-config-'))
    try {
      const env = { SYNOPKG_PKGDEST: root, SYNOPKG_PKGVAR: root }
      await configure(env)
      const config = path.join(root, 'directories.json'),
        target = path.join(root, 'fixture')
      await writeFile(target, JSON.stringify({ roots: ['/volume1/motrix'] }), {
        mode: 0o600,
      })
      await symlink(target, config)
      await expect(runtimeEnvironment(env)).rejects.toMatchObject({
        code: 'ELOOP',
      })
      await rm(config)
      await writeFile(config, 'private-test-content', { mode: 0o600 })
      await expect(runtimeEnvironment(env)).rejects.toThrow(
        'Invalid DSM package configuration'
      )
      await writeFile(config, Buffer.alloc(36 * 1024 + 1))
      await expect(runtimeEnvironment(env)).rejects.toThrow(
        'Untrusted DSM package configuration'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it
  .skipIf(process.platform === 'win32')
  .each([{}, { directoryIdentities: ['12:257', '12:258'] }])(
  'replays pending settings after an interrupted apply and preserves the grant metadata %j',
  async (grant) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-pending-'))
    try {
      const value = {
        ...grant,
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
      ).toEqual({ roots: value.roots, ...grant })
      await expect(
        readFile(path.join(root, 'pending-settings.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await applyPendingSettings({ SYNOPKG_PKGVAR: root })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps existing directory identities when replaying a path-only journal',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-replay-'))
    try {
      const grant = {
        roots: ['/volume1/motrix'],
        directoryIdentities: ['7:256'],
      }
      const file = path.join(root, 'directories.json')
      await writeFile(file, JSON.stringify(grant), { mode: 0o600 })
      const pending = path.join(root, 'pending-settings.json')
      const settings = {
        roots: grant.roots,
        clientPort: 16802,
        allowHttp: false,
        operatorUrl: '',
        extensionUrl: '',
      }
      await writeFile(pending, JSON.stringify(settings), { mode: 0o600 })
      await applyPendingSettings({ SYNOPKG_PKGVAR: root })
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(grant)
      const invalid = { ...settings, directoryIdentities: [] }
      await writeFile(pending, JSON.stringify(invalid), { mode: 0o600 })
      await expect(
        applyPendingSettings({ SYNOPKG_PKGVAR: root })
      ).rejects.toThrow('Invalid pending directory identities')
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(grant)
      expect(JSON.parse(await readFile(pending, 'utf8'))).toEqual(invalid)
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

it.skipIf(process.platform === 'win32')(
  'verifies release architecture, source and payload before publication',
  () => {
    execFileSync('python3', ['tests/scripts/test_synology_publication.py'], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
  }
)
