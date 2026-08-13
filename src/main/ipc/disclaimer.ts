import type { SupportedLocale } from '@shared/constants/locales'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { supportedLocaleSchema } from '@shared/schemas/locale'
import type { AppSettings } from '@shared/types/settings'
import { ipcMain } from 'electron'
import type { DisclaimerGate } from '../onboarding/disclaimer-gate'
import type { WindowManager } from '../window/window-manager'
import { registerTrustedIpcHandler } from './trusted-ipc'

export interface DisclaimerIpcDeps {
  gate: Pick<DisclaimerGate, 'accept'>
  settings: {
    get(): AppSettings
    setDisclaimerLanguage(
      language: SupportedLocale
    ): Promise<{ saved: boolean }>
  }
  windowManager: Pick<WindowManager, 'close' | 'open'>
  canContinue: () => boolean
  quitApp: () => void
}

type DisclaimerHandler = (...args: unknown[]) => Promise<unknown>

export function buildDisclaimerHandlers(
  deps: DisclaimerIpcDeps
): Record<string, DisclaimerHandler> {
  return {
    [Queries.GetDisclaimerState]: async () => ({
      language: deps.settings.get().app.language,
    }),
    [Commands.SetDisclaimerLanguage]: async (input: unknown) => {
      const language = supportedLocaleSchema.parse(input)
      await deps.settings.setDisclaimerLanguage(language)
      return { ok: true }
    },
    [Commands.AcceptDisclaimer]: async () => {
      await deps.gate.accept()
      if (!deps.canContinue()) return { ok: true }
      deps.windowManager.close('onboarding')
      deps.windowManager.open('main', { show: true })
      return { ok: true }
    },
    [Commands.DeclineDisclaimer]: async () => {
      deps.quitApp()
      return { ok: true }
    },
  }
}

export function registerDisclaimerIpc(deps: DisclaimerIpcDeps): () => void {
  const handlers = buildDisclaimerHandlers(deps)
  const channels = Object.keys(handlers)

  for (const [channel, handler] of Object.entries(handlers)) {
    registerTrustedIpcHandler(channel, async (_event, ...args) =>
      handler(...args)
    )
  }

  return () => {
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
    }
  }
}
