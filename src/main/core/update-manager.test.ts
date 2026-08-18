import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeUpdater,
  type FakeUpdater,
} from './__fixtures__/fake-updater'
import { isVersionAllowedForChannel, UpdateManager } from './update-manager'

describe('UpdateManager', () => {
  let eventBus: EventBus
  let updater: FakeUpdater
  let manager: UpdateManager

  beforeEach(() => {
    eventBus = new EventBus()
    updater = createFakeUpdater()
    manager = new UpdateManager({
      eventBus,
      updater,
      currentVersion: '2.0.0',
      channel: 'stable',
    })
  })

  describe('event forwarding', () => {
    it("forwards 'checking-for-update' to EventBus.UpdateCheckStarted", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateCheckStarted, handler)

      updater.fire('checking-for-update')

      expect(handler).toHaveBeenCalledOnce()
    })

    it("forwards 'update-available' with info payload", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateAvailable, handler)
      const info = { version: '2.0.1', releaseName: 'Spring' }

      updater.fire('update-available', info)

      expect(handler).toHaveBeenCalledWith(info)
    })

    it("forwards 'update-not-available' with info payload", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateNotAvailable, handler)
      const info = { version: '2.0.0' }

      updater.fire('update-not-available', info)

      expect(handler).toHaveBeenCalledWith(info)
    })

    it("forwards 'download-progress' with progress payload", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateDownloadProgress, handler)
      const progress = {
        percent: 42.5,
        bytesPerSecond: 1024 * 1024,
        transferred: 4_500_000,
        total: 10_000_000,
      }

      updater.fire('download-progress', progress)

      expect(handler).toHaveBeenCalledWith(progress)
    })

    it("forwards 'update-downloaded' with info payload", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateDownloaded, handler)
      const info = { version: '2.0.1', downloadedFile: '/tmp/Motrix.dmg' }

      updater.fire('update-downloaded', info)

      expect(handler).toHaveBeenCalledWith(info)
    })

    it("forwards 'update-cancelled' with info payload", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateCancelled, handler)
      const info = { version: '2.0.1' }

      updater.fire('update-cancelled', info)

      expect(handler).toHaveBeenCalledWith(info)
    })

    it("forwards 'error' to EventBus.UpdateError", () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateError, handler)
      const err = new Error('signature mismatch')

      updater.fire('error', err)

      expect(handler).toHaveBeenCalledWith(err)
    })
  })

  describe('imperative methods', () => {
    it('runs the explicit update flow from check through install', async () => {
      const phases: string[] = []
      eventBus.on(Events.UpdateStateChanged, (state) => {
        phases.push((state as { phase: string }).phase)
      })

      await manager.check()
      updater.fire('update-available', { version: '2.0.1' })
      await manager.download()
      updater.fire('download-progress', {
        percent: 75,
        bytesPerSecond: 1024,
        transferred: 75,
        total: 100,
      })
      updater.fire('update-downloaded', { version: '2.0.1' })
      manager.install()

      expect(phases).toEqual([
        'checking',
        'available',
        'downloading',
        'downloading',
        'downloaded',
      ])
      expect(updater.checkForUpdates).toHaveBeenCalledOnce()
      expect(updater.downloadUpdate).toHaveBeenCalledOnce()
      expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    })

    it('check() delegates to updater.checkForUpdates()', async () => {
      await manager.check()
      expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    })

    it('download() delegates after an update is available', async () => {
      updater.fire('update-available', { version: '2.0.1' })
      await manager.download()
      expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    })

    it('install() delegates only after download', () => {
      updater.fire('update-available', { version: '2.0.1' })
      updater.fire('update-downloaded', { version: '2.0.1' })

      manager.install()

      expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    })

    it('rejects download without an available version', async () => {
      await expect(manager.download()).rejects.toThrow(
        'No update is available to download'
      )
      expect(updater.downloadUpdate).not.toHaveBeenCalled()
    })

    it('rejects install before download completion', () => {
      expect(() => manager.install()).toThrow('Update is not ready to install')
      expect(updater.quitAndInstall).not.toHaveBeenCalled()
    })

    it('preserves the available version and allows retry after download failure', async () => {
      vi.mocked(updater.downloadUpdate).mockRejectedValueOnce(
        new Error('network unavailable')
      )
      updater.fire('update-available', { version: '2.0.1' })

      await expect(manager.download()).rejects.toThrow('network unavailable')
      expect(manager.getState()).toMatchObject({
        phase: 'error',
        availableVersion: '2.0.1',
        error: { message: 'network unavailable' },
      })

      await manager.download()

      expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
      expect(manager.getState()).toMatchObject({
        phase: 'downloading',
        availableVersion: '2.0.1',
      })
    })

    it('does not replace an in-progress or downloaded update with a new check', async () => {
      updater.fire('update-available', { version: '2.0.1' })
      updater.fire('download-progress', { percent: 20 })
      await expect(manager.check()).rejects.toThrow(
        'Cannot check while an update is downloading'
      )
      updater.fire('update-downloaded', { version: '2.0.1' })
      await expect(manager.check()).rejects.toThrow(
        'Cannot check while an update is downloading'
      )
      expect(updater.checkForUpdates).not.toHaveBeenCalled()
    })

    it('coalesces concurrent check and download calls', async () => {
      let finishCheck: (() => void) | undefined
      vi.mocked(updater.checkForUpdates).mockReturnValueOnce(
        new Promise((resolve) => {
          finishCheck = () => resolve(undefined)
        })
      )
      const firstCheck = manager.check()
      const secondCheck = manager.check()
      expect(updater.checkForUpdates).toHaveBeenCalledOnce()
      finishCheck?.()
      await Promise.all([firstCheck, secondCheck])

      updater.fire('update-available', { version: '2.0.1' })
      let finishDownload: (() => void) | undefined
      vi.mocked(updater.downloadUpdate).mockReturnValueOnce(
        new Promise((resolve) => {
          finishDownload = () => resolve(undefined)
        })
      )
      const firstDownload = manager.download()
      const secondDownload = manager.download()
      expect(updater.downloadUpdate).toHaveBeenCalledOnce()
      finishDownload?.()
      await Promise.all([firstDownload, secondDownload])
    })
  })

  describe('normalized state', () => {
    it('starts idle and emits a complete available snapshot', () => {
      const handler = vi.fn()
      eventBus.on(Events.UpdateStateChanged, handler)

      expect(manager.getState()).toEqual({
        phase: 'idle',
        currentVersion: '2.0.0',
      })

      updater.fire('update-available', {
        version: '2.0.1',
        releaseName: 'Spring',
      })

      expect(manager.getState()).toMatchObject({
        phase: 'available',
        currentVersion: '2.0.0',
        availableVersion: '2.0.1',
        releaseName: 'Spring',
      })
      expect(manager.getState().checkedAt).toEqual(expect.any(String))
      expect(handler).toHaveBeenLastCalledWith(manager.getState())
    })

    it('normalizes and clamps download progress', () => {
      updater.fire('update-available', { version: '2.0.1' })
      updater.fire('download-progress', {
        percent: 120,
        bytesPerSecond: 2048,
        transferred: 50,
        total: 100,
      })

      expect(manager.getState()).toMatchObject({
        phase: 'downloading',
        progress: {
          percent: 100,
          bytesPerSecond: 2048,
          transferred: 50,
          total: 100,
        },
      })
    })

    it('normalizes updater errors without exposing Error objects', () => {
      updater.fire('error', new Error('signature mismatch'))

      expect(manager.getState()).toEqual({
        phase: 'error',
        currentVersion: '2.0.0',
        error: { message: 'signature mismatch' },
      })
    })

    it('rejects available metadata without a version', () => {
      updater.fire('update-available', { releaseName: 'Broken release' })

      expect(manager.getState()).toEqual({
        phase: 'error',
        currentVersion: '2.0.0',
        error: { message: 'Update metadata did not include a version' },
      })
    })

    it('preserves the available version after cancellation and errors', () => {
      updater.fire('update-available', { version: '2.0.1' })
      updater.fire('update-cancelled', { version: '2.0.1' })
      expect(manager.getState()).toMatchObject({
        phase: 'cancelled',
        availableVersion: '2.0.1',
      })

      updater.fire('error', 'network unavailable')
      expect(manager.getState()).toMatchObject({
        phase: 'error',
        availableVersion: '2.0.1',
        error: { message: 'network unavailable' },
      })
    })
  })

  describe('unsupported builds', () => {
    let unsupported: UpdateManager

    beforeEach(() => {
      unsupported = new UpdateManager({
        eventBus,
        updater,
        currentVersion: '2.0.0',
        channel: 'stable',
        supported: false,
      })
    })

    it('starts in the unsupported phase', () => {
      expect(unsupported.getState()).toEqual({
        phase: 'unsupported',
        currentVersion: '2.0.0',
      })
    })

    it('check() rejects without contacting the updater and keeps the phase', async () => {
      await expect(unsupported.check()).rejects.toThrow(
        'Automatic updates are not supported in this build'
      )
      expect(updater.checkForUpdates).not.toHaveBeenCalled()
      expect(unsupported.getState().phase).toBe('unsupported')
    })

    it('download() rejects without contacting the updater', async () => {
      await expect(unsupported.download()).rejects.toThrow()
      expect(updater.downloadUpdate).not.toHaveBeenCalled()
    })
  })

  describe('constructor configuration', () => {
    it('disables autoDownload so check is non-destructive', () => {
      // Fresh updater so the assertion is independent of beforeEach.
      const fresh = createFakeUpdater()
      fresh.autoDownload = true
      fresh.autoInstallOnAppQuit = true

      new UpdateManager({
        eventBus: new EventBus(),
        updater: fresh,
        currentVersion: '2.0.0',
        channel: 'stable',
      })

      expect(fresh.autoDownload).toBe(false)
      expect(fresh.autoInstallOnAppQuit).toBe(false)
      expect(fresh.channel).toBe('latest')
      expect(fresh.allowPrerelease).toBe(false)
      expect(fresh.allowDowngrade).toBe(false)
    })

    it('maps beta to its manifest channel without enabling downgrade', () => {
      const betaUpdater = createFakeUpdater()

      const betaManager = new UpdateManager({
        eventBus: new EventBus(),
        updater: betaUpdater,
        currentVersion: '2.1.0-beta.1',
        channel: 'beta',
      })

      expect(betaManager.getChannel()).toBe('beta')
      expect(betaUpdater.channel).toBe('beta')
      expect(betaUpdater.allowPrerelease).toBe(true)
      expect(betaUpdater.allowDowngrade).toBe(false)
    })

    it('reconfigures and clears a prior-channel available snapshot', () => {
      updater.fire('update-available', { version: '2.1.0' })
      expect(manager.getState().phase).toBe('available')

      manager.setChannel('beta')

      expect(updater.channel).toBe('beta')
      expect(updater.allowPrerelease).toBe(true)
      expect(updater.allowDowngrade).toBe(false)
      expect(manager.getState()).toEqual({
        phase: 'idle',
        currentVersion: '2.0.0',
      })
    })

    it('wraps the upstream support check with the channel policy', async () => {
      await expect(
        updater.isUpdateSupported(supportInfo('2.1.0-beta.1'))
      ).resolves.toBe(false)

      manager.setChannel('beta')
      await expect(
        updater.isUpdateSupported(supportInfo('2.1.0-beta.1'))
      ).resolves.toBe(true)
      await expect(
        updater.isUpdateSupported(supportInfo('2.1.0-alpha.1'))
      ).resolves.toBe(false)
    })
  })
})

function supportInfo(version: string) {
  return {
    version,
    files: [],
    path: '',
    sha512: '',
    releaseDate: '2026-08-09T00:00:00.000Z',
  }
}

describe('isVersionAllowedForChannel', () => {
  it.each([
    ['2.1.0', 'stable', true],
    ['2.1.0+build.7', 'stable', true],
    ['2.1.0-beta.1', 'stable', false],
    ['2.1.0-beta.1', 'beta', true],
    ['2.1.0', 'beta', true],
    ['2.1.0-alpha.1', 'beta', false],
    ['2.1.0-rc.1', 'beta', false],
    ['not-semver', 'beta', false],
  ] as const)('%s on %s is %s', (version, channel, allowed) => {
    expect(isVersionAllowedForChannel(version, channel)).toBe(allowed)
  })
})
