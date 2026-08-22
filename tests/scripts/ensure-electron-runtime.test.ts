import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — .mjs without types
import {
  ensureElectronRuntime,
  inspectElectronRuntime,
} from '../../scripts/ensure-electron-runtime.mjs'

const VERSION = '43.4.0'
let packageDir: string

async function writePackageShell(): Promise<void> {
  await writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'electron', version: VERSION })
  )
  await writeFile(path.join(packageDir, 'install.js'), '// test installer')
}

async function writeRuntime(): Promise<void> {
  const executableRelativePath =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron'
  await mkdir(
    path.dirname(path.join(packageDir, 'dist', executableRelativePath)),
    { recursive: true }
  )
  await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
  await writeFile(path.join(packageDir, 'dist', 'LICENSE'), 'Electron license')
  await writeFile(
    path.join(packageDir, 'dist', 'LICENSES.chromium.html'),
    'Chromium licenses'
  )
  await writeFile(
    path.join(packageDir, 'dist', executableRelativePath),
    'binary'
  )
  await writeFile(path.join(packageDir, 'path.txt'), executableRelativePath)
}

function writeRuntimeSync(): void {
  const executableRelativePath =
    process.platform === 'win32'
      ? 'electron.exe'
      : process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron'
  mkdirSync(
    path.dirname(path.join(packageDir, 'dist', executableRelativePath)),
    { recursive: true }
  )
  writeFileSync(path.join(packageDir, 'dist', 'version'), VERSION)
  writeFileSync(path.join(packageDir, 'dist', 'LICENSE'), 'Electron license')
  writeFileSync(
    path.join(packageDir, 'dist', 'LICENSES.chromium.html'),
    'Chromium licenses'
  )
  writeFileSync(path.join(packageDir, 'dist', executableRelativePath), 'binary')
  writeFileSync(path.join(packageDir, 'path.txt'), executableRelativePath)
}

beforeEach(async () => {
  packageDir = await mkdtemp(path.join(tmpdir(), 'motrix-electron-runtime-'))
  await writePackageShell()
})

afterEach(async () => {
  await rm(packageDir, { force: true, recursive: true })
})

describe('inspectElectronRuntime', () => {
  it('accepts a complete matching runtime', async () => {
    await writeRuntime()

    expect(inspectElectronRuntime(packageDir)).toEqual({
      complete: true,
      expectedVersion: VERSION,
      issues: [],
    })
  })

  it('reports missing runtime licenses and a missing executable', async () => {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true })
    await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
    await writeFile(path.join(packageDir, 'path.txt'), 'electron')

    const result = inspectElectronRuntime(packageDir)
    expect(result.complete).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'dist/LICENSE is missing or empty',
        'dist/LICENSES.chromium.html is missing or empty',
        'Electron executable is missing: electron',
      ])
    )
  })

  it('rejects a runtime hydrated for a different Electron version', async () => {
    await writeRuntime()
    await writeFile(path.join(packageDir, 'dist', 'version'), '42.0.0')

    expect(inspectElectronRuntime(packageDir).issues).toContain(
      `dist/version is 42.0.0, expected ${VERSION}`
    )
  })

  it('rejects an executable path that escapes dist', async () => {
    await writeRuntime()
    await writeFile(path.join(packageDir, 'path.txt'), '../package.json')

    expect(inspectElectronRuntime(packageDir).issues).toContain(
      'Electron executable is missing: ../package.json'
    )
  })
})

describe('ensureElectronRuntime', () => {
  it('returns immediately without invoking the installer when complete', async () => {
    await writeRuntime()
    const spawn = vi.fn()

    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        log: vi.fn(),
        logError: vi.fn(),
        spawn,
      })
    ).toBe(0)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('replaces a partially hydrated runtime instead of trusting version alone', async () => {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true })
    await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
    await writeFile(path.join(packageDir, 'dist', 'stale-file'), 'stale')
    await writeFile(path.join(packageDir, 'path.txt'), 'electron')
    const spawn = vi.fn(() => {
      // The stale payload must already be out of the installer's way.
      expect(existsSync(path.join(packageDir, 'dist', 'stale-file'))).toBe(
        false
      )
      writeRuntimeSync()
      return { status: 0, signal: null }
    })

    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        log: vi.fn(),
        logError: vi.fn(),
        spawn,
      })
    ).toBe(0)
    expect(inspectElectronRuntime(packageDir).complete).toBe(true)
    await expect(
      readFile(path.join(packageDir, 'dist', 'stale-file'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the previous payload when installation fails', async () => {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true })
    await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
    await writeFile(path.join(packageDir, 'dist', 'stale-file'), 'keep me')
    await writeFile(path.join(packageDir, 'path.txt'), 'electron')

    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        log: vi.fn(),
        logError: vi.fn(),
        spawn: vi.fn(() => ({ status: 7, signal: null })),
      })
    ).toBe(7)
    await expect(
      readFile(path.join(packageDir, 'dist', 'stale-file'), 'utf8')
    ).resolves.toBe('keep me')
    await expect(
      readFile(path.join(packageDir, 'path.txt'), 'utf8')
    ).resolves.toBe('electron')
  })

  it('preserves originals when moving one payload aside fails', async () => {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true })
    await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
    await writeFile(path.join(packageDir, 'dist', 'stale-file'), 'keep me')
    const pathFile = path.join(packageDir, 'path.txt')
    await writeFile(pathFile, 'electron')
    const logError = vi.fn()

    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        fs: {
          existsSync,
          readFileSync,
          renameSync: vi.fn((source, destination) => {
            if (source === pathFile) {
              throw new Error('simulated rename failure')
            }
            renameSync(source, destination)
          }),
          rmSync,
          statSync,
        },
        log: vi.fn(),
        logError,
        spawn: vi.fn(),
      })
    ).toBe(1)
    await expect(
      readFile(path.join(packageDir, 'dist', 'stale-file'), 'utf8')
    ).resolves.toBe('keep me')
    await expect(readFile(pathFile, 'utf8')).resolves.toBe('electron')
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('simulated rename failure')
    )
    expect(logError).not.toHaveBeenCalledWith(
      expect.stringContaining('failed to fully restore')
    )
  })

  it('keeps a validated repair when temporary backup cleanup fails', async () => {
    await mkdir(path.join(packageDir, 'dist'), { recursive: true })
    await writeFile(path.join(packageDir, 'dist', 'version'), VERSION)
    await writeFile(path.join(packageDir, 'path.txt'), 'electron')
    const logError = vi.fn()

    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        fs: {
          existsSync,
          readFileSync,
          renameSync,
          rmSync: vi.fn((target, options) => {
            if (String(target).includes('.motrix-backup-')) {
              throw new Error('simulated cleanup failure')
            }
            rmSync(target, options)
          }),
          statSync,
        },
        log: vi.fn(),
        logError,
        spawn: vi.fn(() => {
          writeRuntimeSync()
          return { status: 0, signal: null }
        }),
      })
    ).toBe(0)
    expect(inspectElectronRuntime(packageDir).complete).toBe(true)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('temporary backup could not be removed')
    )
  })

  it('rejects an installer success that still leaves an incomplete runtime', () => {
    expect(
      ensureElectronRuntime({
        electronPackageDir: packageDir,
        log: vi.fn(),
        logError: vi.fn(),
        spawn: vi.fn(() => ({ status: 0, signal: null })),
      })
    ).toBe(1)
    expect(inspectElectronRuntime(packageDir).complete).toBe(false)
  })
})
