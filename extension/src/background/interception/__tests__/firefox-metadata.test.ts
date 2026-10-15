import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { probeTarget } from '@/background/capture/probeSize'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import {
  handleFirefoxDownloadSafely,
  registerFirefoxInterception,
} from '@/background/interception/firefox'
import { FIREFOX_METADATA_WAIT_MS } from '@/background/interception/firefoxMetadata'
import { log } from '@/background/log'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

vi.mock('@/background/capture/probeSize', () => ({
  probeTarget: vi.fn(),
}))

let current: Browser.downloads.DownloadItem | undefined
let deps: ChromiumInterceptionDeps
let config = { ...TAKEOVER_DEFAULT, enabled: true }
const submit = vi.fn(async () => ({ taskId: 'task1' }))
const confirm = vi.fn(async () => {})
const cancel = vi.fn(async () => {})
const erase = vi.fn(async () => {})
const search = vi.fn(async () => (current ? [{ ...current }] : []))
const captureCookies = vi.fn(async () => [])
const assertCurrent = vi.fn()
const created = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  log.setLevel('debug')
  config = { ...TAKEOVER_DEFAULT, enabled: true }
  current = {
    id: 7,
    url: 'https://cdn.example.com/file.zip?token=private',
    filename: '/Downloads/file.zip',
    referrer: 'https://example.com/share',
    mime: '',
    state: 'in_progress',
    paused: false,
    totalBytes: -1,
  } as Browser.downloads.DownloadItem
  vi.mocked(probeTarget).mockReset().mockResolvedValue({
    sizeBytes: null,
    contentType: null,
  })
  cancel.mockImplementation(async () => {
    if (current) current.state = 'interrupted'
  })
  assertCurrent.mockReset()
  captureCookies.mockReset().mockResolvedValue([])
  Object.assign(browser, {
    downloads: { search, cancel, erase, onCreated: { addListener: created } },
    cookies: { getAll: captureCookies },
  })
  deps = {
    getConfig: async () => config,
    captureGuard: async () => ({ origin: 'auto', assertCurrent }),
    manager: {
      getState: () => 'connected',
      getRpcStatus: () => ({ health: 'healthy' }),
      submitDownload: submit,
    },
    confirm,
    selfExtensionId: 'test-extension-id',
    notify: vi.fn(),
    isPaired: async () => true,
  } as unknown as ChromiumInterceptionDeps
})

afterEach(() => {
  log.setLevel('info')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function settle(operation: Promise<void>, ms = 3500) {
  await vi.advanceTimersByTimeAsync(ms)
  await operation
}

it('hands off a native size learned without an onChanged event after a failed probe', async () => {
  const snapshot = { ...current! }
  const operation = handleFirefoxDownloadSafely(snapshot, deps)
  await vi.advanceTimersByTimeAsync(200)
  current!.totalBytes = 20 * 1024 * 1024
  current!.mime = 'application/zip'
  await settle(operation)
  expect(snapshot.totalBytes).toBe(-1)
  expect(cancel).toHaveBeenCalledExactlyOnceWith(7)
  expect(submit).toHaveBeenCalledOnce()
  expect(probeTarget).toHaveBeenCalledOnce()
})

it('uses the native size rather than the size of a different probed response', async () => {
  current!.totalBytes = 1024
  config.rules = [{ id: 'small', match: { minSizeMB: 10 }, action: 'chrome' }]
  vi.mocked(probeTarget).mockResolvedValue({
    sizeBytes: 20 * 1024 * 1024,
    contentType: 'application/zip',
  })
  await settle(handleFirefoxDownloadSafely({ ...current! }, deps))
  expect(submit).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(probeTarget).not.toHaveBeenCalled()
})

it('confirms with late native metadata without requesting a one-use URL', async () => {
  config.downloadMode = 'confirm'
  const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
  await vi.advanceTimersByTimeAsync(200)
  current!.totalBytes = 2048
  await settle(operation)
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sizeBytes: 2048, origin: 'auto' }),
    undefined,
    expect.anything()
  )
  expect(probeTarget).not.toHaveBeenCalled()
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it.each(['direct', 'confirm'] as const)(
  'honors both unknown-size choices within a finite metadata budget in %s mode',
  async (downloadMode) => {
    config.downloadMode = downloadMode
    for (const unknownSizeAction of ['chrome', 'motrix'] as const) {
      vi.clearAllMocks()
      current!.state = 'in_progress'
      config.unknownSizeAction = unknownSizeAction
      const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
      await vi.advanceTimersByTimeAsync(FIREFOX_METADATA_WAIT_MS - 1)
      expect(confirm).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
      await settle(operation, 1)
      const accepted = unknownSizeAction === 'motrix' ? 1 : 0
      expect(confirm).toHaveBeenCalledTimes(
        downloadMode === 'confirm' ? accepted : 0
      )
      expect(submit).toHaveBeenCalledTimes(
        downloadMode === 'direct' ? accepted : 0
      )
    }
  }
)

it.each(['complete', 'interrupted', 'paused', 'erased'])(
  'leaves a native download alone when it becomes %s while waiting',
  async (state) => {
    config.unknownSizeAction = 'motrix'
    const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
    await vi.advanceTimersByTimeAsync(200)
    if (state === 'erased') current = undefined
    else if (state === 'paused') current!.paused = true
    else current!.state = state as Browser.downloads.DownloadItem['state']
    await settle(operation)
    expect(cancel).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  }
)

it('does not submit a transfer that completed during the fidelity probe', async () => {
  current!.totalBytes = 1024
  let finishProbe!: (value: { sizeBytes: null; contentType: null }) => void
  vi.mocked(probeTarget).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishProbe = resolve
      })
  )
  const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
  await vi.advanceTimersByTimeAsync(10)
  current!.state = 'complete'
  finishProbe({ sizeBytes: null, contentType: null })
  await settle(operation)
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('checks the native state again after preparing cookies and before cancellation', async () => {
  current!.totalBytes = 1024
  captureCookies.mockImplementation(async () => {
    current!.state = 'complete'
    return []
  })
  await settle(handleFirefoxDownloadSafely({ ...current! }, deps))
  expect(captureCookies).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
  expect(erase).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it('rechecks settings after the metadata wait', async () => {
  const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
  await vi.advanceTimersByTimeAsync(200)
  config.enabled = false
  current!.totalBytes = 1024
  await settle(operation)
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
})

it.each(['direct', 'confirm'] as const)(
  'keeps the original backend guard across the metadata wait in %s mode',
  async (downloadMode) => {
    config.downloadMode = downloadMode
    const operation = handleFirefoxDownloadSafely({ ...current! }, deps)
    await vi.advanceTimersByTimeAsync(200)
    current!.totalBytes = 1024
    assertCurrent.mockImplementation(() => {
      throw new Error('backend changed')
    })
    await settle(operation)
    expect(confirm).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  }
)

it('contains a failed metadata API without leaving a timer or cancelling', async () => {
  search.mockRejectedValueOnce(new Error('private URL in API error'))
  await settle(handleFirefoxDownloadSafely({ ...current! }, deps))
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a hung metadata API', async () => {
  search.mockImplementationOnce(() => new Promise(() => {}))
  await settle(handleFirefoxDownloadSafely({ ...current! }, deps))
  expect(cancel).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('deduplicates concurrent onCreated deliveries and skips self-issued downloads', async () => {
  registerFirefoxInterception(deps)
  const listener = created.mock.calls[0]![0] as (
    item: Browser.downloads.DownloadItem
  ) => void
  current!.totalBytes = 1024
  listener({ ...current!, byExtensionId: deps.selfExtensionId })
  await vi.advanceTimersByTimeAsync(0)
  expect(search).not.toHaveBeenCalled()
  listener({ ...current! })
  listener({ ...current! })
  await vi.advanceTimersByTimeAsync(3500)
  expect(submit).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
})

it('logs a decline using only the redacted host', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  await settle(handleFirefoxDownloadSafely({ ...current! }, deps))
  const output = JSON.stringify(debug.mock.calls)
  expect(output).toContain('decision=')
  expect(output).toContain('unknown')
  expect(output).toContain('https://cdn.example.com')
  expect(output).not.toContain('token=')
  expect(output).not.toContain('/Downloads/')
  expect(output).not.toContain('/file.zip')
})
