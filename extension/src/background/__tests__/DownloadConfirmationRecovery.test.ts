import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { CONFIRMATION_TIMEOUT_MS } from '@/shared/downloadConfirmation'

const key = 'motrix.downloadConfirmation.v1'
const target = normalizeTarget({
  url: 'https://example.com/once.zip',
  origin: 'context-menu',
})
const binding = { endpointId: 'local', endpointRevision: 3 }
function fixture() {
  vi.useFakeTimers()
  let saved: Record<string, unknown> = {}
  const storage = {
    get: vi.fn(async () => structuredClone(saved)),
    set: vi.fn(async (value: Record<string, unknown>) => {
      saved = structuredClone(value)
    }),
  }
  const actions = {
    submit: vi.fn(async () => ({ taskId: 'task' })),
    browser: vi.fn(async () => {}),
  }
  const io = {
    supported: () => true,
    open: vi.fn(async () => {}),
    publish: vi.fn(),
    userAgent: () => 'UA',
    storage,
    recover: vi.fn(async () => actions),
  }
  const service = new DownloadConfirmationService(io)
  return {
    service,
    io,
    actions,
    saved: () =>
      saved[key] as Array<{
        draft: { options: unknown; phase: string }
        operationId: string
      }>,
  }
}
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('confirmation session recovery', () => {
  it('restores unsent edits, including incomplete headers, without making requests or opening a popup', async () => {
    const f = fixture()
    await f.service.ready
    void f.service.request(target, 4, f.actions, binding)
    const draft = f.service.get(4)!
    const options = {
      ...draft.options,
      filename: 'edited.zip',
      directory: {
        path: '/downloads',
        endpointId: binding.endpointId,
        endpointRevision: binding.endpointRevision,
        instanceId: 'paired-instance',
      },
      referer: 'https://',
      extraHeaders: 'X-Unfinished',
      authorization: 'Bearer test',
    }
    expect(f.service.decide(4, draft.id, { action: 'edit', options })).toBe(
      true
    )
    await vi.waitFor(() => expect(f.saved()[0]?.draft.options).toEqual(options))
    vi.clearAllTimers() // Simulate the old worker being terminated.
    f.io.open.mockClear()
    const restored = new DownloadConfirmationService(f.io)
    await restored.ready
    expect(restored.get(4)).toMatchObject({
      id: draft.id,
      options,
      expiresAt: draft.expiresAt,
      phase: 'editing',
    })
    expect(f.io.recover).toHaveBeenCalledWith(target, binding)
    expect(f.io.open).not.toHaveBeenCalled()
    expect(f.actions.submit).not.toHaveBeenCalled()
    expect(f.actions.browser).not.toHaveBeenCalled()
    expect(restored.decide(4, draft.id, { action: 'submit', options })).toBe(
      false
    )
    expect(restored.decide(5, draft.id, { action: 'cancel' })).toBe(false)
    restored.decide(4, draft.id, { action: 'cancel' })
    await vi.waitFor(() => expect(f.saved()).toEqual([]))
  })
  it('preserves cancelled native response ownership across background restart', async () => {
    const f = fixture()
    await f.service.ready
    const earlyTarget = {
      ...target,
      origin: 'auto' as const,
      nativeDownloadCancelled: true,
    }
    void f.service.request(earlyTarget, 4, f.actions, binding)
    await vi.waitFor(() => expect(f.saved()).toHaveLength(1))
    vi.clearAllTimers()
    const restored = new DownloadConfirmationService(f.io)
    await restored.ready
    expect(f.io.recover).toHaveBeenCalledWith(earlyTarget, binding)
    restored.close(4)
  })
  it('uses the same operation identity after recovery and submits only once', async () => {
    const f = fixture()
    await f.service.ready
    void f.service.request(target, 4, f.actions, binding)
    await vi.waitFor(() => expect(f.saved()).toHaveLength(1))
    const operationId = f.saved()[0]!.operationId
    vi.clearAllTimers()
    const restored = new DownloadConfirmationService(f.io)
    await restored.ready
    const draft = restored.get(4)!
    const decision = { action: 'submit', options: draft.options }
    expect(restored.decide(4, draft.id, decision)).toBe(true)
    expect(restored.decide(4, draft.id, decision)).toBe(false)
    await vi.waitFor(() =>
      expect(f.actions.submit).toHaveBeenCalledExactlyOnceWith(
        draft.options,
        operationId
      )
    )
    await vi.waitFor(() => expect(f.saved()).toEqual([]))
  })
  it('restores an interrupted submission as unknown and never replays it', async () => {
    const f = fixture()
    f.actions.submit.mockReturnValue(new Promise(() => {}))
    await f.service.ready
    void f.service.request(target, 4, f.actions, binding)
    const draft = f.service.get(4)!
    f.service.decide(4, draft.id, { action: 'submit', options: draft.options })
    await vi.waitFor(() => expect(f.saved()[0]?.draft.phase).toBe('submitting'))
    vi.clearAllTimers()
    const restored = new DownloadConfirmationService(f.io)
    await restored.ready
    expect(restored.get(4)?.phase).toBe('unknown')
    expect(
      restored.decide(4, draft.id, { action: 'submit', options: draft.options })
    ).toBe(false)
    expect(restored.decide(4, draft.id, { action: 'browser' })).toBe(false)
    expect(f.actions.submit).toHaveBeenCalledOnce()
    restored.close(4)
  })
  it.each([
    'expired',
    'cancelled',
    'endpoint-changed',
    'window-closed-during-restore',
    'invalidated-during-restore',
  ])('does not resurrect a %s draft', async (reason) => {
    const f = fixture()
    await f.service.ready
    void f.service.request(target, 4, f.actions, binding)
    await vi.waitFor(() => expect(f.saved()).toHaveLength(1))
    vi.clearAllTimers()
    if (reason === 'expired')
      vi.setSystemTime(Date.now() + CONFIRMATION_TIMEOUT_MS + 1)
    if (reason === 'cancelled') {
      f.service.close(4)
      await vi.waitFor(() => expect(f.saved()).toEqual([]))
    }
    if (reason === 'endpoint-changed')
      f.io.recover.mockResolvedValue(null as never)
    const restored = new DownloadConfirmationService(f.io)
    if (reason === 'window-closed-during-restore') restored.close(4)
    if (reason === 'invalidated-during-restore') restored.cancelAll()
    await restored.ready
    expect(restored.get(4)).toBeNull()
    expect(f.saved()).toEqual([])
    expect(f.actions.submit).not.toHaveBeenCalled()
  })
  it('retains the original expiry across worker restarts', async () => {
    const f = fixture()
    await f.service.ready
    void f.service.request(target, 4, f.actions, binding)
    await vi.waitFor(() => expect(f.saved()).toHaveLength(1))
    const expiresAt = f.service.get(4)!.expiresAt
    vi.clearAllTimers()
    vi.setSystemTime(expiresAt - 1000)
    const restored = new DownloadConfirmationService(f.io)
    await restored.ready
    expect(restored.get(4)?.expiresAt).toBe(expiresAt)
    await vi.advanceTimersByTimeAsync(1001)
    expect(restored.get(4)).toBeNull()
    expect(f.saved()).toEqual([])
  })
})
