import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import { useTakeoverPairing } from '@/components/useTakeoverPairing'
import { useCurrentSite } from '@/popup/useCurrentSite'
import type { NotificationsConfig } from '@/shared/notifications'
import { supportsAutoOpenPopup } from '@/shared/platformCapabilities'
import { excludedSiteDomain, withSiteExcluded } from '@/shared/siteExclusion'
import type { DownloadMode } from '@/shared/takeover'
import { CONSENT_VERSION, type TakeoverConfig } from '@/shared/takeover'

export type NotificationSetting = keyof NotificationsConfig

export interface QuickSettingsError {
  operation: 'load' | 'save'
  message: string
}

export interface QuickSettingsController {
  setDownloadMode: (mode: DownloadMode) => Promise<void>
  takeoverSupported: boolean
  taskPanelSupported: boolean
  currentSite: string | null
  excludedSite: string | null
  takeover: TakeoverConfig | null
  notifications: NotificationsConfig | null
  loading: boolean
  saving: boolean
  error: QuickSettingsError | null
  pairingRequired: boolean
  cancelTakeoverPairing: () => void
  consentRequired: boolean
  reload: () => Promise<void>
  requestTakeoverEnabled: (enabled: boolean) => Promise<void>
  confirmTakeoverConsent: () => Promise<void>
  cancelTakeoverConsent: () => void
  setOpenTaskPanelAfterSubmit: (enabled: boolean) => Promise<void>
  setCurrentSiteExcluded: (excluded: boolean) => Promise<void>
  setNotification: (
    setting: NotificationSetting,
    enabled: boolean
  ) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Loads and persists the two real background-owned configs used by the popup's
 * quick settings. Download preferences use atomic patches so quick toggles
 * preserve rules and settings saved by another extension page.
 */
export function useQuickSettings(
  takeoverSupported = true
): QuickSettingsController {
  const {
    required: pairingRequired,
    checking: checkingPairing,
    error: pairingError,
    check: checkPairing,
    cancel: cancelTakeoverPairing,
  } = useTakeoverPairing()
  const supportedRef = useRef(takeoverSupported)
  supportedRef.current = takeoverSupported
  const currentSite = useCurrentSite()
  const taskPanelSupported = supportsAutoOpenPopup()
  const [takeover, setTakeover] = useState<TakeoverConfig | null>(null)
  const [notifications, setNotifications] =
    useState<NotificationsConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<QuickSettingsError | null>(null)
  const [consentRequired, setConsentRequired] = useState(false)

  useEffect(() => {
    if (!takeoverSupported) setConsentRequired(false)
  }, [takeoverSupported])

  const mountedRef = useRef(true)
  const loadGenerationRef = useRef(0)
  const savingRef = useRef(false)
  const takeoverRef = useRef<TakeoverConfig | null>(null)
  const notificationsRef = useRef<NotificationsConfig | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current
    if (mountedRef.current) {
      setLoading(true)
      setError(null)
    }

    try {
      const [nextTakeover, nextNotifications] = await Promise.all([
        send('bg.getTakeoverConfig', undefined),
        send('bg.getNotificationsConfig', undefined),
      ])
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return

      takeoverRef.current = nextTakeover
      notificationsRef.current = nextNotifications
      setTakeover(nextTakeover)
      setNotifications(nextNotifications)
      setConsentRequired(false)
    } catch (loadError) {
      if (!mountedRef.current || generation !== loadGenerationRef.current)
        return
      setError({ operation: 'load', message: errorMessage(loadError) })
    } finally {
      if (mountedRef.current && generation === loadGenerationRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void reload()
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
    }
  }, [reload])

  const persistTakeover = useCallback(
    async (
      next: TakeoverConfig,
      persist: () => Promise<TakeoverConfig> = () =>
        send('bg.patchTakeoverEnabled', {
          enabled: next.enabled,
          consentAckVersion: next.consentAckVersion,
        })
    ): Promise<boolean> => {
      const previous = takeoverRef.current
      if (previous === null || savingRef.current) return false

      savingRef.current = true
      takeoverRef.current = next
      if (mountedRef.current) {
        setSaving(true)
        setError(null)
        setTakeover(next)
      }

      try {
        const saved = await persist()
        takeoverRef.current = saved
        if (mountedRef.current) setTakeover(saved)
        return true
      } catch (saveError) {
        const shouldRollback = takeoverRef.current === next
        if (shouldRollback) takeoverRef.current = previous
        if (mountedRef.current) {
          if (shouldRollback) setTakeover(previous)
          setError({ operation: 'save', message: errorMessage(saveError) })
        }
        return false
      } finally {
        savingRef.current = false
        if (mountedRef.current) setSaving(false)
      }
    },
    []
  )

  const persistNotifications = useCallback(
    async (next: NotificationsConfig): Promise<boolean> => {
      const previous = notificationsRef.current
      if (previous === null || savingRef.current) return false

      savingRef.current = true
      notificationsRef.current = next
      if (mountedRef.current) {
        setSaving(true)
        setError(null)
        setNotifications(next)
      }

      try {
        await send('bg.setNotificationsConfig', next)
        return true
      } catch (saveError) {
        const shouldRollback = notificationsRef.current === next
        if (shouldRollback) {
          notificationsRef.current = previous
        }
        if (mountedRef.current) {
          if (shouldRollback) setNotifications(previous)
          setError({ operation: 'save', message: errorMessage(saveError) })
        }
        return false
      } finally {
        savingRef.current = false
        if (mountedRef.current) setSaving(false)
      }
    },
    []
  )

  const requestTakeoverEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      const current = takeoverRef.current
      if (!takeoverSupported) return
      if (current === null || current.enabled === enabled) return

      if (enabled && (!(await checkPairing()) || !supportedRef.current)) return

      if (enabled && current.consentAckVersion < CONSENT_VERSION) {
        if (mountedRef.current) setConsentRequired(true)
        return
      }

      if (!enabled && mountedRef.current) setConsentRequired(false)
      await persistTakeover({ ...current, enabled })
    },
    [checkPairing, persistTakeover, takeoverSupported]
  )

  const confirmTakeoverConsent = useCallback(async (): Promise<void> => {
    const current = takeoverRef.current
    if (!takeoverSupported || current === null) return

    if (!(await checkPairing()) || !supportedRef.current) {
      if (mountedRef.current) setConsentRequired(false)
      return
    }
    const saved = await persistTakeover({
      ...current,
      enabled: true,
      consentAckVersion: Math.max(current.consentAckVersion, CONSENT_VERSION),
    })
    if (saved && mountedRef.current) setConsentRequired(false)
  }, [checkPairing, persistTakeover, takeoverSupported])

  const cancelTakeoverConsent = useCallback((): void => {
    if (mountedRef.current) setConsentRequired(false)
  }, [])

  const setDownloadMode = useCallback(
    async (downloadMode: DownloadMode): Promise<void> => {
      const current = takeoverRef.current
      if (!current || current.downloadMode === downloadMode) return
      await persistTakeover({ ...current, downloadMode }, () =>
        send('bg.patchDownloadMode', { downloadMode })
      )
    },
    [persistTakeover]
  )

  const setOpenTaskPanelAfterSubmit = useCallback(
    async (enabled: boolean): Promise<void> => {
      const current = takeoverRef.current
      if (
        !taskPanelSupported ||
        current === null ||
        current.openTaskPanelAfterSubmit === enabled
      )
        return
      await persistTakeover(
        { ...current, openTaskPanelAfterSubmit: enabled },
        () =>
          send('bg.patchTaskPanelPreference', {
            openTaskPanelAfterSubmit: enabled,
          })
      )
    },
    [persistTakeover, taskPanelSupported]
  )

  const setCurrentSiteExcluded = useCallback(
    async (excluded: boolean): Promise<void> => {
      const current = takeoverRef.current
      if (current === null || currentSite === null) return
      const next = withSiteExcluded(current, currentSite, excluded)
      if (next === current) return
      await persistTakeover(next, () =>
        send('bg.patchSiteExclusion', { domain: currentSite, excluded })
      )
    },
    [currentSite, persistTakeover]
  )

  const setNotification = useCallback(
    async (setting: NotificationSetting, enabled: boolean): Promise<void> => {
      const current = notificationsRef.current
      if (current === null || current[setting] === enabled) return
      await persistNotifications({ ...current, [setting]: enabled })
    },
    [persistNotifications]
  )

  return useMemo(
    () => ({
      takeoverSupported,
      taskPanelSupported,
      currentSite,
      excludedSite:
        currentSite && takeover
          ? excludedSiteDomain(takeover, currentSite)
          : null,
      takeover,
      notifications,
      loading,
      saving: saving || checkingPairing,
      error: pairingError
        ? { operation: 'save' as const, message: 'Pairing status unavailable' }
        : error,
      pairingRequired,
      cancelTakeoverPairing,
      consentRequired,
      reload,
      requestTakeoverEnabled,
      confirmTakeoverConsent,
      cancelTakeoverConsent,
      setDownloadMode,
      setOpenTaskPanelAfterSubmit,
      setCurrentSiteExcluded,
      setNotification,
    }),
    [
      cancelTakeoverConsent,
      cancelTakeoverPairing,
      checkingPairing,
      pairingError,
      pairingRequired,
      confirmTakeoverConsent,
      consentRequired,
      currentSite,
      error,
      loading,
      notifications,
      reload,
      requestTakeoverEnabled,
      saving,
      setNotification,
      setDownloadMode,
      setOpenTaskPanelAfterSubmit,
      setCurrentSiteExcluded,
      takeover,
      takeoverSupported,
      taskPanelSupported,
    ]
  )
}
