import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConfirmationResult } from '@/background/DownloadConfirmationService'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { extensionBrowser as browser } from '@/shared/browser'
import { TAKEOVER_DEFAULT, type TakeoverConfig } from '@/shared/takeover'

let listener: (
  details: Record<string, unknown>
) => Promise<{ cancel?: boolean }>
let change: (
  changes: Record<string, { newValue?: unknown }>,
  area: string
) => void
let cfg: TakeoverConfig
let stored: Record<string, unknown>
let download: ReturnType<typeof vi.fn>
let submit: ReturnType<typeof vi.fn>
let confirm: ReturnType<
  typeof vi.fn<
    (
      target: unknown,
      windowId: unknown,
      guard: unknown
    ) => Promise<ConfirmationResult>
  >
>
let deps: ChromiumInterceptionDeps

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  cfg = { ...TAKEOVER_DEFAULT, enabled: true }
  stored = {}
  download = vi.fn(async () => 1)
  submit = vi.fn(async () => ({ taskId: 'task' }))
  confirm = vi.fn(async () => ({ action: 'cancel' }))
  Object.assign(browser, {
    downloads: { download },
    tabs: {
      get: vi.fn(async () => ({ url: 'https://example.com/', windowId: 1 })),
    },
    cookies: { getAll: vi.fn(async () => []) },
    webRequest: {
      onHeadersReceived: {
        addListener: vi.fn((fn) => {
          listener = fn
        }),
      },
    },
  })
  vi.mocked(browser.storage.local.get).mockImplementation(async () => stored)
  vi.mocked(browser.storage.onChanged.addListener).mockImplementation((fn) => {
    change = fn
  })
  deps = {
    captureGuard: async () => ({ origin: 'auto', assertCurrent() {} }),
    getConfig: async () => cfg,
    manager: {
      getState: () => 'connected',
      getRpcStatus: () => ({ health: 'healthy' }),
      submitDownload: submit,
    },
    isPaired: async () => true,
    gate: { shouldAutoConnect: async () => true },
    nudge: { maybeNudge: async () => {} },
    notify: vi.fn(),
  } as unknown as ChromiumInterceptionDeps
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
const request = (overrides = {}) => ({
  url: 'https://example.com/file.zip',
  method: 'GET',
  statusCode: 200,
  type: 'main_frame',
  tabId: 1,
  responseHeaders: [
    { name: 'Content-Type', value: 'application/zip' },
    { name: 'Content-Disposition', value: 'attachment' },
    { name: 'Content-Length', value: '1024' },
  ],
  ...overrides,
})
const register = async () => {
  const { registerWebRequestEarlyTakeover } = await import(
    '@/background/interception/webRequestEarly'
  )
  registerWebRequestEarlyTakeover(deps, { confirmRequest: confirm })
}
const deliver = async () => {
  await vi.advanceTimersByTimeAsync(1)
}

it('defaults early on, cancels before submission, and retains automatic origin', async () => {
  await register()
  expect(await listener(request())).toEqual({ cancel: true })
  expect(submit).not.toHaveBeenCalled()
  await deliver()
  expect(submit).toHaveBeenCalledOnce()
  expect(submit.mock.calls[0]?.[1]).toMatchObject({ automaticTakeover: true })
  expect(download).not.toHaveBeenCalled()
})
it('defaults the master switch off', async () => {
  cfg = TAKEOVER_DEFAULT
  await register()
  expect(await listener(request())).toEqual({})
  await deliver()
  expect(submit).not.toHaveBeenCalled()
})
it.each([
  {
    rules: [
      {
        id: 'excluded',
        match: { domains: ['example.com'] },
        action: 'chrome' as const,
      },
    ],
  },
  {
    rules: [
      { id: 'small', match: { minSizeMB: 10 }, action: 'chrome' as const },
    ],
  },
  { defaultAction: 'chrome' as const },
])('applies the complete policy before cancellation: %j', async (config) => {
  Object.assign(cfg, config)
  await register()
  expect(await listener(request())).toEqual({})
  expect(submit).not.toHaveBeenCalled()
})
it.each(['chrome', 'motrix'] as const)(
  'honors unknown size action %s',
  async (action) => {
    cfg.unknownSizeAction = action
    await register()
    expect(
      await listener(
        request({
          responseHeaders: [
            { name: 'Content-Disposition', value: 'attachment' },
          ],
        })
      )
    ).toEqual(action === 'motrix' ? { cancel: true } : {})
  }
)
it.each([
  { tabId: -1 },
  { method: 'POST' },
  { statusCode: 302 },
  { type: 'media' },
  { originUrl: 'moz-extension://test-id/background.html' },
  { documentUrl: 'moz-extension://test-id/' },
  { responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }] },
  {
    responseHeaders: [
      { name: 'Content-Type', value: 'application/pdf' },
      {
        name: 'Content-Disposition',
        value: 'inline; filename="attachment.pdf"',
      },
    ],
  },
])('leaves non-download and extension requests alone: %j', async (details) => {
  await register()
  expect(await listener(request(details))).toEqual({})
})
it('accepts explicit PDF attachments and attachments without Content-Type', async () => {
  await register()
  for (const mime of ['', 'application/pdf']) {
    expect(
      await listener(
        request({
          responseHeaders: [
            { name: 'Content-Disposition', value: 'attachment' },
            { name: 'Content-Type', value: mime },
            { name: 'Content-Length', value: '1024' },
          ],
        })
      )
    ).toEqual({ cancel: true })
  }
  await deliver()
  expect(submit).toHaveBeenCalledTimes(2)
})
it('does not suppress a second user download of the same URL', async () => {
  await register()
  expect(await listener(request())).toEqual({ cancel: true })
  await deliver()
  expect(await listener(request())).toEqual({ cancel: true })
  await deliver()
  expect(submit).toHaveBeenCalledTimes(2)
})
it('falls back only once when submission fails, even if browser download rejects', async () => {
  submit.mockRejectedValue(new Error('rejected'))
  download.mockRejectedValue(new Error('browser failed'))
  await register()
  expect(await listener(request())).toEqual({ cancel: true })
  await deliver()
  expect(download).toHaveBeenCalledOnce()
})
it('never falls back for an unknown submission outcome', async () => {
  const { DownloadOutcomeUnknownError: Unknown } = await import(
    '@/background/download-errors'
  )
  submit.mockRejectedValue(new Unknown())
  await register()
  await listener(request())
  await deliver()
  expect(submit).toHaveBeenCalledOnce()
  expect(download).not.toHaveBeenCalled()
})
it.each([
  'accepted',
  'browser',
  'cancel',
  'unavailable',
  'unsupported',
] as const)(
  'cancels before confirmation and handles %s once',
  async (action) => {
    cfg.downloadMode = 'confirm'
    confirm.mockResolvedValue(
      action === 'accepted' ? { action, taskId: 'task' } : { action }
    )
    await register()
    expect(await listener(request())).toEqual({ cancel: true })
    expect(confirm).not.toHaveBeenCalled()
    await deliver()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'auto',
        nativeDownloadCancelled: true,
      }),
      1,
      expect.anything()
    )
    expect(download).toHaveBeenCalledTimes(
      ['unavailable', 'unsupported'].includes(action) ? 1 : 0
    )
  }
)
it('leaves a response intact when preflight times out; late results never submit', async () => {
  let resolve!: (cfg: TakeoverConfig) => void
  deps.getConfig = () =>
    new Promise((r) => {
      resolve = r
    })
  await register()
  const response = listener(request())
  await vi.advanceTimersByTimeAsync(1501)
  expect(await response).toEqual({})
  resolve(cfg)
  await deliver()
  expect(submit).not.toHaveBeenCalled()
  expect(download).not.toHaveBeenCalled()
})
it('honors live switches and does not overwrite a newer storage event at startup', async () => {
  let resolve!: (stored: Record<string, unknown>) => void
  vi.mocked(browser.storage.local.get).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  await register()
  change({ 'motrix.earlyTakeover': { newValue: { enabled: false } } }, 'local')
  resolve({})
  expect(await listener(request())).toEqual({})
  change({ 'motrix.earlyTakeover': { newValue: { enabled: true } } }, 'local')
  expect(await listener(request())).toEqual({ cancel: true })
})
it('leaves unsupported endpoints and sensitive automatic downloads native', async () => {
  deps.captureGuard = async () => null
  await register()
  expect(await listener(request())).toEqual({})
})
it('does not submit after the switch changes between cancellation and delivery', async () => {
  await register()
  expect(await listener(request())).toEqual({ cancel: true })
  change({ 'motrix.takeoverConfig': { newValue: { enabled: false } } }, 'local')
  await deliver()
  expect(submit).not.toHaveBeenCalled()
  expect(download).toHaveBeenCalledOnce()
})

it('does not replay an accepted task when presentation throws synchronously', async () => {
  deps.captureGuard = async () => ({
    origin: 'auto',
    endpointId: 'local',
    assertCurrent() {},
  })
  deps.popup = {
    present: () => {
      throw new Error('popup failed')
    },
  } as unknown as ChromiumInterceptionDeps['popup']
  await register()
  await listener(request())
  await deliver()
  expect(submit).toHaveBeenCalledOnce()
  expect(download).not.toHaveBeenCalled()
})

it.each([
  ['attachment; filename="report.zip"', 'report.zip'],
  [
    "attachment; filename=backup.zip; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip",
    '报告.zip',
  ],
])(
  'preserves the response filename in confirmation: %s',
  async (disposition, filename) => {
    cfg.downloadMode = 'confirm'
    await register()
    expect(
      await listener(
        request({
          url: 'https://example.com/download?id=42',
          responseHeaders: [
            { name: 'Content-Disposition', value: disposition },
            { name: 'Content-Length', value: '1024' },
          ],
        })
      )
    ).toEqual({ cancel: true })
    await deliver()
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      suggestedFilename: filename,
      filenameFromUrl: false,
      origin: 'auto',
      nativeDownloadCancelled: true,
    })
  }
)
