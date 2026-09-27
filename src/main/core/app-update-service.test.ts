import { EventBus } from '@core/events/event-bus'
import { ErrorCode } from '@shared/errors'
import { describe, expect, it, vi } from 'vitest'
import { createFakeUpdater } from './__fixtures__/fake-updater'
import { createAppUpdateService } from './app-update-service'

describe('createAppUpdateService', () => {
  it.each([false, true])(
    'keeps Windows packages inert even when update support is %s',
    async (supported) => {
      const loadUpdater = vi.fn(async () => {
        throw new Error('Windows package must not load electron-updater')
      })
      const service = await createAppUpdateService({
        eventBus: new EventBus(),
        currentVersion: '2.0.0',
        channel: 'stable',
        isWindowsPackage: true,
        supported,
        loadUpdater,
        getManagedMessage: () => 'Updates come from the installation source',
      })

      await expect(service.check()).rejects.toMatchObject({
        code: ErrorCode.AppUpdateManaged,
      })
      await expect(service.download()).rejects.toMatchObject({
        code: ErrorCode.AppUpdateManaged,
      })
      expect(() => service.install()).toThrow(
        expect.objectContaining({ code: ErrorCode.AppUpdateManaged })
      )
      service.setChannel('beta')
      await expect(service.check()).rejects.toMatchObject({
        code: ErrorCode.AppUpdateManaged,
      })

      expect(loadUpdater).not.toHaveBeenCalled()
      expect(service.getChannel()).toBe('beta')
      expect(service.getState()).toEqual({
        phase: 'managed',
        currentVersion: '2.0.0',
        updateAuthority: 'system',
      })
    }
  )

  it('localizes each managed error without changing the managed snapshot', async () => {
    let message = 'Updates come from the installation source'
    const service = await createAppUpdateService({
      eventBus: new EventBus(),
      currentVersion: '2.0.0-beta.41',
      channel: 'beta',
      isWindowsPackage: true,
      supported: false,
      loadUpdater: vi.fn(),
      getManagedMessage: () => message,
    })

    await expect(service.check()).rejects.toThrow(message)
    message = 'Use the original installation source to update'
    await expect(service.download()).rejects.toThrow(message)
    service.getState().phase = 'available'
    expect(service.getState().phase).toBe('managed')
  })

  it('retains the direct-build update lifecycle and channel handling', async () => {
    const updater = createFakeUpdater()
    const loadUpdater = vi.fn(async () => updater)
    const service = await createAppUpdateService({
      eventBus: new EventBus(),
      currentVersion: '2.0.0',
      channel: 'stable',
      isWindowsPackage: false,
      supported: true,
      loadUpdater,
      getManagedMessage: vi.fn(),
    })

    await service.check()
    updater.fire('update-available', { version: '2.0.1' })
    await service.download()
    updater.fire('update-downloaded', { version: '2.0.1' })
    service.install()
    service.setChannel('beta')

    expect(loadUpdater).toHaveBeenCalledOnce()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
    expect(updater.channel).toBe('beta')
  })

  it('preserves unsupported direct builds', async () => {
    const updater = createFakeUpdater()
    const service = await createAppUpdateService({
      eventBus: new EventBus(),
      currentVersion: '2.0.0',
      channel: 'stable',
      isWindowsPackage: false,
      supported: false,
      loadUpdater: async () => updater,
      getManagedMessage: vi.fn(),
    })

    expect(service.getState().phase).toBe('unsupported')
    updater.fire('update-downloaded', { version: '2.0.1' })
    expect(() => service.install()).toThrow()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
