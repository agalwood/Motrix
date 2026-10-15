import { DownloadOutcomeUnknownError } from '@/background/download-errors'
import { HandoffEndpointChangedError } from '@/background/handoff/guard'
import {
  CONFIRMATION_TIMEOUT_MS,
  type DownloadConfirmation,
} from '@/shared/downloadConfirmation'
import {
  DOWNLOAD_ERROR,
  isDownloadErrorReason,
  newDownloadOperationId,
} from '@/shared/integration'
import { isMagnetUrl, type TakeoverTarget } from '@/shared/takeover'
import {
  defaultTaskOptions,
  type TaskOptions,
  taskOptionsDraftSchema,
  taskOptionsSchema,
} from '@/shared/taskOptions'

export interface ConfirmationBinding {
  endpointId: string
  endpointRevision: number
}

export type RecoverConfirmation = (
  target: TakeoverTarget,
  binding: ConfirmationBinding
) => Promise<ConfirmationActions | null>

interface ConfirmationIO {
  supported(): boolean
  open(windowId: number, isCurrent: () => boolean): Promise<void>
  publish(windowId: number, draft: DownloadConfirmation | null): void
  userAgent(): string
  storage?:
    | {
        get(key: string): Promise<Record<string, unknown>>
        set(items: Record<string, unknown>): Promise<void>
      }
    | undefined
  recover?: RecoverConfirmation | undefined
}

export interface ConfirmationActions {
  submit(options: TaskOptions, operationId: string): Promise<{ taskId: string }>
  browser?: (() => Promise<void>) | undefined
}

export type ConfirmationResult =
  | { action: 'accepted'; taskId: string }
  | { action: 'browser' | 'cancel' | 'unavailable' | 'unsupported' }

interface Pending {
  draft: DownloadConfirmation
  operationId: string
  submittedOptions?: string
  actions: ConfirmationActions
  binding?: ConfirmationBinding | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  settle(decision: ConfirmationResult): void
}

const STORAGE_KEY = 'motrix.downloadConfirmation.v1'
const savedConfirmationSchema = z.object({
  draft: z.object({
    id: z.string(),
    windowId: z.number().int().nonnegative(),
    expiresAt: z.number().finite(),
    target: z.object({
      url: z.string().regex(/^(https?:\/\/|magnet:\?)/i),
      pageUrl: z.string(),
      pageTitle: z.string(),
      suggestedFilename: z.string(),
      filenameFromUrl: z.boolean().default(false),
      mime: z.string(),
      sizeBytes: z.number().nullable(),
      siteHint: z.string(),
      origin: z.enum(['auto', 'context-menu']),
      nativeDownloadCancelled: z.boolean().optional(),
    }),
    options: taskOptionsDraftSchema,
    phase: z.enum(['editing', 'submitting', 'failed', 'unknown']),
    error: z
      .custom<DownloadConfirmation['error']>(isDownloadErrorReason)
      .optional(),
  }),
  binding: z.object({
    endpointId: z.string(),
    endpointRevision: z.number().int().nonnegative(),
  }),
  operationId: z.string(),
  submittedOptions: z.string().optional(),
})

/** The UI owns the draft; once confirmed, the submission service owns delivery. */
export class DownloadConfirmationService {
  private pending = new Map<number, Pending>()
  private restoring: boolean
  private generation = 0
  private closedWindows = new Set<number>()
  private writeTail = Promise.resolve()
  readonly ready: Promise<void>

  constructor(private readonly io: ConfirmationIO) {
    this.restoring = !!io.storage && !!io.recover
    this.ready = this.restoring
      ? this.restore().finally(() => {
          this.restoring = false
        })
      : Promise.resolve()
  }

  request(
    target: TakeoverTarget,
    windowId: number | undefined,
    actions: ConfirmationActions,
    binding?: ConfirmationBinding
  ): Promise<ConfirmationResult> {
    if (this.restoring)
      return this.ready.then(() =>
        this.request(target, windowId, actions, binding)
      )
    if (!this.io.supported()) return Promise.resolve({ action: 'unsupported' })
    if (
      windowId === undefined ||
      !Number.isInteger(windowId) ||
      windowId < 0 ||
      this.pending.has(windowId)
    )
      return Promise.resolve({ action: 'unavailable' })
    const options = defaultTaskOptions(this.io.userAgent())
    options.filename = target.filenameFromUrl ? '' : target.suggestedFilename
    options.referer = /^https?:\/\//i.test(target.pageUrl) ? target.pageUrl : ''
    options.useBrowserCookies = true
    const draft: DownloadConfirmation = {
      id: crypto.randomUUID(),
      windowId,
      target,
      options,
      phase: 'editing',
      expiresAt: Date.now() + CONFIRMATION_TIMEOUT_MS,
    }
    return new Promise((resolve) => {
      const pending: Pending = {
        draft,
        actions,
        binding,
        operationId: newDownloadOperationId(),
        timer: undefined,
        settle: (decision) => {
          if (this.pending.get(windowId) !== pending) return
          clearTimeout(pending.timer)
          this.pending.delete(windowId)
          void this.persist()
          this.publish(windowId, null)
          resolve(decision)
        },
      }
      this.pending.set(windowId, pending)
      this.armExpiry(pending)
      void this.persist()
      this.publish(windowId, draft)
      void this.io
        .open(windowId, () => this.pending.get(windowId) === pending)
        .catch(() => {
          // Opening is advisory once a user has already confirmed in a live view.
          if (pending.draft.phase === 'editing') {
            // Early takeover will replay in the browser after this result.
            // Retaining its draft would allow a second, late submission.
            if (target.nativeDownloadCancelled)
              pending.settle({ action: 'unavailable' })
            else resolve({ action: 'unavailable' })
          }
        })
    })
  }

  get(windowId: number): DownloadConfirmation | null {
    return this.pending.get(windowId)?.draft ?? null
  }

  decide(windowId: number, id: string, input: unknown): boolean {
    const pending = this.pending.get(windowId)
    if (!pending || pending.draft.id !== id) return false
    if (!input || typeof input !== 'object' || !('action' in input))
      return false
    if (input.action === 'cancel') {
      // Dismissing a submitted task never cancels or replays its network request.
      pending.settle({ action: 'cancel' })
      return true
    }
    if (
      pending.draft.phase === 'submitting' ||
      pending.draft.phase === 'unknown' ||
      Date.now() >= pending.draft.expiresAt
    )
      return false
    if (input.action === 'edit') {
      const parsed = taskOptionsDraftSchema.safeParse(
        'options' in input ? input.options : null
      )
      if (!parsed.success) return false
      pending.draft.options = parsed.data
      void this.persist()
      return true
    }
    if (input.action === 'submit') {
      const parsed = taskOptionsSchema.safeParse(
        'options' in input ? input.options : null
      )
      if (!parsed.success) return false
      const fingerprint = JSON.stringify(parsed.data)
      if (
        pending.submittedOptions !== undefined &&
        pending.submittedOptions !== fingerprint
      )
        pending.operationId = newDownloadOperationId()
      pending.submittedOptions = fingerprint
      pending.draft.options = parsed.data
      this.perform(pending, () =>
        pending.actions
          .submit(parsed.data, pending.operationId)
          .then(({ taskId }) => ({ action: 'accepted', taskId }))
      )
    } else if (
      input.action === 'browser' &&
      !isMagnetUrl(pending.draft.target.url) &&
      pending.actions.browser
    ) {
      const downloadInBrowser = pending.actions.browser
      this.perform(pending, () =>
        downloadInBrowser().then(() => ({ action: 'browser' }))
      )
    } else return false
    return true
  }

  private perform(
    pending: Pending,
    action: () => Promise<ConfirmationResult>
  ): void {
    clearTimeout(pending.timer)
    pending.draft.phase = 'submitting'
    delete pending.draft.error
    this.publish(pending.draft.windowId, pending.draft)
    void (async () => {
      try {
        await this.persist()
        pending.settle(await action())
      } catch (error) {
        if (this.pending.get(pending.draft.windowId) !== pending) return
        const unknown = error instanceof DownloadOutcomeUnknownError
        const reason = (error as Error)?.message
        pending.draft.phase = unknown ? 'unknown' : 'failed'
        pending.draft.error = unknown
          ? DOWNLOAD_ERROR.resultUnknown
          : error instanceof HandoffEndpointChangedError
            ? DOWNLOAD_ERROR.endpointChanged
            : isDownloadErrorReason(reason)
              ? reason
              : DOWNLOAD_ERROR.rejected
        this.armExpiry(pending)
        void this.persist()
        this.publish(pending.draft.windowId, pending.draft)
      }
    })()
  }

  private armExpiry(pending: Pending): void {
    pending.draft.expiresAt = Date.now() + CONFIRMATION_TIMEOUT_MS
    pending.timer = setTimeout(
      () => pending.settle({ action: 'cancel' }),
      CONFIRMATION_TIMEOUT_MS
    )
  }

  private publish(windowId: number, draft: DownloadConfirmation | null): void {
    // A broken renderer must not turn an accepted task into a retryable failure.
    try {
      this.io.publish(windowId, draft ? structuredClone(draft) : null)
    } catch {
      /* Advisory UI. */
    }
  }

  close(windowId: number): void {
    if (this.restoring) this.closedWindows.add(windowId)
    this.pending.get(windowId)?.settle({ action: 'cancel' })
  }
  cancelAll(): void {
    this.generation += 1
    for (const windowId of this.pending.keys()) this.close(windowId)
  }

  private persist(): Promise<void> {
    const storage = this.io.storage
    if (!storage) return Promise.resolve()
    const records = [...this.pending.values()]
      .filter((p) => p.binding)
      .map((p) => ({
        draft: structuredClone(p.draft),
        binding: p.binding,
        operationId: p.operationId,
        ...(p.submittedOptions === undefined
          ? {}
          : { submittedOptions: p.submittedOptions }),
      }))
    const write = this.writeTail.then(() =>
      storage.set({ [STORAGE_KEY]: records })
    )
    // Session persistence is advisory; never turn an accepted task into a retry.
    this.writeTail = write.catch(() => {})
    return this.writeTail
  }

  private async restore(): Promise<void> {
    const generation = this.generation
    const { storage, recover } = this.io
    if (!storage || !recover) return
    try {
      const records = (await storage.get(STORAGE_KEY))[STORAGE_KEY]
      if (!Array.isArray(records)) return
      for (const value of records.slice(0, 100)) {
        const parsed = savedConfirmationSchema.safeParse(value)
        if (!parsed.success) continue
        const { draft, binding, operationId, submittedOptions } = parsed.data
        if (draft.expiresAt <= Date.now() || this.pending.has(draft.windowId))
          continue
        const actions = await recover(draft.target, binding).catch(() => null)
        if (
          !actions ||
          generation !== this.generation ||
          this.closedWindows.has(draft.windowId)
        )
          continue
        if (draft.phase === 'submitting') {
          // A worker restart cannot prove whether the previous send reached Motrix.
          draft.phase = 'unknown'
          draft.error = DOWNLOAD_ERROR.resultUnknown
        }
        const pending: Pending = {
          draft: draft as DownloadConfirmation,
          binding,
          operationId,
          actions,
          timer: undefined,
          ...(submittedOptions === undefined ? {} : { submittedOptions }),
          settle: () => {
            if (this.pending.get(draft.windowId) !== pending) return
            clearTimeout(pending.timer)
            this.pending.delete(draft.windowId)
            void this.persist()
            this.publish(draft.windowId, null)
          },
        }
        this.pending.set(draft.windowId, pending)
        pending.timer = setTimeout(
          () => pending.settle({ action: 'cancel' }),
          Math.max(0, draft.expiresAt - Date.now())
        )
      }
    } catch {
      // A missing session store must not initiate a download during recovery.
    } finally {
      this.closedWindows.clear()
      await this.persist()
    }
  }
}

import { z } from 'zod'
