import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import globalSetup from '../../e2e/global-setup'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawnSync = vi.fn()
  return { ...actual, spawnSync, default: { ...actual, spawnSync } }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = vi.fn()
  return { ...actual, existsSync, default: { ...actual, existsSync } }
})

const spawn = vi.mocked(spawnSync)
const exists = vi.mocked(existsSync)
const artifacts = [
  'dist/main/index.cjs',
  'dist/preload/preload.cjs',
  'dist/renderer/index.html',
].map((artifact) => path.join(process.cwd(), artifact))

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('MOTRIX_E2E_FORCE_BUILD', '')
  spawn.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  exists.mockImplementation((file) => artifacts.includes(String(file)))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Playwright global setup', () => {
  it('hydrates Electron before reusing already built artifacts', async () => {
    await globalSetup()

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      'pnpm',
      ['run', 'ensure:electron-runtime'],
      expect.objectContaining({
        cwd: process.cwd(),
        shell: process.platform === 'win32',
        stdio: 'inherit',
      })
    )
    expect(new Set(exists.mock.calls.map(([file]) => file))).toEqual(
      new Set(artifacts)
    )
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(
      exists.mock.invocationCallOrder[0]!
    )
  })

  it.each([
    [{ error: new Error('cannot spawn pnpm') }, 'cannot spawn pnpm'],
    [{ signal: 'SIGKILL', status: null }, 'was killed by SIGKILL'],
    [{ status: 2 }, 'exited with status 2'],
    [{ status: null }, 'exited with status unknown'],
  ])(
    'stops before artifact checks when hydration fails: %j',
    async (result, message) => {
      spawn.mockReturnValue(result as ReturnType<typeof spawnSync>)

      await expect(globalSetup()).rejects.toThrow(message)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(exists).not.toHaveBeenCalled()
    }
  )

  it.each(artifacts)(
    'hydrates and rebuilds when the required artifact %s is missing',
    async (missing) => {
      exists.mockImplementation(
        (file) => artifacts.includes(String(file)) && String(file) !== missing
      )

      await globalSetup()

      expect(spawn.mock.calls.map((call) => call[1])).toEqual([
        ['run', 'ensure:electron-runtime'],
        ['build'],
      ])
    }
  )

  it('rebuilds on request even when every artifact exists', async () => {
    vi.stubEnv('MOTRIX_E2E_FORCE_BUILD', '1')

    await globalSetup()

    expect(spawn.mock.calls.map((call) => call[1])).toEqual([
      ['run', 'ensure:electron-runtime'],
      ['build'],
    ])
  })

  it('propagates a failed rebuild instead of accepting existing artifacts', async () => {
    vi.stubEnv('MOTRIX_E2E_FORCE_BUILD', '1')
    spawn.mockReturnValueOnce({ status: 0 } as ReturnType<typeof spawnSync>)
    spawn.mockReturnValueOnce({ status: 9 } as ReturnType<typeof spawnSync>)

    await expect(globalSetup()).rejects.toThrow(
      'pnpm build exited with status 9'
    )
  })
})
