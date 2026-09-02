import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { AppError, ErrorCode } from '@shared/errors'

export interface PluginCallChain {
  id: string
  plugins: ReadonlyArray<string>
}

export interface PluginLaneEntryOptions {
  callChain?: PluginCallChain
  signal?: AbortSignal
}

export interface PluginLaneState {
  accepting: boolean
  queued: number
  running: number
}

const callChainStorage = new AsyncLocalStorage<PluginCallChain>()

export function currentPluginCallChain(): PluginCallChain | undefined {
  return callChainStorage.getStore()
}

/** One FIFO admission lane for every host-initiated entry into one plugin VM. */
export class PluginLane {
  private tail: Promise<void> = Promise.resolve()
  private queued = 0
  private running = 0
  private accepting = true
  private epoch = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(readonly pluginId: string) {}

  run<T>(
    operation: (chain: PluginCallChain) => Promise<T> | T,
    options: PluginLaneEntryOptions = {}
  ): Promise<T> {
    if (!this.accepting) return Promise.reject(laneClosedError(this.pluginId))

    const inherited = options.callChain ?? currentPluginCallChain()
    if (inherited?.plugins.includes(this.pluginId)) {
      return Promise.reject(
        new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.runtime.reentrant_call'
        )
      )
    }
    const chain: PluginCallChain = {
      id: inherited?.id ?? randomUUID(),
      plugins: [...(inherited?.plugins ?? []), this.pluginId],
    }
    const admittedEpoch = this.epoch
    this.queued += 1

    const result = this.tail.then(async () => {
      this.queued -= 1
      if (admittedEpoch !== this.epoch) {
        this.notifyDrained()
        throw laneClosedError(this.pluginId)
      }
      if (options.signal?.aborted) {
        this.notifyDrained()
        throw new AppError(
          ErrorCode.PluginRuntimeFault,
          'plugin.runtime.entry_aborted'
        )
      }

      this.running += 1
      try {
        return await callChainStorage.run(chain, () => operation(chain))
      } finally {
        this.running -= 1
        this.notifyDrained()
      }
    })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  close(): void {
    this.accepting = false
  }

  reopen(): void {
    this.accepting = true
  }

  cancelQueued(): void {
    this.epoch += 1
  }

  state(): PluginLaneState {
    return {
      accepting: this.accepting,
      queued: this.queued,
      running: this.running,
    }
  }

  isDrained(): boolean {
    return this.queued === 0 && this.running === 0
  }

  drain(): Promise<void> {
    if (this.isDrained()) return Promise.resolve()
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve))
  }

  async drainWithin(timeoutMs: number): Promise<boolean> {
    if (this.isDrained()) return true
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.drain().then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private notifyDrained(): void {
    if (!this.isDrained()) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }
}

function laneClosedError(pluginId: string): AppError {
  return new AppError(
    ErrorCode.PluginRuntimeFault,
    `plugin.runtime.admission_closed: ${pluginId}`
  )
}
