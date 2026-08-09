import type { EventChannel } from '@shared/protocol/events'

type Listener = (...args: unknown[]) => void

export interface EventBusOptions {
  /** Called for each listener that throws; dispatch continues. */
  onListenerError?: (channel: string, err: unknown) => void
}

export class EventBus {
  private listeners = new Map<string, Set<Listener>>()

  constructor(private readonly options?: EventBusOptions) {}

  on(channel: EventChannel, listener: Listener): void {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set())
    }
    this.listeners.get(channel)?.add(listener)
  }

  off(channel: EventChannel, listener: Listener): void {
    this.listeners.get(channel)?.delete(listener)
  }

  emit(channel: EventChannel, ...args: unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      try {
        listener(...args)
      } catch (err) {
        this.options?.onListenerError?.(channel, err)
      }
    }
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
