import { EventEmitter } from 'node:events'
import type {
  TaskCompletedParams,
  TaskErrorParams,
  TaskProgressParams,
} from '@motrix/mdxp'
import type {
  ClientIdentity,
  PairRequestExpiredPayload,
  PairRequestPayload,
  PairRequestSettledPayload,
} from '@shared/protocol/bridge'

/** Bus payload for a pending pair prompt. Same wire shape as the renderer-
 *  facing `PairRequestPayload`, aliased so the two never drift. */
export type PairRequestedPayload = PairRequestPayload

/** A client (extension OR cli) was paired. Keyed by {@link ClientIdentity} so
 *  a device-code (cli) approval can announce itself the same way an extension
 *  pairing does — the renderer paired-client list refreshes on this event. */
export interface PairedPayload {
  identity: ClientIdentity
}

export interface RevokedPayload {
  identity: ClientIdentity
}

export interface ErrorPayload {
  code: string
  message: string
}

export interface TaskProgressEvent {
  sessionKey: string
  params: TaskProgressParams
}

export interface TaskCompletedEvent {
  sessionKey: string
  params: TaskCompletedParams
}

export interface TaskErrorEvent {
  sessionKey: string
  params: TaskErrorParams
}

type BridgeEventMap = {
  PairRequested: [PairRequestedPayload]
  Paired: [PairedPayload]
  Revoked: [RevokedPayload]
  Error: [ErrorPayload]
  /** A pending pair request (cli or extension) reached a final decision. */
  PairRequestSettled: [PairRequestSettledPayload]
  /** A pending pair request lapsed past its TTL without a decision. */
  PairRequestExpired: [PairRequestExpiredPayload]
  TaskProgress: [TaskProgressEvent]
  TaskCompleted: [TaskCompletedEvent]
  TaskError: [TaskErrorEvent]
}

export class BridgeEventBus extends EventEmitter<BridgeEventMap> {
  emitPairRequested(p: PairRequestedPayload): void {
    this.emit('PairRequested', p)
  }

  emitPaired(p: PairedPayload): void {
    this.emit('Paired', p)
  }

  emitRevoked(p: RevokedPayload): void {
    this.emit('Revoked', p)
  }

  emitError(p: ErrorPayload): void {
    this.emit('Error', p)
  }

  emitPairRequestSettled(p: PairRequestSettledPayload): void {
    this.emit('PairRequestSettled', p)
  }

  emitPairRequestExpired(p: PairRequestExpiredPayload): void {
    this.emit('PairRequestExpired', p)
  }

  emitTaskProgress(e: TaskProgressEvent): void {
    this.emit('TaskProgress', e)
  }

  emitTaskCompleted(e: TaskCompletedEvent): void {
    this.emit('TaskCompleted', e)
  }

  emitTaskError(e: TaskErrorEvent): void {
    this.emit('TaskError', e)
  }
}
