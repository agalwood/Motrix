import { describe, expect, it, vi } from 'vitest'
import { ConnectionGate } from '@/background/ConnectionGate'
import { buildSubmitParams } from '@/background/capture/buildSubmitParams'
import {
  HandoffEndpointChangedError,
  type HandoffGuard,
} from '@/background/handoff/guard'
import { makeOps } from '@/background/handoff/makeOps'
import { PairNudge } from '@/background/pairNudge'

function fixture(origin: HandoffGuard['origin']) {
  const notify = vi.fn()
  const guard = { origin, assertCurrent: vi.fn() }
  const manager = {
    getState: () => 'connected' as const,
    getLastError: () => null,
    ensureReady: vi.fn(async () => {}),
    clearGateAndStart: vi.fn(async () => {}),
    submitDownload: vi.fn(
      async (_params: unknown, options: { assertCurrent?: () => void }) => {
        options.assertCurrent?.()
        return { taskId: 'remote-task' }
      }
    ),
  }
  const cancelNative = vi.fn(async () => {})
  const ops = makeOps({
    manager,
    guard,
    cancelNative,
    notify,
    isPaired: async () => true,
    gate: new ConnectionGate(),
    nudge: new PairNudge({ notify }),
    fallbackToBrowser: async () => {},
    confirmSensitive: async () => false,
  })
  const params = buildSubmitParams(
    {
      origin,
      url: 'https://example.com/file.zip',
      pageUrl: 'https://example.com',
      pageTitle: '',
      suggestedFilename: 'file.zip',
      mime: '',
      sizeBytes: null,
      siteHint: '',
    },
    [],
    {}
  )
  return { guard, manager, cancelNative, ops, params }
}

describe('handoff submission origin', () => {
  it.each(['auto', 'context-menu'] as const)(
    'preserves the %s origin through submission',
    async (origin) => {
      const { guard, manager, ops, params } = fixture(origin)
      await expect(ops.submit(params)).resolves.toEqual({
        taskId: 'remote-task',
      })
      expect(guard.assertCurrent).toHaveBeenCalled()
      expect(manager.submitDownload).toHaveBeenCalledWith(params, {
        automaticTakeover: origin === 'auto',
        assertCurrent: expect.any(Function),
      })
    }
  )

  it('checks the selected endpoint immediately before browser cancellation', async () => {
    const { guard, ops, cancelNative } = fixture('auto')
    guard.assertCurrent.mockImplementation(() => {
      throw new HandoffEndpointChangedError()
    })
    await expect(ops.cancelNative()).rejects.toThrow(
      HandoffEndpointChangedError
    )
    expect(cancelNative).not.toHaveBeenCalled()
  })
})
