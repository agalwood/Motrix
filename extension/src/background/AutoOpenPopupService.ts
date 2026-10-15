import type { HandoffGuard } from '@/background/handoff/guard'
import { createOperationQueue } from '@/background/mbp1/operation-queue'
import { rpcDeadline } from '@/background/RpcRecovery'
import type { PopupReceipt } from '@/shared/autoPopup'
import type { TakeoverConfig } from '@/shared/takeover'

const STORAGE_KEY = 'motrix.autoPopup.v1'
const BATCH_GAP_MS = 10_000
interface Batch {
  windowId: number
  lastAt: number
  count: number
}
interface SessionState {
  batches: Batch[]
  seen: string[]
  receipt: PopupReceipt | null
}

interface PopupDeps {
  supported(): boolean
  config(): Promise<TakeoverConfig>
  focusedWindow(): Promise<number | null>
  isOpen(windowId: number): boolean
  open(windowId: number): Promise<void>
  publish(receipt: PopupReceipt): Promise<void>
  storage: {
    get(key: string): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
  }
  now?: () => number
}

/** Presentation only. Failure must never escape into a download transaction. */
export class AutoOpenPopupService {
  private readonly enqueue = createOperationQueue()
  private readonly now: () => number
  constructor(private readonly deps: PopupDeps) {
    this.now = deps.now ?? Date.now
  }

  async captureWindow(): Promise<number | null> {
    try {
      return this.deps.supported()
        ? await rpcDeadline(this.deps.focusedWindow(), 500, 'popup window')
        : null
    } catch {
      return null
    }
  }

  /** Capture the originating window and preference before connection/pairing.
   * Call the returned presenter only after Motrix accepts a task. */
  captureSubmission(): (
    result: { taskId: string; operationId: string },
    guard: HandoffGuard
  ) => Promise<void> {
    const captured = rpcDeadline(
      Promise.all([this.deps.config(), this.captureWindow()]),
      500,
      'popup submission context'
    ).catch(() => null)
    return async (result, guard) => {
      const context = await captured
      if (!context || !guard.endpointId) return
      const [config, windowId] = context
      if (windowId === null) return
      await this.present({
        ...result,
        endpointId: guard.endpointId,
        endpointRevision: guard.endpointRevision ?? 0,
        windowId,
        enabledAtCapture: config.openTaskPanelAfterSubmit,
        assertCurrent: guard.assertCurrent,
      })
    }
  }

  private async read(): Promise<SessionState> {
    const raw = (await this.deps.storage.get(STORAGE_KEY))[STORAGE_KEY] as
      | Partial<SessionState>
      | undefined
    return {
      batches: Array.isArray(raw?.batches)
        ? raw.batches
            .filter(
              (b) =>
                b != null &&
                typeof b === 'object' &&
                Number.isInteger(b.windowId) &&
                Number.isFinite(b.lastAt) &&
                Number.isInteger(b.count)
            )
            .slice(-20)
        : [],
      seen: Array.isArray(raw?.seen)
        ? raw.seen.filter((id) => typeof id === 'string').slice(-100)
        : [],
      receipt:
        raw?.receipt &&
        typeof raw.receipt.taskId === 'string' &&
        typeof raw.receipt.operationId === 'string' &&
        Number.isInteger(raw.receipt.windowId) &&
        Number.isInteger(raw.receipt.endpointRevision) &&
        typeof raw.receipt.endpointId === 'string' &&
        Number.isFinite(raw.receipt.expiresAt) &&
        Number.isInteger(raw.receipt.count)
          ? raw.receipt
          : null,
    }
  }

  async receipt(windowId: number): Promise<PopupReceipt | null> {
    try {
      const { receipt } = await this.read()
      return receipt?.windowId === windowId && receipt.expiresAt > this.now()
        ? receipt
        : null
    } catch {
      return null
    }
  }

  async present(
    input: Omit<PopupReceipt, 'count' | 'expiresAt'> & {
      enabledAtCapture: boolean
      assertCurrent(): void
    }
  ): Promise<void> {
    const deadlineAt = this.now() + 2000
    try {
      await rpcDeadline(
        this.enqueue(async () => {
          const check = () => {
            if (this.now() >= deadlineAt) throw new Error('popup expired')
            input.assertCurrent()
          }
          if (
            !input.enabledAtCapture ||
            !this.deps.supported() ||
            !input.taskId ||
            !input.operationId
          )
            return
          check()
          const config = await this.deps.config()
          if (!config.openTaskPanelAfterSubmit) return
          const state = await this.read()
          check()
          if (state.seen.includes(input.operationId)) return
          const now = this.now()
          const previous = state.batches.find(
            (b) => b.windowId === input.windowId
          )
          const sameBatch =
            previous !== undefined && now - previous.lastAt < BATCH_GAP_MS
          const count = sameBatch ? previous.count + 1 : 1
          const receipt: PopupReceipt = {
            operationId: input.operationId,
            taskId: input.taskId,
            endpointId: input.endpointId,
            endpointRevision: input.endpointRevision,
            windowId: input.windowId,
            count,
            expiresAt: now + BATCH_GAP_MS,
          }
          state.batches = [
            ...state.batches.filter(
              (b) =>
                b.windowId !== input.windowId && now - b.lastAt < BATCH_GAP_MS
            ),
            { windowId: input.windowId, lastAt: now, count },
          ].slice(-20)
          state.seen = [...state.seen, input.operationId].slice(-100)
          state.receipt = receipt
          // Consume the batch before any UI call, including rejected calls.
          await this.deps.storage.set({ [STORAGE_KEY]: state })
          check()
          const focused = await this.deps.focusedWindow()
          check()
          const currentConfig = await this.deps.config()
          check()
          if (
            focused !== input.windowId ||
            !currentConfig.openTaskPanelAfterSubmit
          )
            return
          await this.deps.publish(receipt).catch(() => {})
          check()
          if (sameBatch || this.deps.isOpen(input.windowId)) return
          await this.deps.open(input.windowId)
        }),
        2000,
        'popup presentation'
      )
    } catch {
      /* An unavailable popup does not change the accepted download. */
    }
  }
}
