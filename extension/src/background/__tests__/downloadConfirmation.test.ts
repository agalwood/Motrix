import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { createDownloadConfirmation } from '@/background/downloadConfirmation'
import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import { CONFIRMATION_PORT } from '@/shared/downloadConfirmation'

vi.mock('@/shared/platformCapabilities', () => ({
  supportsAutoOpenPopup: () => true,
}))
const target = normalizeTarget({
  url: 'https://example.com/once.zip',
  origin: 'context-menu',
})
const actions = {
  submit: vi.fn(async () => ({ taskId: 'task-1' })),
  browser: vi.fn(async () => {}),
}
let connect!: (port: Browser.runtime.Port) => void
let removed!: (windowId: number) => void
beforeEach(() => {
  Object.assign(browser, {
    windows: {
      get: vi.fn(async (id) => ({ id, focused: true, type: 'normal' })),
      onRemoved: {
        addListener: vi.fn((callback) => {
          removed = callback
        }),
      },
    },
    action: { openPopup: vi.fn(async () => {}) },
  })
  Object.assign(browser.runtime, {
    onConnect: {
      addListener: vi.fn((callback) => {
        connect = callback
      }),
    },
  })
})
afterEach(() => vi.useRealTimers())
function view(windowId = 4, senderUrl = browser.runtime.getURL('popup.html')) {
  let message!: (value: unknown) => void
  let disconnect!: () => void
  const port = {
    name: CONFIRMATION_PORT,
    sender: { id: browser.runtime.id, url: senderUrl },
    onMessage: {
      addListener: (callback: typeof message) => {
        message = callback
      },
    },
    onDisconnect: {
      addListener: (callback: typeof disconnect) => {
        disconnect = callback
      },
    },
    postMessage: vi.fn(),
  }
  connect(port as never)
  message?.({ windowId })
  return { message, disconnect, port }
}
it('rejects an unfocused source window instead of selecting the new focused window', async () => {
  vi.mocked(browser.windows.get).mockResolvedValue({
    id: 4,
    focused: false,
    type: 'normal',
  } as never)
  const service = createDownloadConfirmation()
  await expect(service.request(target, 4, actions)).resolves.toEqual({
    action: 'unavailable',
  })
  expect(browser.windows.get).toHaveBeenCalledWith(4)
  expect(browser.action.openPopup).not.toHaveBeenCalled()
})
it('does not open a cancelled draft after the window lookup finishes', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(browser.windows.get).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }) as never
  )
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  service.cancelAll()
  resolve({ id: 4, focused: true, type: 'normal' })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
  await Promise.resolve()
  expect(browser.action.openPopup).not.toHaveBeenCalled()
})
it('preserves edited drafts across popup disconnect and restores them into a new view', async () => {
  const service = createDownloadConfirmation()
  const v = view()
  const pending = service.request(target, 4, actions)
  await vi.waitFor(() =>
    expect(v.port.postMessage).toHaveBeenCalledWith({
      draft: expect.objectContaining({ target }),
    })
  )
  expect(browser.action.openPopup).not.toHaveBeenCalled()
  const draft = service.get(4)!
  const options = {
    ...draft.options,
    filename: 'resume.zip',
    extraHeaders: 'X-Unfinished:',
  }
  v.message({ id: draft.id, decision: { action: 'edit', options } })
  v.disconnect()
  expect(service.get(4)?.options).toEqual(options)
  const resumed = view()
  await vi.waitFor(() =>
    expect(resumed.port.postMessage).toHaveBeenCalledWith({
      draft: expect.objectContaining({ id: draft.id, options }),
    })
  )
  expect(actions.submit).not.toHaveBeenCalled()
  resumed.message({ id: draft.id, decision: { action: 'cancel' } })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
it('bounds waiting for a popup that closed before its handshake', async () => {
  vi.useFakeTimers()
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  await vi.advanceTimersByTimeAsync(5001)
  await expect(pending).resolves.toEqual({ action: 'unavailable' })
  expect(service.get(4)).not.toBeNull()
  service.close(4)
})
it('only accepts its popup and does not allow a registered port to change windows', async () => {
  const service = createDownloadConfirmation()
  const invalid = view(4, 'https://example.com/')
  expect(invalid.port.postMessage).not.toHaveBeenCalled()
  const v = view(4)
  v.message({ windowId: 5 })
  const pending = service.request(target, 4, actions)
  v.message({ id: service.get(4)!.id, decision: { action: 'cancel' } })
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
it('releases a pending draft when its window closes', async () => {
  const service = createDownloadConfirmation()
  const pending = service.request(target, 4, actions)
  removed(4)
  await expect(pending).resolves.toEqual({ action: 'cancel' })
})
