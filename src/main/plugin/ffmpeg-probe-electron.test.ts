import type { FfmpegDetection } from '@core/plugin/capabilities/ffmpeg-detect'
import { describe, expect, it, vi } from 'vitest'
import type { RunCommand, RunResult } from '../cli/command-runner'
import { makeElectronFfmpegProbe } from './ffmpeg-probe-electron'

function result(code: number | null, overrides: Partial<RunResult> = {}) {
  return { code, stdout: '', stderr: '', ...overrides }
}

function successfulProbe(binaryPath: string): FfmpegDetection {
  return { available: true, binaryPath, version: '7.1' }
}

describe('makeElectronFfmpegProbe', () => {
  it('reports a candidate that cannot be resolved as missing', async () => {
    const env = { PATH: '/tools' }
    const resolve = vi.fn(async () => null)
    const run: RunCommand = vi.fn(async () => result(0))
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env,
      resolve,
      run,
      probe,
    })

    await expect(detect('/missing/ffmpeg')).resolves.toEqual({
      available: false,
      failureReason: 'missing',
    })
    expect(resolve).toHaveBeenCalledWith('/missing/ffmpeg', env, {
      platform: 'darwin',
    })
    expect(run).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes an unquarantined macOS executable', async () => {
    const run: RunCommand = vi.fn(async () => result(0))
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env: {},
      resolve: vi.fn(async () => '/custom/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/custom/ffmpeg')).resolves.toEqual(
      successfulProbe('/custom/ffmpeg')
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/xattr',
      ['/custom/ffmpeg'],
      expect.any(Object)
    )
    expect(probe).toHaveBeenCalledWith('/custom/ffmpeg')
  })

  it('does not execute when quarantine attributes cannot be inspected', async () => {
    const run: RunCommand = vi.fn(async () =>
      result(1, { stderr: 'Operation not permitted' })
    )
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env: {},
      resolve: vi.fn(async () => '/custom/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/custom/ffmpeg')).resolves.toMatchObject({
      available: false,
      binaryPath: '/custom/ffmpeg',
      failureReason: 'untrusted',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes a quarantined executable accepted by Gatekeeper', async () => {
    const run: RunCommand = vi.fn(async (command) =>
      command === '/usr/bin/xattr'
        ? result(0, { stdout: 'com.apple.quarantine\n' })
        : result(0)
    )
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env: {},
      resolve: vi.fn(async () => '/downloads/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/downloads/ffmpeg')).resolves.toEqual(
      successfulProbe('/downloads/ffmpeg')
    )
    expect(run).toHaveBeenNthCalledWith(
      2,
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '--verbose=4', '/downloads/ffmpeg'],
      expect.any(Object)
    )
    expect(probe).toHaveBeenCalledWith('/downloads/ffmpeg')
  })

  it('does not execute a quarantined executable rejected by Gatekeeper', async () => {
    const run: RunCommand = vi.fn(async (command) =>
      command === '/usr/bin/xattr'
        ? result(0, { stdout: 'com.apple.quarantine\n' })
        : result(3, { stderr: 'rejected' })
    )
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env: {},
      resolve: vi.fn(async () => '/downloads/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/downloads/ffmpeg')).resolves.toEqual({
      available: false,
      binaryPath: '/downloads/ffmpeg',
      failureReason: 'untrusted',
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(probe).not.toHaveBeenCalled()
  })

  it('handles a failed Gatekeeper assessment conservatively', async () => {
    const run: RunCommand = vi.fn(async (command) =>
      command === '/usr/bin/xattr'
        ? result(0, { stdout: 'com.apple.quarantine\n' })
        : result(null, { timedOut: true })
    )
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'darwin',
      env: {},
      resolve: vi.fn(async () => '/downloads/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/downloads/ffmpeg')).resolves.toMatchObject({
      available: false,
      binaryPath: '/downloads/ffmpeg',
      failureReason: 'untrusted',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('skips xattr and spctl outside macOS', async () => {
    const run: RunCommand = vi.fn(async () => result(0))
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'linux',
      env: {},
      resolve: vi.fn(async () => '/usr/bin/ffmpeg'),
      run,
      probe,
    })

    await expect(detect('/usr/bin/ffmpeg')).resolves.toEqual(
      successfulProbe('/usr/bin/ffmpeg')
    )
    expect(run).not.toHaveBeenCalled()
    expect(probe).toHaveBeenCalledWith('/usr/bin/ffmpeg')
  })

  it('resolves a bare PATH candidate before probing it', async () => {
    const env = { PATH: '/opt/homebrew/bin:/usr/bin' }
    const resolve = vi.fn(async () => '/opt/homebrew/bin/ffmpeg')
    const probe = vi.fn(async (binaryPath: string) =>
      successfulProbe(binaryPath)
    )
    const detect = makeElectronFfmpegProbe({
      platform: 'linux',
      env,
      resolve,
      run: vi.fn(async () => result(0)),
      probe,
    })

    await expect(detect('ffmpeg')).resolves.toEqual(
      successfulProbe('/opt/homebrew/bin/ffmpeg')
    )
    expect(resolve).toHaveBeenCalledWith('ffmpeg', env, {
      platform: 'linux',
    })
    expect(probe).toHaveBeenCalledWith('/opt/homebrew/bin/ffmpeg')
  })
})
