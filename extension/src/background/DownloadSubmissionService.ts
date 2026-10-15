import type { DownloadSubmitParams, DownloadSubmitResult } from '@motrix/mdxp'
import type { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import type { ConnectionManager } from '@/background/ConnectionManager'
import {
  beforeDeadline,
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import {
  HandoffEndpointChangedError,
  type HandoffGuard,
} from '@/background/handoff/guard'
import type { DirectorySelection } from '@/shared/downloadDirectories'
import {
  DOWNLOAD_ERROR,
  DOWNLOAD_OPERATION_TTL_MS,
  type DownloadOperation,
  downloadOperationIssuedAt,
  isDownloadErrorReason,
} from '@/shared/integration'

const STORAGE_KEY = 'motrix.downloadOperations.v1'
const MAX_RECORDS = 1000

interface OperationRecord extends DownloadOperation {
  fingerprint: string
  endpointRevision: number
}

interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export interface DownloadPreparation {
  assertCurrent(): void
  deadlineAt: number
}

interface SubmissionDeps {
  popup?: Pick<AutoOpenPopupService, 'captureSubmission'>
  manager: Pick<
    ConnectionManager,
    'ensureReady' | 'submitDownload' | 'clearGateAndStart'
  >
  isPaired(): Promise<boolean>
  captureGuard(): Promise<HandoffGuard | null>
  storage?: SessionStorage | undefined
  now?: () => number
}

/** Owns a logical submission independently of its popup. Session records contain
 * only opaque keys, a request digest and status. Recovery never replays a request
 * that might already have reached a previous Motrix process. */
export class DownloadSubmissionService {
  private readonly records = new Map<string, OperationRecord>()
  private readonly flights = new Map<string, Promise<DownloadSubmitResult>>()
  private readonly loaded: Promise<void>
  private writeTail = Promise.resolve()
  private readonly now: () => number

  constructor(private readonly deps: SubmissionDeps) {
    this.now = deps.now ?? Date.now
    this.loaded = this.restore()
    void this.loaded.catch(() => {})
  }

  async list(
    endpointId: string,
    endpointRevision?: number
  ): Promise<DownloadOperation[]> {
    await this.loaded
    this.prune()
    return [...this.records.values()]
      .filter(
        (record) =>
          record.endpointId === endpointId &&
          (endpointRevision === undefined ||
            record.endpointRevision === endpointRevision)
      )
      .map(
        ({
          fingerprint: _fingerprint,
          endpointRevision: _revision,
          ...record
        }) => record
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async run(
    input: {
      idempotencyKey: string
      source: DownloadOperation['source']
      resourceKey: string
      directory?: DirectorySelection | undefined
      pairIfNeeded?: boolean | undefined
    },
    prepare: (context: DownloadPreparation) => Promise<DownloadSubmitParams>
  ): Promise<DownloadSubmitResult> {
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
      throw new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
    }
    const deadlineAt = this.now() + (input.pairIfNeeded ? 150_000 : 30_000)
    const present = this.deps.popup?.captureSubmission()
    const guard = await this.deps.captureGuard()
    if (!guard?.endpointId)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.endpointChanged)
    if (
      input.directory &&
      (input.directory.endpointId !== guard.endpointId ||
        input.directory.endpointRevision !== (guard.endpointRevision ?? 0))
    ) {
      throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
    }
    await this.loaded
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([
          input.source,
          input.resourceKey,
          input.directory,
          guard.endpointId,
          guard.endpointRevision,
        ])
      )
    )
    const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    const assertCurrent = (): void => {
      guard.assertCurrent()
      if (this.now() >= deadlineAt)
        throw new DownloadPreparationError(DOWNLOAD_ERROR.preparationTimeout)
    }
    assertCurrent()
    const previous = this.records.get(input.idempotencyKey)
    if (previous && previous.fingerprint !== fingerprint) {
      throw new DownloadPreparationError(DOWNLOAD_ERROR.contextChanged)
    }
    const flight = this.flights.get(input.idempotencyKey)
    if (flight) return flight
    if (previous?.state === 'accepted' && previous.taskId)
      return { taskId: previous.taskId }
    if (previous?.state === 'unknown') throw new DownloadOutcomeUnknownError()

    this.prune()
    const issuedAt = downloadOperationIssuedAt(input.idempotencyKey)
    if (
      !previous &&
      (issuedAt === null ||
        issuedAt > this.now() + 60_000 ||
        this.now() - issuedAt >= DOWNLOAD_OPERATION_TTL_MS)
    ) {
      // Old popup drafts and expired records cannot prove whether a previous
      // App accepted this key. Ask the user to inspect tasks instead of replaying.
      throw new DownloadOutcomeUnknownError()
    }
    if (this.records.size >= MAX_RECORDS && !previous) {
      // Never evict an unresolved record just to accept another operation.
      throw new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
    }
    const record: OperationRecord = {
      id: input.idempotencyKey,
      source: input.source,
      endpointId: guard.endpointId,
      endpointRevision: guard.endpointRevision ?? 0,
      fingerprint,
      state: 'preparing',
      updatedAt: this.now(),
    }
    this.records.set(record.id, record)
    const operation = this.perform(
      record,
      { assertCurrent, deadlineAt },
      prepare,
      input.pairIfNeeded === true,
      input.directory
    )
    this.flights.set(record.id, operation)
    try {
      const result = await operation
      void present?.({ ...result, operationId: record.id }, guard).catch(
        () => {}
      )
      return result
    } finally {
      if (this.flights.get(record.id) === operation)
        this.flights.delete(record.id)
    }
  }

  private async perform(
    record: OperationRecord,
    context: DownloadPreparation,
    prepare: (context: DownloadPreparation) => Promise<DownloadSubmitParams>,
    pairIfNeeded: boolean,
    directory?: DirectorySelection
  ): Promise<DownloadSubmitResult> {
    try {
      await this.persist()
      context.assertCurrent()
      if (pairIfNeeded && !(await this.deps.isPaired())) {
        context.assertCurrent()
        await beforeDeadline(
          this.deps.manager.clearGateAndStart(),
          context.deadlineAt
        )
      }
      context.assertCurrent()
      await this.deps.manager.ensureReady({
        intent: 'explicit-download',
        deadlineAt: context.deadlineAt,
        assertCurrent: context.assertCurrent,
      })
      context.assertCurrent()
      const params = await beforeDeadline(prepare(context), context.deadlineAt)
      context.assertCurrent()
      if (params.saveDir !== directory?.path)
        throw new DownloadPreparationError(DOWNLOAD_ERROR.directoryUnavailable)
      const result = await this.deps.manager.submitDownload(
        { ...params, idempotencyKey: record.id },
        {
          assertCurrent: context.assertCurrent,
          directoryInstanceId: directory?.instanceId,
          onSubmitting: async () => {
            record.state = 'submitting'
            record.updatedAt = this.now()
            await this.persist()
          },
        }
      )
      record.state = 'accepted'
      record.taskId = result.taskId
      record.updatedAt = this.now()
      // A failed advisory persistence write cannot turn an accepted download
      // into a failed submission or trigger browser fallback.
      await this.persist().catch(() => {})
      return result
    } catch (error) {
      const unknown = error instanceof DownloadOutcomeUnknownError
      const reason = unknown
        ? DOWNLOAD_ERROR.resultUnknown
        : error instanceof HandoffEndpointChangedError
          ? DOWNLOAD_ERROR.endpointChanged
          : isDownloadErrorReason((error as Error)?.message)
            ? (error as Error).message
            : DOWNLOAD_ERROR.rejected
      record.state = unknown ? 'unknown' : 'failed'
      record.reason = reason
      record.updatedAt = this.now()
      await this.persist().catch(() => {})
      if (unknown) throw error
      throw new DownloadPreparationError(
        isDownloadErrorReason(reason) ? reason : DOWNLOAD_ERROR.rejected
      )
    }
  }

  private prune(): void {
    const cutoff = this.now() - DOWNLOAD_OPERATION_TTL_MS
    for (const id of this.records.keys()) {
      // The timestamped key is rejected after expiry even when its record
      // has gone, so pruning cannot make a stale popup request replayable.
      if (
        (downloadOperationIssuedAt(id) ?? 0) <= cutoff &&
        !this.flights.has(id)
      ) {
        this.records.delete(id)
      }
    }
  }

  private async restore(): Promise<void> {
    const storage = this.deps.storage
    if (!storage) return
    const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY]
    if (value === undefined) return
    if (!Array.isArray(value) || value.length > MAX_RECORDS)
      throw new DownloadPreparationError(DOWNLOAD_ERROR.interrupted)
    for (const raw of value) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.id !== 'string' ||
        this.records.has(raw.id) ||
        typeof raw.fingerprint !== 'string' ||
        typeof raw.endpointId !== 'string' ||
        !['media', 'page', 'manual', 'direct'].includes(raw.source) ||
        !['preparing', 'submitting', 'accepted', 'failed', 'unknown'].includes(
          raw.state
        ) ||
        !Number.isFinite(raw.updatedAt) ||
        !Number.isSafeInteger(raw.endpointRevision) ||
        (raw.state === 'accepted' && typeof raw.taskId !== 'string')
      ) {
        throw new DownloadPreparationError(DOWNLOAD_ERROR.interrupted)
      }
      const record: OperationRecord = {
        id: raw.id,
        fingerprint: raw.fingerprint,
        endpointId: raw.endpointId,
        endpointRevision: raw.endpointRevision,
        source: raw.source,
        state:
          raw.state === 'submitting'
            ? 'unknown'
            : raw.state === 'preparing'
              ? 'failed'
              : raw.state,
        updatedAt: raw.updatedAt,
        ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
        ...(isDownloadErrorReason(raw.reason) ? { reason: raw.reason } : {}),
      }
      if (raw.state === 'submitting')
        record.reason = DOWNLOAD_ERROR.resultUnknown
      if (raw.state === 'preparing') record.reason = DOWNLOAD_ERROR.interrupted
      this.records.set(record.id, record)
    }
    this.prune()
  }

  private persist(): Promise<void> {
    const storage = this.deps.storage
    if (!storage) return Promise.resolve()
    const write = this.writeTail.then(() =>
      storage.set({
        [STORAGE_KEY]: [...this.records.values()].map((record) => ({
          ...record,
        })),
      })
    )
    this.writeTail = write.catch(() => {})
    return write
  }
}
