import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventBus } from '@core/events/event-bus'
import { SettingsManager } from '@core/settings/settings-manager'
import { Events } from '@shared/protocol/events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeoIPDownloader } from './geo-ip-downloader'
import { GeoIPManager } from './geo-ip-manager'
import type { GeoIPService } from './geo-ip-service'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, reject, resolve }
}

function makeFakeDownloader(): GeoIPDownloader {
  return {
    download: vi.fn().mockResolvedValue({
      sizeBytes: 9_000_000,
      version: 'v1.2026.05',
    }),
  } as unknown as GeoIPDownloader
}

function makeFakeService(): GeoIPService {
  let loaded = false
  return {
    open: vi.fn(async () => {
      loaded = true
      return true
    }),
    reload: vi.fn(async () => {
      loaded = true
      return true
    }),
    close: vi.fn(() => {
      loaded = false
    }),
    isLoaded: vi.fn(() => loaded),
    lookupCountry: vi.fn(() => ({ code: 'US', name: 'United States' })),
  } as unknown as GeoIPService
}

function deferServiceReload(service: GeoIPService) {
  const started = deferred<void>()
  const release = deferred<void>()
  let loaded = false

  service.reload = vi.fn(async () => {
    started.resolve(undefined)
    await release.promise
    loaded = true
    return true
  })
  service.close = vi.fn(() => {
    loaded = false
  })
  service.isLoaded = vi.fn(() => loaded)

  return { release, started }
}

interface Harness {
  manager: GeoIPManager
  settingsManager: SettingsManager
  eventBus: EventBus
  downloader: GeoIPDownloader
  service: GeoIPService
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'geoip-mgr-'))
  const settingsPath = path.join(tmp, 'settings.json')
  const dbPath = path.join(tmp, 'geoip', 'GeoLite2-Country.mmdb')

  const settingsManager = new SettingsManager(settingsPath)
  await settingsManager.load()

  const eventBus = new EventBus()
  const downloader = makeFakeDownloader()
  const service = makeFakeService()
  const manager = new GeoIPManager({
    settingsManager,
    eventBus,
    dbPath,
    schedulerIntervalMs: 1000,
    downloader,
    service,
  })

  return {
    manager,
    settingsManager,
    eventBus,
    downloader,
    service,
    async cleanup() {
      await manager.stop()
      await rm(tmp, { recursive: true, force: true })
    },
  }
}

describe('GeoIPManager', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await h.cleanup()
  })

  it('does not open the DB at start when GeoIP is disabled', async () => {
    await h.manager.start()
    expect(h.service.open).not.toHaveBeenCalled()
    expect(h.manager.isEnabled()).toBe(false)
    expect(h.manager.lookupCountry('1.2.3.4')).toBeNull()
  })

  it('opens the DB at start when GeoIP is enabled', async () => {
    await h.settingsManager.update({ geoip: { enabled: true } })
    await h.manager.start()
    expect(h.service.open).toHaveBeenCalled()
  })

  it('triggerUpdate downloads, persists settings, and emits status events', async () => {
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'loyalsoldier' },
    })
    const events: unknown[] = []
    h.eventBus.on(Events.GeoIPStatusChanged, (s) => events.push(s))
    await h.manager.start()

    const status = await h.manager.triggerUpdate()
    expect(h.downloader.download).toHaveBeenCalledOnce()
    expect(h.service.reload).toHaveBeenCalled()
    expect(status.lastUpdatedAt).toBeGreaterThan(0)
    expect(status.databaseVersion).toBe('v1.2026.05')
    expect(status.sizeBytes).toBe(9_000_000)
    expect(events.length).toBeGreaterThanOrEqual(2) // at-start + at-end
  })

  it('coalesces concurrent triggerUpdate calls into one download', async () => {
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'loyalsoldier' },
    })
    await h.manager.start()
    const [a, b, c] = await Promise.all([
      h.manager.triggerUpdate(),
      h.manager.triggerUpdate(),
      h.manager.triggerUpdate(),
    ])
    expect(h.downloader.download).toHaveBeenCalledOnce()
    expect(a.lastUpdatedAt).toBe(b.lastUpdatedAt)
    expect(b.lastUpdatedAt).toBe(c.lastUpdatedAt)
  })

  it('rejects with GeoIPSourceUnsupported when source = maxmind', async () => {
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'maxmind' },
    })
    await h.manager.start()
    await expect(h.manager.triggerUpdate()).rejects.toThrow(
      /MaxMind official source/
    )
    expect(h.downloader.download).not.toHaveBeenCalled()
    expect(h.manager.getStatus().lastError).toMatch(/MaxMind/)
  })

  it('rejects when source = custom with empty URL', async () => {
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'custom', customUrl: '' },
    })
    await h.manager.start()
    await expect(h.manager.triggerUpdate()).rejects.toThrow(/No download URL/)
  })

  it('records lastError on download failure and clears isDownloading', async () => {
    h.downloader.download = vi
      .fn()
      .mockRejectedValue(new Error('connection reset'))
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'loyalsoldier' },
    })
    await h.manager.start()
    await expect(h.manager.triggerUpdate()).rejects.toThrow(/connection reset/)
    const status = h.manager.getStatus()
    expect(status.isDownloading).toBe(false)
    expect(status.lastError).toBe('connection reset')
  })

  it('auto-update tick fires when interval elapsed and skips when fresh', async () => {
    vi.useFakeTimers()
    await h.settingsManager.update({
      geoip: {
        enabled: true,
        source: 'loyalsoldier',
        autoUpdate: true,
        autoUpdateIntervalDays: 7,
        // Pretend the last update was 8 days ago.
        lastUpdatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      },
    })
    await h.manager.start()
    await vi.advanceTimersByTimeAsync(1500)
    // setInterval fired once at t=1000ms; tick saw lastUpdatedAt 8d
    // back, so a download was triggered.
    expect(h.downloader.download).toHaveBeenCalled()

    // After the download lastUpdatedAt is "now", so the next tick
    // must not fire a fresh download.
    const callsAfterFirst = (h.downloader.download as ReturnType<typeof vi.fn>)
      .mock.calls.length
    await vi.advanceTimersByTimeAsync(1500)
    expect(
      (h.downloader.download as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(callsAfterFirst)
  })

  it('reloads the service when GeoIP transitions from disabled to enabled', async () => {
    const previous = h.settingsManager.get().geoip
    await h.manager.start()
    await h.settingsManager.update({ geoip: { enabled: true } })
    const next = h.settingsManager.get().geoip
    const statuses: unknown[] = []
    h.eventBus.on(Events.GeoIPStatusChanged, (status) => statuses.push(status))
    await h.manager.onSettingsChanged(previous, next)
    expect(h.service.reload).toHaveBeenCalled()
    expect(statuses).toEqual([
      expect.objectContaining({ enabled: true, loaded: true }),
    ])
  })

  it('closes the service when GeoIP transitions from enabled to disabled', async () => {
    await h.settingsManager.update({ geoip: { enabled: true } })
    await h.manager.start()
    const previous = h.settingsManager.get().geoip
    await h.settingsManager.update({ geoip: { enabled: false } })
    const next = h.settingsManager.get().geoip
    const statuses: unknown[] = []
    h.eventBus.on(Events.GeoIPStatusChanged, (status) => statuses.push(status))
    await h.manager.onSettingsChanged(previous, next)
    expect(h.service.close).toHaveBeenCalled()
    expect(statuses).toEqual([
      expect.objectContaining({ enabled: false, loaded: false }),
    ])
  })

  it('keeps the service unloaded when disable overtakes a pending enable reload', async () => {
    const reload = deferServiceReload(h.service)
    const initiallyDisabled = structuredClone(h.settingsManager.get().geoip)
    await h.manager.start()

    await h.settingsManager.update({ geoip: { enabled: true } })
    const enabled = structuredClone(h.settingsManager.get().geoip)
    const enableChange = h.manager.onSettingsChanged(initiallyDisabled, enabled)
    await reload.started.promise

    await h.settingsManager.update({ geoip: { enabled: false } })
    const disabledAgain = structuredClone(h.settingsManager.get().geoip)
    const disableChange = h.manager.onSettingsChanged(enabled, disabledAgain)

    reload.release.resolve(undefined)
    await Promise.all([enableChange, disableChange])

    expect(h.manager.getStatus()).toMatchObject({
      enabled: false,
      loaded: false,
    })
  })

  it('keeps the service unloaded when a download finishes after disable', async () => {
    const downloadStarted = deferred<void>()
    const download = deferred<{ sizeBytes: number; version: string }>()
    h.downloader.download = vi.fn(async () => {
      downloadStarted.resolve(undefined)
      return download.promise
    })
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'loyalsoldier' },
    })
    await h.manager.start()

    const update = h.manager.triggerUpdate()
    await downloadStarted.promise
    const enabled = structuredClone(h.settingsManager.get().geoip)
    await h.settingsManager.update({ geoip: { enabled: false } })
    const disabled = structuredClone(h.settingsManager.get().geoip)
    const disableChange = h.manager.onSettingsChanged(enabled, disabled)

    download.resolve({ sizeBytes: 9_000_000, version: 'v1.2026.05' })
    await Promise.all([update, disableChange])

    expect(h.manager.getStatus()).toMatchObject({
      enabled: false,
      loaded: false,
    })
  })

  it('waits for a pending enable reload before stop finishes unloaded', async () => {
    const reload = deferServiceReload(h.service)
    const initiallyDisabled = structuredClone(h.settingsManager.get().geoip)
    await h.manager.start()
    await h.settingsManager.update({ geoip: { enabled: true } })
    const enabled = structuredClone(h.settingsManager.get().geoip)

    const enableChange = h.manager.onSettingsChanged(initiallyDisabled, enabled)
    await reload.started.promise

    let stopSettled = false
    const stop = h.manager.stop().then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    const settledBeforeReload = stopSettled

    reload.release.resolve(undefined)
    await Promise.all([enableChange, stop])

    expect(settledBeforeReload).toBe(false)
    expect(h.manager.getStatus().loaded).toBe(false)
  })

  it('publishes an update as in-flight before status listeners can stop it', async () => {
    const downloadStarted = deferred<void>()
    const download = deferred<{ sizeBytes: number; version: string }>()
    h.downloader.download = vi.fn(async () => {
      downloadStarted.resolve(undefined)
      return download.promise
    })
    await h.settingsManager.update({
      geoip: { enabled: true, source: 'loyalsoldier' },
    })
    await h.manager.start()

    const stopRequest: { promise?: Promise<void> } = {}
    h.eventBus.on(Events.GeoIPStatusChanged, () => {
      if (h.manager.getStatus().isDownloading && !stopRequest.promise) {
        stopRequest.promise = h.manager.stop()
      }
    })
    const update = h.manager.triggerUpdate()
    await downloadStarted.promise
    const pendingStop = stopRequest.promise
    if (!pendingStop) throw new Error('status listener did not request stop')

    let stopSettled = false
    void pendingStop.then(() => {
      stopSettled = true
    })
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    download.resolve({ sizeBytes: 9_000_000, version: 'v1.2026.05' })
    await Promise.all([update, pendingStop])
    expect(h.manager.getStatus().loaded).toBe(false)
  })
})
