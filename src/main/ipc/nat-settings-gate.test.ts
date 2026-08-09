import { describe, expect, it, vi } from 'vitest'
import { applyNatPrivacyGate } from './nat-settings-gate'

describe('applyNatPrivacyGate', () => {
  it('shows dialog when enabling NAT type detection', async () => {
    const dialog = vi.fn().mockResolvedValue(true)
    const newSettings = {
      nat: {
        natTypeDetectionEnabled: true,
        portReachabilityCheckEnabled: false,
      },
    }
    const oldSettings = {
      nat: {
        natTypeDetectionEnabled: false,
        portReachabilityCheckEnabled: false,
      },
    }
    const result = await applyNatPrivacyGate({
      oldSettings,
      newSettings,
      dialogConfirm: dialog,
    })
    expect(dialog).toHaveBeenCalledTimes(1)
    expect(result.nat.natTypeDetectionEnabled).toBe(true)
  })

  it('reverts toggle if user cancels', async () => {
    const dialog = vi.fn().mockResolvedValue(false)
    const newSettings = {
      nat: {
        natTypeDetectionEnabled: true,
        portReachabilityCheckEnabled: false,
      },
    }
    const oldSettings = {
      nat: {
        natTypeDetectionEnabled: false,
        portReachabilityCheckEnabled: false,
      },
    }
    const result = await applyNatPrivacyGate({
      oldSettings,
      newSettings,
      dialogConfirm: dialog,
    })
    expect(result.nat.natTypeDetectionEnabled).toBe(false)
  })

  it('no dialog when toggle unchanged', async () => {
    const dialog = vi.fn().mockResolvedValue(true)
    const newSettings = {
      nat: {
        natTypeDetectionEnabled: true,
        portReachabilityCheckEnabled: false,
      },
    }
    const oldSettings = {
      nat: {
        natTypeDetectionEnabled: true,
        portReachabilityCheckEnabled: false,
      },
    }
    await applyNatPrivacyGate({
      oldSettings,
      newSettings,
      dialogConfirm: dialog,
    })
    expect(dialog).not.toHaveBeenCalled()
  })

  it('shows two dialogs when enabling both toggles', async () => {
    const dialog = vi.fn().mockResolvedValue(true)
    const newSettings = {
      nat: {
        natTypeDetectionEnabled: true,
        portReachabilityCheckEnabled: true,
      },
    }
    const oldSettings = {
      nat: {
        natTypeDetectionEnabled: false,
        portReachabilityCheckEnabled: false,
      },
    }
    await applyNatPrivacyGate({
      oldSettings,
      newSettings,
      dialogConfirm: dialog,
    })
    expect(dialog).toHaveBeenCalledTimes(2)
  })
})
