import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- JavaScript build script intentionally has no declarations
import {
  buildWindowsPlatform,
  cargoBuildArguments,
  parseArgs,
  WINDOWS_PLATFORM_TARGET,
} from '../../packages/windows-platform/build.mjs'

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/windows-platform'
)
const argv = ['--platform', 'win32', '--arch', 'x64']

describe('Windows platform helper build', () => {
  it('accepts only an explicit Windows x64 target', () => {
    expect(parseArgs(argv)).toEqual({ platform: 'win32', arch: 'x64' })
    expect(WINDOWS_PLATFORM_TARGET).toEqual({
      key: 'win32-x64',
      rustTarget: 'x86_64-pc-windows-msvc',
      binaryName: 'motrix-windows-platform.exe',
    })
  })

  it.each([
    [],
    ['--platform', 'win32'],
    ['--arch', 'x64'],
    ['--platform', 'darwin', '--arch', 'x64'],
    ['--platform', 'linux', '--arch', 'x64'],
    ['--platform', 'win32', '--arch', 'arm64'],
    ['--platform', 'win32', '--arch', 'ia32'],
    ['--platform', 'win32', '--arch'],
    ['--platform', '--arch', 'x64'],
    [...argv, '--platform', 'win32'],
    [...argv, '--arch', 'x64'],
    [...argv, '--task-id', 'OtherTask'],
  ])(
    'rejects invalid arguments before starting Cargo: %j',
    async (...input) => {
      const run = vi.fn()
      await expect(
        buildWindowsPlatform({ argv: input, env: {}, run })
      ).rejects.toThrow()
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('builds only the locked release executable with the fixed MSVC target', () => {
    const targetDirectory = path.join('temporary build', 'target')
    expect(cargoBuildArguments(targetDirectory)).toEqual([
      'build',
      '--manifest-path',
      path.join(packageDirectory, 'Cargo.toml'),
      '--release',
      '--locked',
      '--target',
      'x86_64-pc-windows-msvc',
      '--target-dir',
      targetDirectory,
      '--bin',
      'motrix-windows-platform',
    ])
  })

  it('uses argument arrays and rejects a failed Cargo process before copying output', async () => {
    const env = { CARGO: 'cargo-test', CARGO_TARGET_DIR: 'custom target' }
    const run = vi.fn().mockReturnValue({ status: 17 })
    await expect(buildWindowsPlatform({ argv, env, run })).rejects.toThrow(
      'exit code 17'
    )
    expect(run).toHaveBeenCalledWith(
      'cargo-test',
      cargoBuildArguments(path.join(packageDirectory, 'custom target')),
      { cwd: packageDirectory, env, shell: false, stdio: 'inherit' }
    )
  })

  it('does not treat a launch failure or a signal as a successful build', async () => {
    const failure = new Error('Cargo unavailable')
    await expect(
      buildWindowsPlatform({ argv, env: {}, run: () => ({ error: failure }) })
    ).rejects.toBe(failure)
    await expect(
      buildWindowsPlatform({
        argv,
        env: {},
        run: () => ({ status: null, signal: 'SIGTERM' }),
      })
    ).rejects.toThrow('exit code unknown')
  })
})
