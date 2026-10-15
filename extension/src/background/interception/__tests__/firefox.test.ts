import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeTarget } from '@/background/capture/probeSize'
import { runHandoff } from '@/background/handoff/runHandoff'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import {
  cancelFirefoxDownload,
  handleFirefoxDownloadSafely as handleFirefoxDownload,
} from '@/background/interception/firefox'
import { formToConfig } from '@/options/takeoverForm'
import type { Browser } from '@/shared/browser'

vi.mock('@/background/handoff/runHandoff', () => ({
  runHandoff: vi.fn(async () => {}),
}))
vi.mock('@/background/capture/probeSize', () => ({
  probeTarget: vi.fn(async () => ({
    sizeBytes: null,
    contentType: 'application/octet-stream',
  })),
}))

interface DownloadsStub {
  cancel: ReturnType<typeof vi.fn>
  erase: ReturnType<typeof vi.fn>
  search: ReturnType<typeof vi.fn>
  current?: Browser.downloads.DownloadItem
}

let downloads: DownloadsStub

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(probeTarget).mockReset().mockResolvedValue({
    sizeBytes: null,
    contentType: 'application/octet-stream',
  })
  downloads = {
    cancel: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
    search: vi.fn(async () => [downloads.current]),
  }
  ;(
    globalThis as Record<string, unknown> & { browser: Record<string, unknown> }
  ).browser.downloads = downloads
})

afterEach(() => vi.useRealTimers())

async function handleFirefoxDownloadSafely(
  item: Browser.downloads.DownloadItem,
  deps: ChromiumInterceptionDeps
): Promise<void> {
  downloads.current = { ...item, state: 'in_progress', paused: false }
  const operation = handleFirefoxDownload(item, {
    ...deps,
    selfExtensionId: deps.selfExtensionId ?? 'test-extension-id',
  })
  await vi.advanceTimersByTimeAsync(3500)
  await operation
}

describe('cancelFirefoxDownload', () => {
  it('cancels before erasing the history item', async () => {
    await cancelFirefoxDownload(7)

    expect(downloads.cancel).toHaveBeenCalledWith(7)
    expect(downloads.erase).toHaveBeenCalledWith({ id: 7 })
    expect(downloads.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      downloads.erase.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
  })

  it('treats erase failure as best-effort after cancellation', async () => {
    downloads.erase.mockRejectedValueOnce(new Error('history unavailable'))

    await expect(cancelFirefoxDownload(7)).resolves.toBeUndefined()
    expect(downloads.cancel).toHaveBeenCalledWith(7)
  })

  it('propagates cancel failure so the native download is not submitted twice', async () => {
    downloads.cancel.mockRejectedValueOnce(new Error('cancel failed'))

    await expect(cancelFirefoxDownload(7)).rejects.toThrow('cancel failed')
    expect(downloads.erase).not.toHaveBeenCalled()
  })
})

describe('handleFirefoxDownloadSafely', () => {
  it.each([
    { totalBytes: 1024, probedSize: null, handoff: false },
    { totalBytes: -1, probedSize: 1024, handoff: false },
    { totalBytes: -1, probedSize: null, handoff: false },
    { totalBytes: -1, probedSize: 10 * 1024 * 1024, handoff: true },
  ])(
    'honors a saved 10 MB minimum for TXT: browser=$totalBytes, probe=$probedSize',
    async ({ totalBytes, probedSize, handoff }) => {
      vi.mocked(probeTarget).mockResolvedValue({
        sizeBytes: probedSize,
        contentType: 'text/plain',
      })
      await handleFirefoxDownloadSafely(
        {
          id: 7,
          url: 'https://example.com/report.txt',
          filename: 'report.txt',
          mime: 'text/plain',
          totalBytes,
        } as Browser.downloads.DownloadItem,
        {
          getConfig: async () =>
            formToConfig(
              {
                enabled: true,
                thresholdMB: '10',
                unknownSizeAction: 'chrome',
                denylist: '',
              },
              1
            ),
          captureGuard: async () => ({ assertCurrent: vi.fn() }),
        } as unknown as ChromiumInterceptionDeps
      )
      expect(runHandoff).toHaveBeenCalledTimes(handoff ? 1 : 0)
      expect(probeTarget).toHaveBeenCalledTimes(totalBytes === 1024 ? 0 : 1)
      expect(downloads.cancel).not.toHaveBeenCalled()
    }
  )

  it.each(['', '10'])(
    'uses the chosen handler for unknown TXT sizes with threshold %s',
    async (thresholdMB) => {
      for (const unknownSizeAction of ['chrome', 'motrix'] as const) {
        vi.clearAllMocks()
        vi.mocked(probeTarget).mockResolvedValue({
          sizeBytes: null,
          contentType: 'text/plain',
        })
        await handleFirefoxDownloadSafely(
          {
            id: 7,
            url: 'https://example.com/report.txt',
            filename: 'report.txt',
            mime: 'text/plain',
            totalBytes: -1,
          } as Browser.downloads.DownloadItem,
          {
            getConfig: async () =>
              formToConfig(
                { enabled: true, thresholdMB, unknownSizeAction, denylist: '' },
                1
              ),
            captureGuard: async () => ({ assertCurrent: vi.fn() }),
          } as unknown as ChromiumInterceptionDeps
        )
        expect(runHandoff).toHaveBeenCalledTimes(
          unknownSizeAction === 'motrix' ? 1 : 0
        )
        expect(probeTarget).toHaveBeenCalledOnce()
      }
    }
  )

  it('preserves the native response without a probe in confirmation mode', async () => {
    await handleFirefoxDownloadSafely(
      {
        id: 7,
        url: 'https://example.com/one-use',
      } as Browser.downloads.DownloadItem,
      {
        getConfig: async () => ({ enabled: true, downloadMode: 'confirm' }),
      } as unknown as ChromiumInterceptionDeps
    )
    expect(probeTarget).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(runHandoff).not.toHaveBeenCalled()
  })

  it('opens confirmation without probing, cancelling, or replaying the browser response', async () => {
    const confirm = vi.fn(async () => {})
    await handleFirefoxDownloadSafely(
      {
        id: 7,
        url: 'https://example.com/once.zip',
        totalBytes: 1024,
      } as Browser.downloads.DownloadItem,
      {
        getConfig: async () => ({
          enabled: true,
          downloadMode: 'confirm',
          defaultAction: 'motrix',
          rules: [],
        }),
        captureGuard: async () => ({ origin: 'auto', assertCurrent: vi.fn() }),
        popup: { captureWindow: async () => 4 },
        confirm,
      } as unknown as ChromiumInterceptionDeps
    )
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'auto' }),
      4,
      expect.anything()
    )
    expect(probeTarget).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
    expect(runHandoff).not.toHaveBeenCalled()
  })

  it('passes only the leaf of a Windows download path to handoff', async () => {
    await handleFirefoxDownloadSafely(
      {
        id: 7,
        url: 'https://example.com/c-m9021',
        filename: String.raw`E:\Downloads\asset_v1.2.8.1.zip`,
        totalBytes: 1024,
      } as Browser.downloads.DownloadItem,
      {
        getConfig: async () => ({
          enabled: true,
          defaultAction: 'motrix',
          unknownSizeAction: 'motrix',
          rules: [],
        }),
        captureGuard: async () => ({ assertCurrent: vi.fn() }),
      } as unknown as ChromiumInterceptionDeps
    )
    expect(runHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFilename: 'asset_v1.2.8.1.zip',
        filenameFromUrl: false,
      }),
      expect.anything()
    )
  })

  it('leaves a form-POST download native when its GET replay serves HTML', async () => {
    // Firefox never holds the native download, so declining before the
    // handoff simply lets the browser finish the file it negotiated (#2185).
    vi.mocked(probeTarget).mockResolvedValueOnce({
      sizeBytes: null,
      contentType: 'text/html; charset=UTF-8',
    })
    vi.mocked(runHandoff).mockClear()
    await handleFirefoxDownloadSafely(
      {
        id: 8,
        url: 'https://uupdump.net/get.php?id=abc&pack=en-us&edition=core',
        filename: 'uupdump_abc.zip',
        mime: 'application/zip',
        totalBytes: -1,
      } as Browser.downloads.DownloadItem,
      {
        getConfig: async () => ({
          enabled: true,
          defaultAction: 'motrix',
          unknownSizeAction: 'motrix',
          rules: [],
        }),
        captureGuard: async () => ({ assertCurrent: vi.fn() }),
      } as unknown as ChromiumInterceptionDeps
    )
    expect(runHandoff).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('does not touch the original remote download or attempt a handoff', async () => {
    const captureGuard = vi.fn(async () => null)
    const getState = vi.fn()
    const deps = {
      getConfig: async () => ({ enabled: true }),
      captureGuard,
      manager: { getState },
    } as unknown as ChromiumInterceptionDeps
    await handleFirefoxDownloadSafely(
      {
        id: 7,
        url: 'https://example.com/file',
        totalBytes: -1,
      } as Browser.downloads.DownloadItem,
      deps
    )
    expect(captureGuard).toHaveBeenCalledOnce()
    expect(getState).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
  })
  it('contains a rejected startup barrier before touching the native download', async () => {
    const deps = {
      getConfig: async () => {
        throw new Error('background startup unavailable: private data')
      },
    } as unknown as ChromiumInterceptionDeps

    await expect(
      handleFirefoxDownloadSafely(
        {
          id: 7,
          url: 'https://private.example/download',
          totalBytes: 1,
        } as Browser.downloads.DownloadItem,
        deps
      )
    ).resolves.toBeUndefined()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
  })
})

it.each(['accepted', 'unknown', 'browser', 'skipped', 'failed'] as const)(
  'presents only an accepted Firefox handoff: %s',
  async (kind) => {
    const popup = {
      captureWindow: vi.fn(async () => 42),
      present: vi.fn(async () => {}),
    }
    vi.mocked(runHandoff).mockResolvedValueOnce({
      kind,
      operationId: 'op1',
      taskId: 'task1',
    } as never)
    await handleFirefoxDownloadSafely(
      {
        id: 7,
        url: 'https://example.com/file',
        totalBytes: 1024,
      } as Browser.downloads.DownloadItem,
      {
        popup,
        getConfig: async () => ({
          enabled: true,
          openTaskPanelAfterSubmit: true,
          defaultAction: 'motrix',
          rules: [],
        }),
        captureGuard: async () => ({
          origin: 'auto',
          endpointId: 'local',
          endpointRevision: 0,
          assertCurrent: vi.fn(),
        }),
      } as unknown as ChromiumInterceptionDeps
    )
    if (kind === 'accepted')
      expect(popup.present).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task1',
          operationId: 'op1',
          windowId: 42,
          enabledAtCapture: true,
        })
      )
    else expect(popup.present).not.toHaveBeenCalled()
  }
)
