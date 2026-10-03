import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { ConsentPayload, GrantsMap } from '@shared/types/plugin-install'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

// Wire shape mirrors installPluginPayloadSchema in src/main/ipc/commands.ts.
// `fileHash` is the SHA-256 hex digest of the .moext file content — it
// serves as the persisted source identity (`local:<hash>`), not a content
// check.
export type InstallSource =
  | { sourceType: 'github'; spec: string }
  | { sourceType: 'url'; url: string }
  | { sourceType: 'local'; absPath: string; fileHash: string }
  | { sourceType: 'upload'; uploadId: string; fileHash: string }
  | { sourceType: 'registry'; pluginId: string }

interface InstallResult {
  stagingId: string
  consent: ConsentPayload
  committed: boolean
  pluginId?: string
}

export function usePluginInstall() {
  const { t } = useTranslation()
  const [stagingId, setStagingId] = useState<string | null>(null)
  const [consent, setConsent] = useState<ConsentPayload | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function showError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    const messages = {
      'plugin.install.official_signature_invalid':
        'plugins.install.officialSignatureInvalid',
      'plugin.install.official_builtin_hook':
        'plugins.install.officialBuiltinOnly',
      'plugin.install.builtin_already_installed':
        'plugins.install.builtinAlreadyInstalled',
    } as const
    const key = Object.keys(messages).find((code) => message.endsWith(code)) as
      | keyof typeof messages
      | undefined
    setError(key ? t(messages[key]) : message)
  }

  async function startInstall(input: InstallSource): Promise<boolean> {
    setPending(true)
    setError(null)
    try {
      const r = (await transport.invoke(
        Commands.InstallPlugin,
        input
      )) as InstallResult
      if (r.committed) {
        setStagingId(null)
        setConsent(null)
      } else {
        setStagingId(r.stagingId)
        setConsent(r.consent)
      }
      return r.committed
    } catch (e) {
      showError(e)
      return false
    } finally {
      setPending(false)
    }
  }

  async function confirm(grants: GrantsMap): Promise<boolean> {
    if (!stagingId || pending) return false
    setPending(true)
    setError(null)
    try {
      await transport.invoke(Commands.ConfirmPluginInstall, {
        stagingId,
        grants,
      })
      setStagingId(null)
      setConsent(null)
      return true
    } catch (e) {
      showError(e)
      return false
    } finally {
      setPending(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!stagingId) return
    await transport.invoke(Commands.CancelPluginInstall, { stagingId })
    setStagingId(null)
    setConsent(null)
  }

  return { stagingId, consent, pending, error, startInstall, confirm, cancel }
}
