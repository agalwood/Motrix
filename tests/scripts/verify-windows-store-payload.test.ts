// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  lstat,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { getRawHeader } from '@electron/asar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { verifyElectronPackage } from '../../scripts/verify-electron-package.mjs'
// @ts-expect-error -- JavaScript packaging script intentionally has no declarations
import { verifyWindowsStorePayload } from '../../scripts/verify-windows-store-payload.mjs'

import {
  createWindowsStorePayloadFixture,
  payloadFixtureSha256 as hash,
  WINDOWS_STORE_PAYLOAD_METADATA as metadata,
  windowsPeHeader as pe,
  writePayloadFixtureFile as write,
} from '../helpers/windows-store-payload-fixture'

vi.mock('../../scripts/verify-electron-package.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: any[]) => any>>()
  return {
    ...actual,
    verifyElectronPackage: vi.fn(actual.verifyElectronPackage),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readdir: vi.fn(actual.readdir) }
})

const roots: string[] = []
async function fixture(mutate?: (source: string) => Promise<void>) {
  const result = await createWindowsStorePayloadFixture(mutate)
  roots.push(result.root)
  return result
}

async function changeHeader(asar: string, mutate: (header: any) => void) {
  const { header, headerSize } = getRawHeader(asar)
  const bytes = await readFile(asar)
  mutate(header)
  const json = Buffer.from(JSON.stringify(header))
  const headerBytes = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4)
  headerBytes.writeUInt32LE(headerBytes.length - 4, 0)
  headerBytes.writeUInt32LE(json.length, 4)
  json.copy(headerBytes, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(headerBytes.length, 4)
  await writeFile(
    asar,
    Buffer.concat([size, headerBytes, bytes.subarray(8 + headerSize)])
  )
}

function failed(
  report: { ok: boolean; checks: { name: string; ok: boolean }[] },
  name: string
) {
  expect(report.ok).toBe(false)
  expect(report.checks).toContainEqual(
    expect.objectContaining({ name, ok: false })
  )
}

beforeEach(() => {
  vi.mocked(verifyElectronPackage).mockClear()
  vi.mocked(readdir).mockClear()
})
afterEach(async () => {
  vi.mocked(readdir).mockReset()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store directory payload verification', () => {
  it('composes the real Electron verifier and records physical and ASAR digests', async () => {
    const input = await fixture(async (source) => {
      await write(
        source,
        'library.js',
        'const marker = "-----BEGIN PRIVATE KEY-----"'
      )
    })
    const report = await verifyWindowsStorePayload({
      appDir: input.appDir,
      metadata,
    })
    expect(report).toMatchObject({
      ok: true,
      scope: 'windows-x64-directory-payload-only',
      versions: {
        productVersion: '1.2.3',
        asarProductVersion: '1.2.3',
        packageVersion: '4.5.6.0',
        packageVersionSource: 'validated-metadata-only',
      },
      electronPackage: {
        passed: true,
        target: { platform: 'win32', arch: 'x64' },
      },
      storeIdentityVerified: false,
      payloadSourceVerified: false,
      signatureVerified: false,
      executableBehaviorVerified: false,
    })
    expect(report.inventory.physicalFiles).toContainEqual({
      path: 'Motrix.exe',
      bytes: 72,
      sha256: hash(pe()),
      peMachine: 'x64',
    })
    expect(report.inventory.asarFiles).toContainEqual(
      expect.objectContaining({
        path: 'package.json',
        sha256: hash(await readFile(path.join(input.source, 'package.json'))),
      })
    )
    expect(JSON.stringify(report.inventory)).not.toContain(input.root)
    expect(verifyElectronPackage).toHaveBeenCalledTimes(1)
    const options = vi.mocked(verifyElectronPackage).mock.calls[0][0]
    expect(options).toMatchObject({
      appDir: input.appDir,
      platform: 'win32',
      arch: 'x64',
    })
    await expect(lstat(path.dirname(options.reportPath))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
    expect(await readdir(input.appDir)).not.toContain('electron-package.json')
  })

  it('retains existing required resources checks and cleans temporary failure reports', async () => {
    const input = await fixture()
    await unlink(path.join(input.appDir, 'resources/THIRD_PARTY_NOTICES.md'))
    const report = await verifyWindowsStorePayload({
      appDir: input.appDir,
      metadata,
    })
    failed(report, 'electron-package')
    expect(report.electronPackage.checks).toContainEqual(
      expect.objectContaining({ id: 'external-resources', passed: false })
    )
    const options = vi.mocked(verifyElectronPackage).mock.calls[0][0]
    await expect(lstat(path.dirname(options.reportPath))).rejects.toMatchObject(
      { code: 'ENOENT' }
    )
  })

  it('rejects a mismatched ASAR productVersion without deriving the independent packageVersion', async () => {
    const input = await fixture()
    const report = await verifyWindowsStorePayload({
      appDir: input.appDir,
      metadata: {
        ...metadata,
        productVersion: '1.2.4',
        source: { ...metadata.source, tag: 'v1.2.4' },
      },
    })
    failed(report, 'asar-files')
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it.each(['Motrix.exe', 'resources/app.asar'])(
    'rejects missing %s',
    async (file) => {
      const input = await fixture()
      await unlink(path.join(input.appDir, file))
      failed(
        await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
        'safe-directory'
      )
    }
  )

  it.each([
    'Motrix.exe',
    'runtime.dll',
    'resources/app.asar.unpacked/other.node',
  ])('rejects foreign-machine physical %s', async (file) => {
    const input = await fixture()
    await write(input.appDir, file, pe(0xaa64))
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'physical-files'
    )
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it.each([0x014c, 0xaa64])(
    'rejects packed ASAR native machine %i',
    async (machine) => {
      const input = await fixture(async (source) => {
        await write(source, 'additional.node', pe(machine))
      })
      failed(
        await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
        'asar-files'
      )
    }
  )

  it('rejects a malformed PE even with the expected extension', async () => {
    const input = await fixture()
    await write(input.appDir, 'runtime.dll', Buffer.alloc(72))
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'physical-files'
    )
  })

  it.each([
    'resources/APP-UPDATE.YML',
    'dev-app-update.yml',
    'certs/test.pfx',
    'private.key',
    'setup.msi',
    'renamed.exe',
  ])('rejects forbidden physical file %s', async (file) => {
    const input = await fixture()
    await write(input.appDir, file, file.endsWith('.exe') ? pe() : 'fixture')
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'safe-directory'
    )
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it.each([
    'app-update.yml',
    'nested/dev-app-update.yml',
    'test-cert.pem',
    'setup.msix',
    'renamed.exe',
  ])('rejects forbidden packed file %s', async (file) => {
    const input = await fixture(async (source) => {
      await write(source, file, 'fixture')
    })
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it.each([
    'bad:name',
    'NUL.txt',
    'trailing.',
    'trailing ',
    '../escape',
    'back\\slash',
  ])('rejects illegal ASAR path %s before extraction', async (name) => {
    const input = await fixture()
    await changeHeader(input.asar, (header) => {
      header.files[name] = header.files['package.json']
    })
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it('rejects ASAR case collisions without relying on the host filesystem', async () => {
    const input = await fixture()
    await changeHeader(input.asar, (header) => {
      header.files['PACKAGE.JSON'] = header.files['package.json']
    })
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
  })

  it('rejects ASAR links instead of following them', async () => {
    const input = await fixture()
    await changeHeader(input.asar, (header) => {
      header.files['package.json'] = { link: '../../outside.json' }
    })
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it('rejects missing unpacked content before the existing verifier can overlook it', async () => {
    const input = await fixture()
    await unlink(
      path.join(
        input.appDir,
        'resources/app.asar.unpacked/dist/renderer/index.html'
      )
    )
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
  })

  it('rejects an ASAR file range outside the archive', async () => {
    const input = await fixture()
    await changeHeader(input.asar, (header) => {
      header.files['package.json'].offset = '99999999'
    })
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
  })

  it('rejects unreadable directory entries instead of treating them as empty', async () => {
    const input = await fixture()
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('secret absolute path'), { code: 'EACCES' })
    )
    const report = await verifyWindowsStorePayload({
      appDir: input.appDir,
      metadata,
    })
    failed(report, 'safe-directory')
    expect(JSON.stringify(report)).not.toContain('secret absolute path')
    expect(verifyElectronPackage).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'rejects physical symlinks and symlink input roots without following them',
    async () => {
      const input = await fixture()
      const alias = path.join(input.root, 'alias')
      await symlink(input.appDir, alias)
      failed(
        await verifyWindowsStorePayload({ appDir: alias, metadata }),
        'safe-directory'
      )
      await symlink(
        path.join(input.root, 'does-not-exist'),
        path.join(input.appDir, 'external.dll')
      )
      failed(
        await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
        'safe-directory'
      )
      expect(verifyElectronPackage).not.toHaveBeenCalled()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects non-regular files without trying to read them',
    async () => {
      const input = await fixture()
      execFileSync('mkfifo', [path.join(input.appDir, 'pipe')])
      failed(
        await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
        'safe-directory'
      )
    }
  )

  it('rejects physical Windows case collisions before opening either conflicting entry', async () => {
    const input = await fixture()
    vi.mocked(readdir).mockResolvedValueOnce([
      'Motrix.exe',
      'motrix.exe',
    ] as any)
    const report = await verifyWindowsStorePayload({
      appDir: input.appDir,
      metadata,
    })
    failed(report, 'safe-directory')
    expect(report.checks.at(-1).message).toContain('Windows path collision')
  })

  it('rejects an oversized ASAR header before allocating its declared size', async () => {
    const input = await fixture()
    const bytes = await readFile(input.asar)
    bytes.writeUInt32LE(0xffffffff, 4)
    await writeFile(input.asar, bytes)
    failed(
      await verifyWindowsStorePayload({ appDir: input.appDir, metadata }),
      'asar-files'
    )
  })

  it('offers a strict JSON CLI without a bypass or report output argument', async () => {
    const input = await fixture()
    const metadataPath = path.join(input.root, 'metadata.json')
    await writeFile(metadataPath, JSON.stringify(metadata))
    const script = path.resolve('scripts/verify-windows-store-payload.mjs')
    const args = [script, '--app-dir', input.appDir, '--metadata', metadataPath]
    const run = (extra: string[] = []) => {
      try {
        return {
          code: 0,
          report: JSON.parse(
            execFileSync(process.execPath, [...args, ...extra], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          ),
        }
      } catch (error) {
        const failure = error as { status: number; stdout: string }
        return { code: failure.status, report: JSON.parse(failure.stdout) }
      }
    }
    expect(run()).toMatchObject({ code: 0, report: { ok: true } })
    expect(run(['--budgets', 'relaxed.json'])).toMatchObject({
      code: 1,
      report: { ok: false },
    })
    await write(input.appDir, 'setup.exe', pe())
    const failure = run()
    expect(failure.code).toBe(1)
    failed(failure.report, 'safe-directory')
    expect(failure.report.signatureVerified).toBe(false)
  })
})
