import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import { CONFIRMATION_TIMEOUT_MS } from '@/shared/downloadConfirmation'
import { DOWNLOAD_ERROR } from '@/shared/integration'

function fixture() {
  const io = {
    supported: vi.fn(() => true),
    open: vi.fn(async () => {}),
    publish: vi.fn(),
    userAgent: () => 'Browser UA',
  }
  const actions = {
    submit: vi.fn(async () => ({ taskId: 'task-1' })),
    browser: vi.fn(async () => {}),
  }
  const service = new DownloadConfirmationService(io)
  const target = normalizeTarget({
    url: 'https://example.com/one-use.zip',
    origin: 'context-menu',
  })
  return {
    io,
    actions,
    service,
    target,
    request: () => service.request(target, 4, actions),
  }
}
afterEach(() => vi.useRealTimers())

describe('download confirmation ownership', () => {
  it('rejects an unavailable browser action without submitting or dismissing the draft', async () => {
    const { service, actions, target } = fixture()
    const pending = service.request(target, 4, { submit: actions.submit })
    const draft = service.get(4)!
    expect(service.decide(4, draft.id, { action: 'browser' })).toBe(false)
    expect(service.get(4)?.phase).toBe('editing')
    expect(actions.submit).not.toHaveBeenCalled()
    service.close(4)
    await expect(pending).resolves.toEqual({ action: 'cancel' })
  })
  it('accepts one submission only from the matching window and draft', async () => {
    const { service, actions, request } = fixture()
    const pending = request()
    const draft = service.get(4)!
    expect(draft.options.userAgent).toBe('Browser UA')
    const options = { ...draft.options, filename: 'chosen.zip' }
    const decision = { action: 'submit', options }
    expect(actions.submit).not.toHaveBeenCalled()
    expect(service.decide(5, draft.id, decision)).toBe(false)
    expect(service.decide(4, 'old-id', decision)).toBe(false)
    expect(service.decide(4, draft.id, decision)).toBe(true)
    expect(service.decide(4, draft.id, decision)).toBe(false)
    expect(service.get(4)?.phase).toBe('submitting')
    await expect(pending).resolves.toEqual({
      action: 'accepted',
      taskId: 'task-1',
    })
    expect(actions.submit).toHaveBeenCalledExactlyOnceWith(
      options,
      expect.any(String)
    )
    expect(service.get(4)).toBeNull()
  })
  it.each(['close', 'cancelAll'] as const)(
    'cancels without submitting when %s occurs',
    async (method) => {
      const { service, actions, request } = fixture()
      const pending = request()
      if (method === 'close') service.close(4)
      else service.cancelAll()
      await expect(pending).resolves.toEqual({ action: 'cancel' })
      expect(actions.submit).not.toHaveBeenCalled()
      expect(actions.browser).not.toHaveBeenCalled()
    }
  )
  it('expires without a download and rejects late decisions', async () => {
    vi.useFakeTimers()
    const { service, actions, request } = fixture()
    const pending = request()
    const draft = service.get(4)!
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS)
    await expect(pending).resolves.toEqual({ action: 'cancel' })
    expect(
      service.decide(4, draft.id, { action: 'submit', options: draft.options })
    ).toBe(false)
    expect(actions.submit).not.toHaveBeenCalled()
  })
  it('does not replace an existing form', async () => {
    const { service, request } = fixture()
    const first = request()
    const id = service.get(4)!.id
    await expect(request()).resolves.toEqual({ action: 'unavailable' })
    expect(service.get(4)!.id).toBe(id)
    service.close(4)
    await first
  })
  it('rejects unsupported browsers and missing originating windows', async () => {
    const { service, target, actions, io } = fixture()
    await expect(service.request(target, undefined, actions)).resolves.toEqual({
      action: 'unavailable',
    })
    io.supported.mockReturnValue(false)
    await expect(service.request(target, 4, actions)).resolves.toEqual({
      action: 'unsupported',
    })
    expect(io.open).not.toHaveBeenCalled()
  })
  it('discards a cancelled-response draft before returning browser fallback', async () => {
    const { service, target, actions, io } = fixture()
    io.open.mockRejectedValue(new Error('unavailable'))
    const pending = service.request(
      { ...target, origin: 'auto', nativeDownloadCancelled: true },
      4,
      actions
    )
    const draft = service.get(4)!
    await expect(pending).resolves.toEqual({ action: 'unavailable' })
    expect(service.get(4)).toBeNull()
    expect(
      service.decide(4, draft.id, { action: 'submit', options: draft.options })
    ).toBe(false)
    expect(actions.submit).not.toHaveBeenCalled()
  })
  it('retains a recoverable draft if the popup cannot open', async () => {
    const { service, request, io } = fixture()
    io.open.mockRejectedValue(new Error('unavailable'))
    await expect(request()).resolves.toEqual({ action: 'unavailable' })
    expect(service.get(4)).not.toBeNull()
    service.close(4)
  })
  it('retains edits on failure, reuses the operation identity on retry, and changes it for edited options', async () => {
    const { service, request, actions } = fixture()
    actions.submit.mockRejectedValue(new Error('private URL and credentials'))
    const pending = request()
    const draft = service.get(4)!
    const options = {
      ...draft.options,
      filename: 'chosen.zip',
      authorization: 'Bearer test',
    }
    const submit = () =>
      service.decide(4, draft.id, { action: 'submit', options })
    submit()
    await vi.waitFor(() => expect(service.get(4)?.phase).toBe('failed'))
    expect(service.get(4)).toMatchObject({
      options,
      error: DOWNLOAD_ERROR.rejected,
    })
    expect(actions.browser).not.toHaveBeenCalled()
    const firstKey = actions.submit.mock.calls[0]![1]
    submit()
    await vi.waitFor(() => expect(service.get(4)?.phase).toBe('failed'))
    expect(actions.submit.mock.calls[1]![1]).toBe(firstKey)
    service.decide(4, draft.id, {
      action: 'submit',
      options: { ...options, filename: 'changed.zip' },
    })
    await vi.waitFor(() => expect(service.get(4)?.phase).toBe('failed'))
    expect(actions.submit.mock.calls[2]![1]).not.toBe(firstKey)
    service.close(4)
    await pending
  })
  it('blocks both resubmission and browser fallback for an unknown result', async () => {
    const { service, request, actions } = fixture()
    actions.submit.mockRejectedValue(new DownloadOutcomeUnknownError())
    const pending = request()
    const draft = service.get(4)!
    const decision = { action: 'submit', options: draft.options }
    service.decide(4, draft.id, decision)
    await vi.waitFor(() => expect(service.get(4)?.phase).toBe('unknown'))
    expect(service.decide(4, draft.id, decision)).toBe(false)
    expect(service.decide(4, draft.id, { action: 'browser' })).toBe(false)
    expect(actions.submit).toHaveBeenCalledOnce()
    expect(actions.browser).not.toHaveBeenCalled()
    service.close(4)
    await pending
  })
  it('does not expire an in-flight submission or reopen it after the view closes', async () => {
    vi.useFakeTimers()
    const { service, request, actions } = fixture()
    let finish!: (value: { taskId: string }) => void
    actions.submit.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const pending = request()
    const draft = service.get(4)!
    service.decide(4, draft.id, { action: 'submit', options: draft.options })
    await vi.advanceTimersByTimeAsync(CONFIRMATION_TIMEOUT_MS + 1)
    expect(service.get(4)?.phase).toBe('submitting')
    service.close(4)
    await expect(pending).resolves.toEqual({ action: 'cancel' })
    finish({ taskId: 'accepted-after-close' })
    await Promise.resolve()
    expect(service.get(4)).toBeNull()
    expect(actions.submit).toHaveBeenCalledOnce()
  })
  it('rejects malformed headers and native-browser decisions for magnets', async () => {
    const { service, request, actions, target } = fixture()
    const pending = request()
    const draft = service.get(4)!
    expect(
      service.decide(4, draft.id, {
        action: 'submit',
        options: { ...draft.options, userAgent: 'UA\r\nCookie: injected' },
      })
    ).toBe(false)
    service.close(4)
    await pending
    const magnet = service.request(
      { ...target, url: 'magnet:?xt=urn:btih:abc' },
      4,
      actions
    )
    expect(service.decide(4, service.get(4)!.id, { action: 'browser' })).toBe(
      false
    )
    service.close(4)
    await magnet
  })
  it('does not erase a new draft when a dismissed submission finishes', async () => {
    const { service, actions, request } = fixture()
    let finish!: (value: { taskId: string }) => void
    actions.submit.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const first = request()
    const oldDraft = service.get(4)!
    service.decide(4, oldDraft.id, {
      action: 'submit',
      options: oldDraft.options,
    })
    service.close(4)
    await first
    const second = request()
    const newId = service.get(4)!.id
    finish({ taskId: 'old-task' })
    await vi.waitFor(() => expect(actions.submit).toHaveResolved())
    expect(service.get(4)?.id).toBe(newId)
    expect(service.get(4)?.phase).toBe('editing')
    service.close(4)
    await second
  })
  it('keeps accepted outcomes final when publishing to the popup throws', async () => {
    const { service, actions, request, io } = fixture()
    io.publish.mockImplementation(() => {
      throw new Error('renderer disconnected')
    })
    const pending = request()
    const draft = service.get(4)!
    const decision = { action: 'submit', options: draft.options }
    service.decide(4, draft.id, decision)
    await expect(pending).resolves.toEqual({
      action: 'accepted',
      taskId: 'task-1',
    })
    expect(service.decide(4, draft.id, decision)).toBe(false)
    expect(actions.submit).toHaveBeenCalledOnce()
    expect(actions.browser).not.toHaveBeenCalled()
  })
})
