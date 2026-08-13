import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { AppSettings } from '@shared/types/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handle, removeHandler } = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle, removeHandler },
}))

vi.mock('./trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ) => handle(channel, listener),
}))

import { buildDisclaimerHandlers, registerDisclaimerIpc } from './disclaimer'

function createDeps() {
  const state = {
    app: { language: 'en-US' },
  } as AppSettings
  return {
    gate: { accept: vi.fn().mockResolvedValue(undefined) },
    settings: {
      get: vi.fn(() => state),
      setDisclaimerLanguage: vi.fn().mockImplementation(async (language) => {
        state.app.language = language
        return { saved: true }
      }),
    },
    windowManager: {
      close: vi.fn(),
      open: vi.fn(),
    },
    canContinue: vi.fn(() => true),
    quitApp: vi.fn(),
  }
}

describe('disclaimer IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns only the disclaimer bootstrap state', async () => {
    const deps = createDeps()
    const handlers = buildDisclaimerHandlers(deps)

    await expect(handlers[Queries.GetDisclaimerState]?.()).resolves.toEqual({
      language: 'en-US',
    })
  })

  it('persists only a supported disclaimer language', async () => {
    const deps = createDeps()
    const handlers = buildDisclaimerHandlers(deps)

    await expect(
      handlers[Commands.SetDisclaimerLanguage]?.('zh-CN')
    ).resolves.toEqual({ ok: true })
    expect(deps.settings.setDisclaimerLanguage).toHaveBeenCalledWith('zh-CN')
    await expect(
      handlers[Commands.SetDisclaimerLanguage]?.('fr-FR')
    ).rejects.toThrow()
  })

  it('persists acceptance before replacing the disclaimer with main', async () => {
    const deps = createDeps()
    const handlers = buildDisclaimerHandlers(deps)

    await handlers[Commands.AcceptDisclaimer]?.()

    expect(deps.gate.accept).toHaveBeenCalledOnce()
    expect(deps.windowManager.close).toHaveBeenCalledWith('onboarding')
    expect(deps.windowManager.open).toHaveBeenCalledWith('main', { show: true })
    expect(deps.gate.accept.mock.invocationCallOrder[0]).toBeLessThan(
      deps.windowManager.close.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('does not open main when shutdown starts during acceptance', async () => {
    const deps = createDeps()
    deps.canContinue.mockReturnValue(false)
    const handlers = buildDisclaimerHandlers(deps)

    await expect(handlers[Commands.AcceptDisclaimer]?.()).resolves.toEqual({
      ok: true,
    })

    expect(deps.gate.accept).toHaveBeenCalledOnce()
    expect(deps.windowManager.close).not.toHaveBeenCalled()
    expect(deps.windowManager.open).not.toHaveBeenCalled()
  })

  it('quits when consent is declined', async () => {
    const deps = createDeps()
    const handlers = buildDisclaimerHandlers(deps)

    await handlers[Commands.DeclineDisclaimer]?.()

    expect(deps.quitApp).toHaveBeenCalledOnce()
  })

  it('registers and removes only disclaimer channels', () => {
    const deps = createDeps()

    const dispose = registerDisclaimerIpc(deps)

    expect(handle).toHaveBeenCalledTimes(4)
    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(4)
  })
})
