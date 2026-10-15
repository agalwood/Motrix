import { useCallback, useEffect, useRef, useState } from 'react'
import { send } from '@/background/MessageBus'
import { DOWNLOAD_ERROR, newDownloadOperationId } from '@/shared/integration'
import { parseManualTaskInput } from '@/shared/manualTask'
import {
  defaultTaskOptions,
  type TaskOptions,
  taskOptionsSchema,
} from '@/shared/taskOptions'

export type QuickAddTaskErrorKind =
  | 'invalidOptions'
  | 'directoryUnavailable'
  | 'empty'
  | 'unsupported'
  | 'invalid'
  | 'submitFailed'
  | 'resultUnknown'
  | 'pairingRequired'
  | 'connectionFailed'
  | 'contextChanged'

export interface QuickAddTaskController {
  options: TaskOptions
  setOptions: (options: TaskOptions) => void
  input: string
  error: QuickAddTaskErrorKind | null
  submitting: boolean
  setInput: (input: string) => void
  submit: () => Promise<string | null>
  reset: () => void
}

export interface UseQuickAddTaskOptions {
  pairIfNeeded?: boolean
  onCreated: (taskId: string) => void | Promise<void>
}

export const QUICK_ADD_TASK_SESSION_KEY = 'motrix.quickAddTask.pending.v1'

interface PersistedQuickAddTask {
  options?: TaskOptions
  normalizedInput: string
  idempotencyKey: string
}

interface SessionStorageArea {
  get: (key: string) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
  remove: (key: string) => Promise<void>
}

const MIN_IDEMPOTENCY_KEY_LENGTH = 8
const MAX_IDEMPOTENCY_KEY_LENGTH = 128

/**
 * `storage.session` is present in supported Chromium builds and recent
 * Firefox releases, but the popup must remain usable when it is unavailable
 * (preview pages, older browsers, or denied/failed storage access).
 */
function getSessionStorage(): SessionStorageArea | null {
  try {
    const area = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: { session?: Partial<SessionStorageArea> }
        }
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

function normalizePersistedDraft(value: unknown): PersistedQuickAddTask | null {
  if (typeof value !== 'object' || value === null) return null

  const draft = value as Partial<PersistedQuickAddTask>
  if (
    typeof draft.normalizedInput !== 'string' ||
    typeof draft.idempotencyKey !== 'string' ||
    draft.idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH ||
    draft.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    return null
  }

  const options = taskOptionsSchema.safeParse(
    draft.options ?? defaultTaskOptions(navigator.userAgent)
  )
  if (!options.success) return null
  const parsed = parseManualTaskInput(draft.normalizedInput)
  if (!parsed.ok) return null

  const normalizedInput =
    parsed.value.kind === 'direct' ? parsed.value.url : parsed.value.uri
  return normalizedInput === draft.normalizedInput
    ? {
        normalizedInput,
        idempotencyKey: draft.idempotencyKey,
        options: options.data,
      }
    : null
}

// A user can edit and immediately submit while a best-effort cleanup is still
// in flight. Serialize mutations so that an older remove can never erase the
// newer draft written just before the message is sent.
let storageMutationQueue = Promise.resolve()

function mutateSessionStorage(
  mutation: (storage: SessionStorageArea) => Promise<void>
): Promise<void> {
  storageMutationQueue = storageMutationQueue.then(async () => {
    const storage = getSessionStorage()
    if (!storage) return
    try {
      await mutation(storage)
    } catch {
      // Persistence is recovery-only; never block the core task flow.
    }
  })
  return storageMutationQueue
}

async function loadPersistedDraft(): Promise<PersistedQuickAddTask | null> {
  await storageMutationQueue
  const storage = getSessionStorage()
  if (!storage) return null
  try {
    const value = await storage.get(QUICK_ADD_TASK_SESSION_KEY)
    return normalizePersistedDraft(value[QUICK_ADD_TASK_SESSION_KEY])
  } catch {
    return null
  }
}

function persistDraft(draft: PersistedQuickAddTask): Promise<void> {
  return mutateSessionStorage((storage) =>
    storage.set({ [QUICK_ADD_TASK_SESSION_KEY]: draft })
  )
}

function clearPersistedDraft(): Promise<void> {
  return mutateSessionStorage((storage) =>
    storage.remove(QUICK_ADD_TASK_SESSION_KEY)
  )
}

/**
 * Owns one logical manual-task submission.
 *
 * The idempotency key survives a failed request so a retry cannot create a
 * duplicate task. Editing the input starts a new logical submission and thus
 * discards that key. Raw background/RPC errors are deliberately collapsed to
 * a stable UI error kind.
 */
export function useQuickAddTask({
  onCreated,
  pairIfNeeded = false,
}: UseQuickAddTaskOptions): QuickAddTaskController {
  const [input, setInputState] = useState('')
  const [options, setOptionsState] = useState(() =>
    defaultTaskOptions(navigator.userAgent)
  )
  const optionsRef = useRef(options)
  const [error, setError] = useState<QuickAddTaskErrorKind | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const inputRef = useRef('')
  const idempotencyKeyRef = useRef<string | null>(null)
  const submittingRef = useRef(false)
  const mountedRef = useRef(true)
  const onCreatedRef = useRef(onCreated)
  const pairIfNeededRef = useRef(pairIfNeeded)
  pairIfNeededRef.current = pairIfNeeded
  const inputRevisionRef = useRef(0)

  useEffect(() => {
    onCreatedRef.current = onCreated
  }, [onCreated])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const revisionAtStart = inputRevisionRef.current

    void loadPersistedDraft().then((draft) => {
      // Storage can resolve after the user has begun typing or explicitly
      // cleared the dialog. Never replace that newer intent with an old draft.
      if (
        cancelled ||
        !mountedRef.current ||
        !draft ||
        inputRevisionRef.current !== revisionAtStart ||
        inputRef.current !== ''
      ) {
        return
      }

      optionsRef.current =
        draft.options ?? defaultTaskOptions(navigator.userAgent)
      setOptionsState(optionsRef.current)
      inputRef.current = draft.normalizedInput
      idempotencyKeyRef.current = draft.idempotencyKey
      setInputState(draft.normalizedInput)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const setInput = useCallback((nextInput: string): void => {
    if (nextInput === inputRef.current) return

    const shouldClearPersistedDraft =
      inputRef.current === '' || idempotencyKeyRef.current !== null
    inputRevisionRef.current += 1
    inputRef.current = nextInput
    idempotencyKeyRef.current = null
    if (shouldClearPersistedDraft) void clearPersistedDraft()
    if (mountedRef.current) {
      setInputState(nextInput)
      setError(null)
    }
  }, [])

  const setOptions = useCallback((next: TaskOptions): void => {
    inputRevisionRef.current += 1
    optionsRef.current = next
    idempotencyKeyRef.current = null
    void clearPersistedDraft()
    setOptionsState(next)
    setError(null)
  }, [])

  const reset = useCallback((): void => {
    inputRevisionRef.current += 1
    optionsRef.current = defaultTaskOptions(navigator.userAgent)
    if (mountedRef.current) setOptionsState(optionsRef.current)
    inputRef.current = ''
    idempotencyKeyRef.current = null
    void clearPersistedDraft()
    if (mountedRef.current) {
      setInputState('')
      setError(null)
    }
  }, [])

  const submit = useCallback(async (): Promise<string | null> => {
    if (submittingRef.current) return null

    const parsed = parseManualTaskInput(inputRef.current)
    if (!parsed.ok) {
      if (mountedRef.current) setError(parsed.reason)
      return null
    }

    const parsedOptions = taskOptionsSchema.safeParse(optionsRef.current)
    if (!parsedOptions.success) {
      if (mountedRef.current) setError('invalidOptions')
      return null
    }
    const idempotencyKey = idempotencyKeyRef.current ?? newDownloadOperationId()
    idempotencyKeyRef.current = idempotencyKey
    const normalizedInput =
      parsed.value.kind === 'direct' ? parsed.value.url : parsed.value.uri

    submittingRef.current = true
    if (mountedRef.current) {
      setSubmitting(true)
      setError(null)
    }

    let taskId: string
    try {
      // Commit the logical submission before crossing the message boundary.
      // If the popup disappears after Motrix accepts the task but before the
      // response arrives, reopening it can retry with this exact same key.
      await persistDraft({
        normalizedInput,
        idempotencyKey,
        options: parsedOptions.data,
      })
      const response = await send('bg.createManualTask', {
        input: normalizedInput,
        options: parsedOptions.data,
        idempotencyKey,
        ...(pairIfNeededRef.current ? { pairIfNeeded: true } : {}),
      })
      taskId = response.taskId
    } catch (error) {
      if (mountedRef.current)
        setError(
          (error as Error)?.message === DOWNLOAD_ERROR.directoryUnavailable
            ? 'directoryUnavailable'
            : (error as Error)?.message === DOWNLOAD_ERROR.resultUnknown
              ? 'resultUnknown'
              : (error as Error)?.message === DOWNLOAD_ERROR.pairingRequired
                ? 'pairingRequired'
                : [
                      DOWNLOAD_ERROR.connectionFailed,
                      DOWNLOAD_ERROR.preparationTimeout,
                    ].includes((error as Error)?.message as never)
                  ? 'connectionFailed'
                  : [
                        DOWNLOAD_ERROR.endpointChanged,
                        DOWNLOAD_ERROR.contextChanged,
                      ].includes((error as Error)?.message as never)
                    ? 'contextChanged'
                    : 'submitFailed'
        )
      return null
    } finally {
      submittingRef.current = false
      if (mountedRef.current) setSubmitting(false)
    }

    optionsRef.current = defaultTaskOptions(navigator.userAgent)
    if (mountedRef.current) setOptionsState(optionsRef.current)
    inputRef.current = ''
    idempotencyKeyRef.current = null
    await clearPersistedDraft()
    if (mountedRef.current) {
      setInputState('')
      setError(null)
    }

    // The task already exists at this point. A refresh callback failure must
    // never turn the UI into a retry prompt, which could duplicate the task.
    try {
      await onCreatedRef.current(taskId)
    } catch {
      // Integration refresh errors are handled by the owning task panel.
    }

    return taskId
  }, [])

  return {
    input,
    options,
    setOptions,
    error,
    submitting,
    setInput,
    submit,
    reset,
  }
}
