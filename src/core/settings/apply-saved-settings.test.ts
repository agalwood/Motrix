import { describe, expect, it, vi } from 'vitest'
import { applySavedSettings } from './apply-saved-settings'

describe('applySavedSettings', () => {
  it('preserves the saved result and restart requirement when runtime application fails', async () => {
    const saved = {
      saved: true,
      requiresRestart: true,
      changedRestartKeys: ['rpcPort'],
    }
    const error = new Error('engine unavailable')
    const log = vi.fn()
    await expect(
      applySavedSettings(
        saved,
        async () => {
          throw error
        },
        log
      )
    ).resolves.toEqual({ ...saved, applicationFailed: true })
    expect(log).toHaveBeenCalledWith(error)
  })

  it('preserves additional successful shell response fields', async () => {
    const log = vi.fn()
    await expect(
      applySavedSettings(
        { saved: true },
        async () => ({ saved: true, protocolAssociationApplied: false }),
        log
      )
    ).resolves.toEqual({ saved: true, protocolAssociationApplied: false })
    expect(log).not.toHaveBeenCalled()
  })
})
