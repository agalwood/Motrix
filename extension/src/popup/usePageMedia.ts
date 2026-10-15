import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import { isWebStoreBuild } from '@/shared/buildFlags'
import { newDownloadOperationId } from '@/shared/integration'
import type { DetectedMedia } from '@/shared/media'
import {
  isResolvableVideoPage,
  mediaStorageKey,
  mediaTabStorageKey,
} from '@/shared/media'
import { isErrorResponse } from '@/shared/messages'

type ActiveTab = { id?: number; url?: string }
type TabsApi = {
  query(queryInfo: {
    active: boolean
    currentWindow: boolean
  }): Promise<ActiveTab[]>
}
type StorageChange = { newValue?: unknown }
type StorageChangedListener = (
  changes: Record<string, StorageChange>,
  areaName: string
) => void
type StorageChangedApi = {
  addListener(listener: StorageChangedListener): void
  removeListener(listener: StorageChangedListener): void
}
type SessionStorageArea = {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

interface PersistedPageMediaSubmissions {
  resources: Record<string, string>
  page?: string
}

const PAGE_MEDIA_SUBMISSIONS_SESSION_PREFIX =
  'motrix.pageMedia.pendingSubmissions.v1:'
const MIN_IDEMPOTENCY_KEY_LENGTH = 8
const MAX_IDEMPOTENCY_KEY_LENGTH = 128

export function pageMediaSubmissionsSessionKey(scope: string): string {
  return `${PAGE_MEDIA_SUBMISSIONS_SESSION_PREFIX}${scope}`
}

function sessionStorageArea(): SessionStorageArea | null {
  try {
    const area = (
      globalThis as typeof globalThis & {
        chrome?: { storage?: { session?: Partial<SessionStorageArea> } }
      }
    ).chrome?.storage?.session
    if (
      typeof area?.get !== 'function' ||
      typeof area.set !== 'function' ||
      typeof area.remove !== 'function'
    ) {
      return null
    }
    return area as SessionStorageArea
  } catch {
    return null
  }
}

function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_IDEMPOTENCY_KEY_LENGTH &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH
  )
}

function normalizePendingSubmissions(
  value: unknown
): PersistedPageMediaSubmissions {
  if (typeof value !== 'object' || value === null) return { resources: {} }
  const candidate = value as {
    resources?: unknown
    page?: unknown
  }
  const resources: Record<string, string> = {}
  if (typeof candidate.resources === 'object' && candidate.resources !== null) {
    for (const [mediaKey, idempotencyKey] of Object.entries(
      candidate.resources
    )) {
      if (isIdempotencyKey(idempotencyKey)) {
        resources[mediaKey] = idempotencyKey
      }
    }
  }
  return isIdempotencyKey(candidate.page)
    ? { resources, page: candidate.page }
    : { resources }
}

let pendingSubmissionStorageQueue = Promise.resolve()

function mutatePendingSubmissions(
  scope: string,
  mutate: (current: PersistedPageMediaSubmissions) => void
): Promise<void> {
  pendingSubmissionStorageQueue = pendingSubmissionStorageQueue.then(
    async () => {
      const storage = sessionStorageArea()
      if (!storage) return
      const storageKey = pageMediaSubmissionsSessionKey(scope)
      try {
        const stored = await storage.get(storageKey)
        const current = normalizePendingSubmissions(stored[storageKey])
        mutate(current)
        if (
          Object.keys(current.resources).length === 0 &&
          current.page === undefined
        ) {
          await storage.remove(storageKey)
        } else {
          await storage.set({ [storageKey]: current })
        }
      } catch {
        // Recovery persistence is best-effort. The in-memory key still makes
        // an ordinary retry in the currently open Popup safe.
      }
    }
  )
  return pendingSubmissionStorageQueue
}

async function loadPendingSubmissions(
  scope: string
): Promise<PersistedPageMediaSubmissions> {
  await pendingSubmissionStorageQueue
  const storage = sessionStorageArea()
  if (!storage) return { resources: {} }
  const storageKey = pageMediaSubmissionsSessionKey(scope)
  try {
    const stored = await storage.get(storageKey)
    return normalizePendingSubmissions(stored[storageKey])
  } catch {
    return { resources: {} }
  }
}

function rememberResourceSubmission(
  scope: string,
  mediaKey: string,
  idempotencyKey: string
): Promise<void> {
  return mutatePendingSubmissions(scope, (current) => {
    current.resources[mediaKey] = idempotencyKey
  })
}

function clearResourceSubmission(
  scope: string,
  mediaKey: string,
  idempotencyKey: string
): Promise<void> {
  return mutatePendingSubmissions(scope, (current) => {
    if (current.resources[mediaKey] === idempotencyKey) {
      delete current.resources[mediaKey]
    }
  })
}

function rememberPageSubmission(
  scope: string,
  idempotencyKey: string
): Promise<void> {
  return mutatePendingSubmissions(scope, (current) => {
    current.page = idempotencyKey
  })
}

function clearPageSubmission(
  scope: string,
  idempotencyKey: string
): Promise<void> {
  return mutatePendingSubmissions(scope, (current) => {
    if (current.page === idempotencyKey) delete current.page
  })
}

function popupExtensionApis(): {
  tabs: TabsApi | undefined
  storageChanged: StorageChangedApi | undefined
} {
  const globals = globalThis as unknown as {
    browser?: {
      tabs?: TabsApi
      storage?: { onChanged?: StorageChangedApi }
    }
    chrome?: {
      tabs?: TabsApi
      storage?: { onChanged?: StorageChangedApi }
    }
  }
  return {
    tabs: globals.browser?.tabs ?? globals.chrome?.tabs,
    storageChanged:
      globals.browser?.storage?.onChanged ?? globals.chrome?.storage?.onChanged,
  }
}

export function usePageMedia(
  submissionKey = 'default',
  pairIfNeeded = false
): {
  media: DetectedMedia[]
  selectionKinds: string[]
  scanning: boolean
  error: string | null
  scan: () => Promise<void>
  download: (m: DetectedMedia) => Promise<void>
  getThumbnail: (m: DetectedMedia) => Promise<string | null>
  resolvableSite: 'bilibili' | 'youtube' | null
  resolvePageDownload: () => Promise<{ taskId: string }>
} {
  const [media, setMedia] = useState<DetectedMedia[]>([])
  const [selectionKinds, setKinds] = useState<string[]>(['direct'])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolvableSite, setResolvableSite] = useState<
    'bilibili' | 'youtube' | null
  >(null)
  const scanGeneration = useRef(0)
  const liveMediaRevision = useRef(0)
  const idempotencyKeys = useRef(new Map<string, string>())
  const pageIdempotencyKey = useRef<string | null>(null)
  const submissionKeyRef = useRef(submissionKey)
  const pendingLoadRef = useRef<{
    scope: string
    promise: Promise<PersistedPageMediaSubmissions> | null
    applied: boolean
  }>({ scope: submissionKey, promise: null, applied: false })

  const syncSubmissionKey = useCallback((): void => {
    if (submissionKeyRef.current === submissionKey) return
    submissionKeyRef.current = submissionKey
    idempotencyKeys.current.clear()
    pageIdempotencyKey.current = null
    pendingLoadRef.current = {
      scope: submissionKey,
      promise: null,
      applied: false,
    }
  }, [submissionKey])

  const hydratePendingKeys = useCallback(async (scope: string) => {
    const load = pendingLoadRef.current
    if (load.scope !== scope) return
    load.promise ??= loadPendingSubmissions(scope)
    const persisted = await load.promise
    if (pendingLoadRef.current !== load || load.applied) return
    load.applied = true
    for (const [mediaKey, idempotencyKey] of Object.entries(
      persisted.resources
    )) {
      if (!idempotencyKeys.current.has(mediaKey)) {
        idempotencyKeys.current.set(mediaKey, idempotencyKey)
      }
    }
    pageIdempotencyKey.current ??= persisted.page ?? null
  }, [])

  useEffect(() => syncSubmissionKey(), [syncSubmissionKey])

  // On mount, identify the active tab for both the page-level resolver and
  // MediaStore's live session-storage feed. The latter means a sniffer report
  // can appear in the open Popup without reinjecting or running another scan.
  useEffect(() => {
    const { tabs, storageChanged } = popupExtensionApis()
    let activeTabId: number | null = null
    let cancelled = false
    const onStorageChanged: StorageChangedListener = (changes, areaName) => {
      if (cancelled || areaName !== 'session' || activeTabId === null) return
      const change = changes[mediaTabStorageKey(activeTabId)]
      if (change === undefined) return
      if (change.newValue === undefined) {
        liveMediaRevision.current += 1
        setMedia([])
        return
      }
      if (Array.isArray(change.newValue)) {
        liveMediaRevision.current += 1
        setMedia(change.newValue as DetectedMedia[])
      }
    }

    storageChanged?.addListener(onStorageChanged)
    if (tabs === undefined) {
      return () => {
        cancelled = true
        storageChanged?.removeListener(onStorageChanged)
      }
    }

    void tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (cancelled) return
        activeTabId = typeof tab?.id === 'number' ? tab.id : null
        if (!tab?.url) return
        const check = isResolvableVideoPage(tab.url, isWebStoreBuild())
        setResolvableSite(check.resolvable ? check.site : null)
      })
      .catch(() => {
        // Preview pages and restricted browser surfaces may expose only part
        // of the tabs API. Scanning still reports its own localized state.
      })

    return () => {
      cancelled = true
      storageChanged?.removeListener(onStorageChanged)
    }
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    const generation = ++scanGeneration.current
    const liveRevisionAtStart = liveMediaRevision.current
    setScanning(true)
    setError(null)
    try {
      const r = await send('bg.scanActiveTab', undefined)
      if (isErrorResponse(r)) throw new Error(r.error)
      if (!Array.isArray(r.media) || !Array.isArray(r.selectionKinds)) {
        throw new Error('invalid media scan response')
      }
      if (generation !== scanGeneration.current) return
      if (liveMediaRevision.current === liveRevisionAtStart) {
        setMedia(r.media)
      }
      setKinds(r.selectionKinds)
    } catch (e) {
      if (generation !== scanGeneration.current) return
      setError((e as Error).message)
    } finally {
      if (generation === scanGeneration.current) setScanning(false)
    }
  }, [])

  const download = useCallback(
    async (m: DetectedMedia): Promise<void> => {
      syncSubmissionKey()
      const scope = submissionKeyRef.current
      await hydratePendingKeys(scope)
      const mediaKey = mediaStorageKey(m)
      const idempotencyKey =
        idempotencyKeys.current.get(mediaKey) ?? newDownloadOperationId()
      idempotencyKeys.current.set(mediaKey, idempotencyKey)
      // Commit the logical operation before crossing the Popup → background
      // boundary. If the Popup closes after Motrix accepts the task but before
      // the acknowledgement arrives, the next Popup reuses this exact key.
      await rememberResourceSubmission(scope, mediaKey, idempotencyKey)
      const r = await send('bg.submitMedia', {
        mediaKey,
        idempotencyKey,
        ...(pairIfNeeded ? { pairIfNeeded: true } : {}),
      })
      if (isErrorResponse(r)) throw new Error(r.error)
      if (
        submissionKeyRef.current === scope &&
        idempotencyKeys.current.get(mediaKey) === idempotencyKey
      ) {
        idempotencyKeys.current.delete(mediaKey)
      }
      await clearResourceSubmission(scope, mediaKey, idempotencyKey)
    },
    [hydratePendingKeys, syncSubmissionKey, pairIfNeeded]
  )

  const getThumbnail = useCallback(
    async (m: DetectedMedia): Promise<string | null> => {
      const r = await send('bg.getMediaThumbnail', {
        mediaKey: mediaStorageKey(m),
      })
      if (isErrorResponse(r)) return null
      return typeof r.dataUrl === 'string' ? r.dataUrl : null
    },
    []
  )

  const resolvePageDownload = useCallback(async (): Promise<{
    taskId: string
  }> => {
    syncSubmissionKey()
    const scope = submissionKeyRef.current
    await hydratePendingKeys(scope)
    const idempotencyKey =
      pageIdempotencyKey.current ?? newDownloadOperationId()
    pageIdempotencyKey.current = idempotencyKey
    await rememberPageSubmission(scope, idempotencyKey)
    const r = await send('bg.resolvePageDownload', {
      idempotencyKey,
      ...(pairIfNeeded ? { pairIfNeeded: true } : {}),
    })
    if (isErrorResponse(r)) throw new Error(r.error)
    if (
      submissionKeyRef.current === scope &&
      pageIdempotencyKey.current === idempotencyKey
    ) {
      pageIdempotencyKey.current = null
    }
    await clearPageSubmission(scope, idempotencyKey)
    return r
  }, [hydratePendingKeys, syncSubmissionKey, pairIfNeeded])

  return {
    media,
    selectionKinds,
    scanning,
    error,
    scan,
    download,
    getThumbnail,
    resolvableSite,
    resolvePageDownload,
  }
}
