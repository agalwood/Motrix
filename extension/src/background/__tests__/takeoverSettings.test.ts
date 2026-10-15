import { describe, expect, it, vi } from 'vitest'
import { TakeoverConfigStore } from '@/background/TakeoverConfigStore'
import { createTakeoverSettingsHandlers } from '@/background/takeoverSettings'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

it.each([false, true])(
  'guards both persistence paths when paired=%s',
  async (paired) => {
    const store = new TakeoverConfigStore()
    const patch = vi
      .spyOn(store, 'patchEnabled')
      .mockResolvedValue({ ...TAKEOVER_DEFAULT, enabled: true })
    const save = vi.spyOn(store, 'patchTakeoverSettings').mockResolvedValue()
    const handlers = createTakeoverSettingsHandlers(store, async () => paired)
    const operations = [
      handlers.patchEnabled({ enabled: true, consentAckVersion: 1 }),
      handlers.set({ ...TAKEOVER_DEFAULT, enabled: true }),
    ]
    for (const operation of operations) {
      if (paired) await expect(operation).resolves.toBeDefined()
      else await expect(operation).rejects.toThrow('takeover.pairing-required')
    }
    expect(patch).toHaveBeenCalledTimes(paired ? 1 : 0)
    expect(save).toHaveBeenCalledTimes(paired ? 1 : 0)
  }
)

describe('disabling takeover', () => {
  it('does not require a paired backend or a successful pairing read', async () => {
    const store = new TakeoverConfigStore()
    vi.spyOn(store, 'patchEnabled').mockResolvedValue(TAKEOVER_DEFAULT)
    vi.spyOn(store, 'patchTakeoverSettings').mockResolvedValue()
    const pairing = vi.fn(async (): Promise<boolean> => {
      throw new Error('unavailable')
    })
    const handlers = createTakeoverSettingsHandlers(store, pairing)
    await handlers.patchEnabled({ enabled: false })
    await handlers.set({ ...TAKEOVER_DEFAULT, enabled: false })
    expect(pairing).not.toHaveBeenCalled()
  })
})
