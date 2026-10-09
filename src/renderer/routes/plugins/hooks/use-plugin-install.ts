import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import type {
  ConsentPayload,
  GrantsMap,
  PluginInstallCompatibilityFailure,
} from '@shared/types/plugin-install'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const requestRef = useRef(0)

  const operationRef = useRef<
    'idle' | 'preparing' | 'confirming' | 'cancelling'
  >('idle')
  const stagingRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      ++requestRef.current
      if (stagingRef.current && operationRef.current !== 'confirming') {
        void transport
          .invoke(Commands.CancelPluginInstall, {
            stagingId: stagingRef.current,
          })
          .catch(() => {})
        stagingRef.current = null
      }
      if (operationRef.current !== 'confirming') operationRef.current = 'idle'
    }
  }, [])

  const showError = useCallback(
    (e: unknown): void => {
      const message = e instanceof Error ? e.message : String(e)
      const messages = {
        'plugins.security.blocked': 'plugins.security.blocked',
        'plugins.security.pending': 'plugins.security.pending',
        'plugin.install.official_signature_invalid':
          'plugins.install.officialSignatureInvalid',
        'plugin.install.official_builtin_hook':
          'plugins.install.officialBuiltinOnly',
        'plugin.install.builtin_already_installed':
          'plugins.install.builtinAlreadyInstalled',
      } as const
      const key = Object.keys(messages).find((code) =>
        message.endsWith(code)
      ) as keyof typeof messages | undefined
      setError(key ? t(messages[key]) : message)
    },
    [t]
  )

  const startInstall = useCallback(
    async (input: InstallSource): Promise<boolean> => {
      if (
        operationRef.current !== 'idle' ||
        stagingRef.current ||
        !mountedRef.current
      )
        return false
      operationRef.current = 'preparing'
      const request = ++requestRef.current
      setPending(true)
      setError(null)
      setStagingId(null)
      setConsent(null)
      try {
        const r = (await transport.invoke(Commands.InstallPlugin, input)) as
          | InstallResult
          | PluginInstallCompatibilityFailure
        // A dismissed download may finish after another install has started.
        // Dispose its staging result without replacing the new dialog's state.
        if (request !== requestRef.current || !mountedRef.current) {
          if (!('incompatible' in r) && !r.committed) {
            await transport.invoke(Commands.CancelPluginInstall, {
              stagingId: r.stagingId,
            })
          }
          return false
        }
        if ('incompatible' in r) {
          setStagingId(null)
          setConsent(null)
          setError(
            t('plugins.install.hostIncompatible', {
              required: r.incompatible.required,
              current: r.incompatible.hostVersion,
            })
          )
          return false
        }
        if (r.committed) {
          setStagingId(null)
          setConsent(null)
        } else {
          stagingRef.current = r.stagingId
          setStagingId(r.stagingId)
          setConsent(r.consent)
        }
        return r.committed
      } catch (e) {
        if (request === requestRef.current) showError(e)
        return false
      } finally {
        if (request === requestRef.current && mountedRef.current) {
          operationRef.current = 'idle'
          setPending(false)
        }
      }
    },
    [showError, t]
  )

  const confirm = useCallback(
    async (grants: GrantsMap): Promise<boolean> => {
      const id = stagingRef.current
      if (!id || operationRef.current !== 'idle' || !mountedRef.current)
        return false
      operationRef.current = 'confirming'
      setPending(true)
      setError(null)
      try {
        await transport.invoke(Commands.ConfirmPluginInstall, {
          stagingId: id,
          grants,
        })
        stagingRef.current = null
        if (mountedRef.current) {
          setStagingId(null)
        }
        return true
      } catch (e) {
        if (mountedRef.current) showError(e)
        return false
      } finally {
        operationRef.current = 'idle'
        if (mountedRef.current) setPending(false)
        else if (stagingRef.current) {
          void transport
            .invoke(Commands.CancelPluginInstall, {
              stagingId: stagingRef.current,
            })
            .catch(() => {})
          stagingRef.current = null
        }
      }
    },
    [showError]
  )

  const cancel = useCallback(async (): Promise<boolean> => {
    if (
      operationRef.current === 'confirming' ||
      operationRef.current === 'cancelling'
    )
      return false
    const request = ++requestRef.current
    operationRef.current = 'cancelling'
    if (mountedRef.current) setPending(true)
    try {
      if (stagingRef.current) {
        await transport.invoke(Commands.CancelPluginInstall, {
          stagingId: stagingRef.current,
        })
      }
      if (request !== requestRef.current) return false
      stagingRef.current = null
      if (mountedRef.current) {
        setStagingId(null)
      }
      return true
    } catch (e) {
      if (request === requestRef.current && mountedRef.current) showError(e)
      return false
    } finally {
      if (request === requestRef.current) {
        operationRef.current = 'idle'
        if (mountedRef.current) setPending(false)
      }
    }
  }, [showError])

  // Keep the reviewed content intact while its dialog animates out. Starting
  // another install also resets it, independently of animation completion.
  const resetPresentation = useCallback(() => {
    setConsent(null)
    setError(null)
  }, [])

  return {
    stagingId,
    consent,
    pending,
    error,
    startInstall,
    confirm,
    cancel,
    resetPresentation,
  }
}
