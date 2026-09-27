// @vitest-environment node
import { execFileSync } from 'node:child_process'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { devNull } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareWindowsStoreLayout } from '../../scripts/prepare-windows-store-layout.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import {
  createWindowsStorePayloadFixture,
  WINDOWS_STORE_PAYLOAD_METADATA,
  windowsPeHeader,
} from '../helpers/windows-store-payload-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, cp: vi.fn(actual.cp) }
})
const roots: string[] = []
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_')
    )
  ),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
async function fixture() {
  const payload = await createWindowsStorePayloadFixture()
  roots.push(payload.root)
  const repoRoot = path.join(payload.root, 'checkout')
  await mkdir(repoRoot)
  git(repoRoot, 'init', '--template=', '--initial-branch=main')
  git(repoRoot, 'config', 'user.name', 'Layout fixture')
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(path.join(repoRoot, 'package.json'), '{"version":"1.2.3"}\n')
  await cp(path.resolve('build/appx'), path.join(repoRoot, 'build/appx'), {
    recursive: true,
  })
  git(repoRoot, 'add', '.')
  git(repoRoot, 'commit', '-m', 'fixture')
  return {
    repoRoot,
    appDir: payload.appDir,
    outputDirectory: path.join(payload.root, 'prepared'),
    metadata: {
      ...WINDOWS_STORE_PAYLOAD_METADATA,
      profile: 'test',
      identity: WINDOWS_STORE_TEST_IDENTITY,
      source: { commit: git(repoRoot, 'rev-parse', 'HEAD') },
    },
  }
}
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(cp).mockImplementation(actual.cp)
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Windows Store test layout preparation', () => {
  it('assembles a verified copy with qualified assets without claiming an AppX build', async () => {
    const options = await fixture()
    const report = await prepareWindowsStoreLayout(options)
    expect(report).toMatchObject({
      scope: 'windows-test-layout',
      profile: 'test',
      identity: WINDOWS_STORE_TEST_IDENTITY,
      copiedPayloadMatched: true,
      payloadSourceVerified: false,
      windowsSdkExecuted: false,
      windowsRuntimeVerified: false,
      storeSubmissionReady: false,
    })
    expect(report.assets).toHaveLength(4)
    expect(report.payload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'Motrix.exe',
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
        expect.objectContaining({ path: 'resources/app.asar' }),
      ])
    )
    for (const asset of report.assets) {
      expect(asset.path).toContain('.scale-200.png')
      expect(
        await readFile(path.join(options.outputDirectory, 'layout', asset.path))
      ).toEqual(
        await readFile(
          path.join(options.outputDirectory, 'pri-root', asset.path)
        )
      )
    }
    expect(await readdir(path.join(options.outputDirectory, 'layout'))).toEqual(
      ['AppxManifest.xml', 'Assets', 'app']
    )
    const manifest = await readFile(
      path.join(options.outputDirectory, 'layout/AppxManifest.xml'),
      'utf8'
    )
    expect(manifest).toContain('Motrix.Store.Test')
    expect(manifest).not.toContain('<Extensions>')
    expect(
      await readFile(
        path.join(options.outputDirectory, 'TEST-ONLY.txt'),
        'utf8'
      )
    ).toContain('isolated Windows')
    expect(git(options.repoRoot, 'status', '--porcelain')).toBe('')
  })

  it('rejects production metadata before preparing an incomplete Store candidate', async () => {
    const options = await fixture()
    await expect(
      prepareWindowsStoreLayout({
        ...options,
        metadata: WINDOWS_STORE_PAYLOAD_METADATA,
      })
    ).rejects.toThrow('Only test layouts')
    await expect(lstat(options.outputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects output inside the payload and preserves an existing output', async () => {
    const options = await fixture()
    await expect(
      prepareWindowsStoreLayout({
        ...options,
        outputDirectory: path.join(options.appDir, 'nested'),
      })
    ).rejects.toThrow('outside')
    await mkdir(options.outputDirectory)
    await writeFile(path.join(options.outputDirectory, 'keep.txt'), 'keep')
    await expect(prepareWindowsStoreLayout(options)).rejects.toThrow(
      'already exists'
    )
    expect(await readdir(options.outputDirectory)).toEqual(['keep.txt'])
  })

  it.each(['dirty-source', 'wrong-pe', 'wrong-asset'])(
    'does not create output for invalid input: %s',
    async (mode) => {
      const options = await fixture()
      if (mode === 'dirty-source')
        await writeFile(path.join(options.repoRoot, 'dirty.txt'), 'changed')
      if (mode === 'wrong-pe')
        await writeFile(
          path.join(options.appDir, 'Motrix.exe'),
          windowsPeHeader(0x14c)
        )
      if (mode === 'wrong-asset') {
        await writeFile(
          path.join(options.repoRoot, 'build/appx/StoreLogo.png'),
          'not an image'
        )
        git(options.repoRoot, 'commit', '-am', 'invalid asset')
        options.metadata.source.commit = git(
          options.repoRoot,
          'rev-parse',
          'HEAD'
        )
      }
      await expect(prepareWindowsStoreLayout(options)).rejects.toThrow()
      await expect(lstat(options.outputDirectory)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

  it.each(['extra-file', 'wrong-pe'])(
    'does not write a completion record for a changed copy: %s',
    async (mode) => {
      const options = await fixture()
      const actual =
        await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises'
        )
      vi.mocked(cp).mockImplementationOnce(
        async (source, destination, settings) => {
          await actual.cp(source, destination, settings)
          if (mode === 'extra-file') {
            await writeFile(
              path.join(destination.toString(), 'changed.txt'),
              'changed during copy'
            )
          } else {
            await writeFile(
              path.join(destination.toString(), 'Motrix.exe'),
              windowsPeHeader(0x14c)
            )
          }
        }
      )
      await expect(prepareWindowsStoreLayout(options)).rejects.toThrow(
        mode === 'extra-file'
          ? 'changed during layout'
          : 'Copied payload verification failed'
      )
      await expect(
        lstat(path.join(options.outputDirectory, 'layout-report.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('uses the real validators through the CLI', async () => {
    const options = await fixture()
    const metadataFile = path.join(
      path.dirname(options.outputDirectory),
      'metadata.json'
    )
    await writeFile(metadataFile, JSON.stringify(options.metadata))
    const stdout = execFileSync(
      process.execPath,
      [
        path.resolve('scripts/prepare-windows-store-layout.mjs'),
        '--repo-root',
        options.repoRoot,
        '--app-dir',
        options.appDir,
        '--metadata',
        metadataFile,
        '--out',
        options.outputDirectory,
      ],
      { env, encoding: 'utf8' }
    )
    expect(JSON.parse(stdout)).toMatchObject({
      copiedPayloadMatched: true,
      storeSubmissionReady: false,
    })
  })
})
