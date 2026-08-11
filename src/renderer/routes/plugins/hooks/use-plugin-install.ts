import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type { ConsentPayload, GrantsMap } from '@shared/types/plugin-install'
import { useState } from 'react'

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
  const [stagingId, setStagingId] = useState<string | null>(null)
  const [consent, setConsent] = useState<ConsentPayload | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function startInstall(input: InstallSource): Promise<void> {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  async function confirm(grants: GrantsMap): Promise<void> {
    if (!stagingId) return
    await transport.invoke(Commands.ConfirmPluginInstall, { stagingId, grants })
    setStagingId(null)
    setConsent(null)
  }

  async function cancel(): Promise<void> {
    if (!stagingId) return
    await transport.invoke(Commands.CancelPluginInstall, { stagingId })
    setStagingId(null)
    setConsent(null)
  }

  return { stagingId, consent, pending, error, startInstall, confirm, cancel }
}
