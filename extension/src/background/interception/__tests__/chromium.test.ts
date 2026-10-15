import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeTarget } from '@/background/capture/probeSize'
import type { HandoffOps } from '@/background/handoff/runHandoff'
import { runHandoff } from '@/background/handoff/runHandoff'
import {
  type ChromiumInterceptionDeps,
  HOLD_DEADLINE_MS,
  registerChromiumInterception,
} from '@/background/interception/chromium'
import { formToConfig } from '@/options/takeoverForm'
import type { TakeoverConfig } from '@/shared/takeover'

vi.mock('@/background/handoff/runHandoff', () => ({
  runHandoff: vi.fn(async () => {}),
}))
vi.mock('@/background/capture/probeSize', () => ({
  probeTarget: vi.fn(async () => ({
    sizeBytes: 5 * 1024 * 1024, // 5 MiB
    contentType: 'application/octet-stream',
  })),
}))

const mockedRunHandoff = vi.mocked(runHandoff)

type Listener = (
  item: Record<string, unknown>,
  suggest: () => void
) => boolean | undefined

interface DownloadsStub {
  onDeterminingFilename: { addListener: ReturnType<typeof vi.fn> }
  cancel: ReturnType<typeof vi.fn>
  erase: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
}

let listener: Listener | undefined
let downloads: DownloadsStub

function enabledConfig(
  overrides: Partial<TakeoverConfig> = {}
): TakeoverConfig {
  return {
    enabled: true,
    consentAckVersion: 1,
    defaultAction: 'motrix',
    unknownSizeAction: 'chrome',
    rules: [],
    ...overrides,
  }
}

function makeDeps(cfg: TakeoverConfig): ChromiumInterceptionDeps {
  return {
    getConfig: vi.fn(async () => cfg),
    captureGuard: vi.fn(async () => ({
      origin: 'auto',
      assertCurrent: vi.fn(),
    })),
    manager: {
      getState: () => 'connected',
      getLastError: () => null,
      clearGateAndStart: vi.fn(async () => {}),
      submitDownload: vi.fn(async () => ({ taskId: 't1' })),
    },
    isPaired: vi.fn(async () => true),
    gate: { shouldAutoConnect: vi.fn(async () => true) },
    nudge: { maybeNudge: vi.fn(async () => {}) },
    notify: vi.fn(),
    selfExtensionId: 'self-ext-id',
  } as unknown as ChromiumInterceptionDeps
}

function item(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 7,
    url: 'https://files.example/a.bin',
    totalBytes: 1024,
    referrer: 'https://page.example/',
    filename: 'a.bin',
    mime: 'application/octet-stream',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(probeTarget)
    .mockReset()
    .mockResolvedValue({
      sizeBytes: 5 * 1024 * 1024,
      contentType: 'application/octet-stream',
    })
  listener = undefined
  downloads = {
    onDeterminingFilename: {
      addListener: vi.fn((cb: Listener) => {
        listener = cb
      }),
    },
    cancel: vi.fn(async () => {}),
    erase: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
  }
  // setup.ts assigns the SAME stub object to globalThis.chrome and
  // globalThis.browser, so installing on both keeps that invariant explicit:
  // chromium.ts registers via chrome.*, operates via browser.*.
  ;(
    globalThis as Record<string, unknown> & { chrome: Record<string, unknown> }
  ).chrome.downloads = downloads
  ;(
    globalThis as Record<string, unknown> & { browser: Record<string, unknown> }
  ).browser.downloads = downloads
})

afterEach(() => {
  vi.useRealTimers()
})

function register(cfg: TakeoverConfig): ChromiumInterceptionDeps {
  const deps = makeDeps(cfg)
  registerChromiumInterception(deps)
  expect(listener).toBeDefined()
  return deps
}

describe('registerChromiumInterception', () => {
  it('preserves an already-requested one-use download in confirmation mode without a probe', async () => {
    register(enabledConfig({ downloadMode: 'confirm' }))
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledOnce())
    expect(probeTarget).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.download).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('releases the native filename hold before opening confirmation and never cancels while waiting', async () => {
    vi.useFakeTimers()
    const deps = makeDeps(enabledConfig({ downloadMode: 'confirm' }))
    const suggest = vi.fn()
    let finish!: () => void
    const confirm = vi.fn(() => {
      expect(suggest).toHaveBeenCalledOnce()
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })
    registerChromiumInterception({
      ...deps,
      confirm,
      popup: { captureWindow: async () => 4 } as never,
    })
    listener?.(item(), suggest)
    await vi.waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'auto' }),
        4,
        expect.anything()
      )
    )
    await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS + 20_000)
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
    expect(probeTarget).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
    finish()
    await Promise.resolve()
    expect(suggest).toHaveBeenCalledOnce()
  })

  it('passes only the leaf of a Windows download path to handoff', async () => {
    register(enabledConfig())
    listener?.(
      item({ filename: String.raw`E:\Downloads\asset_v1.2.8.1.zip` }),
      vi.fn()
    )
    await vi.waitFor(() =>
      expect(mockedRunHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          suggestedFilename: 'asset_v1.2.8.1.zip',
          filenameFromUrl: false,
        }),
        expect.anything()
      )
    )
  })

  it('no-ops when onDeterminingFilename is unavailable (Firefox)', () => {
    ;(
      globalThis as Record<string, unknown> & {
        chrome: Record<string, unknown>
      }
    ).chrome.downloads = {}
    expect(() =>
      registerChromiumInterception(makeDeps(enabledConfig()))
    ).not.toThrow()
    expect(listener).toBeUndefined()
  })

  it('declines our own re-issued downloads synchronously (no hold)', () => {
    register(enabledConfig())
    const suggest = vi.fn()
    const ret = listener?.(item({ byExtensionId: 'self-ext-id' }), suggest)
    expect(ret).toBeUndefined() // Chrome auto-suggests; we never hold
    expect(suggest).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('declines non-http downloads synchronously', () => {
    register(enabledConfig())
    const suggest = vi.fn()
    expect(listener?.(item({ url: 'blob:abc' }), suggest)).toBeUndefined()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('holds eligible downloads by returning true', () => {
    register(enabledConfig())
    expect(listener?.(item(), vi.fn())).toBe(true)
  })

  it('releases (suggest once) when takeover is disabled', async () => {
    register(enabledConfig({ enabled: false }))
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('releases when the decision is chrome', async () => {
    register(enabledConfig({ defaultAction: 'chrome' }))
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it('leaves remote downloads intact before probing, connecting, or capturing data', async () => {
    const deps = register(
      enabledConfig({
        rules: [{ id: 'size', match: { minSizeMB: 100 }, action: 'chrome' }],
      })
    )
    vi.mocked(deps.captureGuard).mockResolvedValue(null)
    const suggest = vi.fn()
    listener?.(item({ totalBytes: -1 }), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    const { probeTarget } = await import('@/background/capture/probeSize')
    expect(probeTarget).not.toHaveBeenCalled()
    expect(mockedRunHandoff).not.toHaveBeenCalled()
    expect(deps.manager.clearGateAndStart).not.toHaveBeenCalled()
    expect(deps.manager.submitDownload).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
    expect(downloads.erase).not.toHaveBeenCalled()
    expect(downloads.download).not.toHaveBeenCalled()
  })

  it('probes size while held, then releases when a size rule diverts to chrome', async () => {
    // minSizeMB matches KNOWN sizes BELOW the threshold; probe returns 5 MiB.
    register(
      enabledConfig({
        defaultAction: 'motrix',
        rules: [{ id: 'r1', match: { minSizeMB: 100 }, action: 'chrome' }],
      })
    )
    const suggest = vi.fn()
    listener?.(item({ totalBytes: -1 }), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    const { probeTarget } = await import('@/background/capture/probeSize')
    expect(vi.mocked(probeTarget)).toHaveBeenCalledWith(
      'https://files.example/a.bin',
      expect.anything()
    )
    expect(mockedRunHandoff).not.toHaveBeenCalled()
  })

  it.each([
    { totalBytes: 1024, probedSize: null, handoff: false },
    { totalBytes: -1, probedSize: 1024, handoff: false },
    { totalBytes: -1, probedSize: null, handoff: false },
    { totalBytes: 0, probedSize: null, handoff: false },
    { totalBytes: 10 * 1024 * 1024, probedSize: null, handoff: true },
    { totalBytes: -1, probedSize: 10 * 1024 * 1024, handoff: true },
  ])(
    'honors a saved 10 MB minimum for TXT: browser=$totalBytes, probe=$probedSize',
    async ({ totalBytes, probedSize, handoff }) => {
      vi.mocked(probeTarget).mockResolvedValue({
        sizeBytes: probedSize,
        contentType: 'text/plain',
      })
      register(
        enabledConfig(
          formToConfig(
            {
              enabled: true,
              thresholdMB: '10',
              unknownSizeAction: 'chrome',
              denylist: '',
            },
            1
          )
        )
      )
      const suggest = vi.fn()
      listener?.(
        item({
          url: 'https://files.example/report.txt',
          filename: 'report.txt',
          mime: 'text/plain',
          totalBytes,
        }),
        suggest
      )
      await vi.waitFor(() => expect(suggest).toHaveBeenCalledOnce())
      expect(mockedRunHandoff).toHaveBeenCalledTimes(handoff ? 1 : 0)
      expect(probeTarget).toHaveBeenCalledTimes(totalBytes === 1024 ? 0 : 1)
      expect(downloads.cancel).not.toHaveBeenCalled()
      expect(downloads.download).not.toHaveBeenCalled()
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
        register(
          enabledConfig(
            formToConfig(
              { enabled: true, thresholdMB, unknownSizeAction, denylist: '' },
              1
            )
          )
        )
        const suggest = vi.fn()
        listener?.(
          item({ totalBytes: -1, mime: 'text/plain', filename: 'report.txt' }),
          suggest
        )
        await vi.waitFor(() => expect(suggest).toHaveBeenCalledOnce())
        expect(mockedRunHandoff).toHaveBeenCalledTimes(
          unknownSizeAction === 'motrix' ? 1 : 0
        )
        expect(probeTarget).toHaveBeenCalledOnce()
      }
    }
  )

  it('declines a form-POST download whose GET replay serves HTML', async () => {
    // uupdump.net: the browser saved the POST response (a zip); a GET to the
    // same URL returns the configuration page. Motrix can only replay GET, so
    // the download must stay native rather than land as a renamed HTML file.
    const { probeTarget } = await import('@/background/capture/probeSize')
    vi.mocked(probeTarget).mockResolvedValueOnce({
      sizeBytes: null,
      contentType: 'text/html; charset=UTF-8',
    })
    register(enabledConfig({ unknownSizeAction: 'motrix' }))
    const suggest = vi.fn()
    listener?.(
      item({
        url: 'https://uupdump.net/get.php?id=abc&pack=en-us&edition=core',
        filename: 'uupdump_abc.zip',
        mime: 'application/zip',
        totalBytes: -1,
      }),
      suggest
    )
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(mockedRunHandoff).not.toHaveBeenCalled()
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('still takes over an HTML page the user genuinely asked to download', async () => {
    const { probeTarget } = await import('@/background/capture/probeSize')
    vi.mocked(probeTarget).mockResolvedValueOnce({
      sizeBytes: null,
      contentType: 'text/html; charset=UTF-8',
    })
    register(enabledConfig({ unknownSizeAction: 'motrix' }))
    const suggest = vi.fn()
    listener?.(
      item({
        url: 'https://page.example/report.html',
        filename: 'report.html',
        mime: 'text/html',
        totalBytes: -1,
      }),
      suggest
    )
    await vi.waitFor(() => expect(mockedRunHandoff).toHaveBeenCalledTimes(1))
  })

  it('commit path: handoff cancels via ops → cancel+erase, suggest never called', async () => {
    mockedRunHandoff.mockImplementationOnce(async (_t, ops: HandoffOps) => {
      await ops.cancelNative()
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(downloads.cancel).toHaveBeenCalledWith(7))
    expect(downloads.erase).toHaveBeenCalledWith({ id: 7 })
    // Give the finally-release a microtask turn, then assert it stayed silent.
    await Promise.resolve()
    expect(suggest).not.toHaveBeenCalled()
  })

  it('decline path: handoff returns without cancelling → suggest once', async () => {
    mockedRunHandoff.mockImplementationOnce(async () => {}) // e.g. not paired → nudge
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('failure path: handoff throws → suggest once, native download survives', async () => {
    mockedRunHandoff.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledTimes(1))
    expect(downloads.cancel).not.toHaveBeenCalled()
  })

  it('deadline: a hung handoff cannot commit after the guard released', async () => {
    vi.useFakeTimers()
    let heldOps: HandoffOps | undefined
    mockedRunHandoff.mockImplementationOnce(async (_t, ops: HandoffOps) => {
      heldOps = ops
      await new Promise(() => {}) // hang forever
    })
    register(enabledConfig())
    const suggest = vi.fn()
    listener?.(item(), suggest)
    await vi.advanceTimersByTimeAsync(HOLD_DEADLINE_MS)
    expect(suggest).toHaveBeenCalledTimes(1)
    await expect(heldOps?.cancelNative()).rejects.toThrow(
      'download.preparation-timeout'
    )
    expect(downloads.cancel).not.toHaveBeenCalled()
  })
})

it.each(['accepted', 'unknown', 'browser', 'skipped', 'failed'] as const)(
  'presents only an accepted handoff after releasing the native hold: %s',
  async (kind) => {
    const suggest = vi.fn()
    const deps = makeDeps(enabledConfig({ openTaskPanelAfterSubmit: true }))
    const popup = {
      captureWindow: vi.fn(async () => 42),
      present: vi.fn(async () => {
        expect(suggest).toHaveBeenCalledOnce()
      }),
    }
    deps.popup = popup as never
    deps.captureGuard = vi.fn(async () => ({
      origin: 'auto',
      endpointId: 'local',
      endpointRevision: 0,
      assertCurrent: vi.fn(),
    }))
    mockedRunHandoff.mockResolvedValueOnce({
      kind,
      operationId: 'op1',
      taskId: 'task1',
    } as never)
    registerChromiumInterception(deps)
    listener?.(item(), suggest)
    await vi.waitFor(() => expect(suggest).toHaveBeenCalledOnce())
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
    expect(downloads.download).not.toHaveBeenCalled()
  }
)
