import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialStore,
  type Principal,
} from '@/background/mbp1/credential-store'
import type { DiscoveryResult } from '@/background/mbp1/discovery-service'
import { FirstPairBackoff } from '@/background/mbp1/first-pair-backoff'
import {
  type FrameChannel,
  MBP1_PROTOCOL_VERSION,
} from '@/background/mbp1/frames'
import {
  PairingFlow,
  type PairingFlowError,
} from '@/background/mbp1/pairing-flow'
import { PinStore } from '@/background/mbp1/pin-store'

declare const browser: {
  storage: {
    local: {
      get: (k: string | string[]) => Promise<Record<string, unknown>>
      set: (items: Record<string, unknown>) => Promise<void>
      remove: (k: string | string[]) => Promise<void>
    }
  }
}

let backing: Record<string, unknown> = {}

beforeEach(() => {
  backing = {}
  browser.storage.local.get = vi.fn(async (k: string | string[]) => {
    const snapshot: Record<string, unknown> = {}
    for (const key of typeof k === 'string' ? [k] : k) {
      if (key in backing) snapshot[key] = backing[key]
    }
    return snapshot
  })
  browser.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    backing = { ...backing, ...items }
  })
  browser.storage.local.remove = vi.fn(async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) delete backing[key]
  })
})

const PRINCIPAL: Principal = {
  browser: 'chromium',
  verifiedOrigin: 'chrome-extension://test-extension-id',
  clientInstallationId: 'test-installation-id',
}

const DISCOVERY: DiscoveryResult = {
  transport: 'probe',
  wsPort: 16803,
  nonce: 'test-nonce',
}

const INSTANCE_ID = 'test-instance-id'

/**
 * A `FrameChannel` that plays just enough of the server side of `/pair` to
 * drive a real `PairingFlow` past `pakeA` — the point `state.reachedPakeA`
 * flips to `true` — and then hangs on the next receive, exactly as a peer
 * that stopped answering mid-session would look from this side. It never
 * computes a valid SPAKE2 share: the point of this fixture is what happens
 * when a run is abandoned before key confirmation, not confirmation itself
 * (that path is `pairing-flow.test.ts`'s job, against the real vectors).
 *
 * `paused` resolves the instant a receive genuinely starts hanging — not
 * merely once the frame that provokes it was sent — so a caller can await it
 * and know with certainty that the flow is blocked at that exact point
 * before doing anything else, with no race against the flow's own
 * continuation.
 */
class PausableChannel implements FrameChannel {
  readonly sentText: Record<string, unknown>[] = []
  closeCount = 0

  private pausePoint: string | null = null
  private closed = false
  private pendingRejects: Array<(err: Error) => void> = []
  private readonly textInbox: string[] = []
  private pausedResolve: (() => void) | null = null
  readonly paused: Promise<void> = new Promise((resolve) => {
    this.pausedResolve = resolve
  })

  /** The receive that would otherwise deliver `frameType` hangs instead. */
  pauseAfter(frameType: string): void {
    this.pausePoint = frameType
  }

  async open(): Promise<void> {}

  async sendText(frame: object): Promise<void> {
    const parsed = frame as Record<string, unknown>
    this.sentText.push(parsed)
    if (parsed.type === 'pairHello') {
      this.reply('pairAccept', {
        type: 'pairAccept',
        protocolVersion: MBP1_PROTOCOL_VERSION,
        instanceId: INSTANCE_ID,
      })
    } else if (parsed.type === 'pakeA') {
      // No valid pB to offer even if this weren't the pause point — see the
      // class doc. The suite always pauses here or earlier.
      this.reply('pakeB', null)
    }
  }

  private reply(
    frameType: string,
    frame: Record<string, unknown> | null
  ): void {
    if (this.pausePoint === frameType || frame === null) return
    this.textInbox.push(JSON.stringify(frame))
  }

  async receiveText(): Promise<string> {
    const next = this.textInbox.shift()
    if (next !== undefined) return next
    this.pausedResolve?.()
    return new Promise<string>((_resolve, reject) => {
      if (this.closed) {
        reject(new Error('channel closed'))
        return
      }
      this.pendingRejects.push(reject)
    })
  }

  async sendBinary(): Promise<void> {
    throw new Error('PausableChannel: sendBinary should not be reached')
  }

  async receiveBinary(): Promise<Uint8Array> {
    throw new Error('PausableChannel: receiveBinary should not be reached')
  }

  close(): void {
    this.closeCount += 1
    if (this.closed) return
    this.closed = true
    for (const reject of this.pendingRejects.splice(0)) {
      reject(new Error('channel closed'))
    }
  }
}

function makeFlow(channel: FrameChannel): {
  flow: PairingFlow
  creds: CredentialStore
} {
  const creds = new CredentialStore()
  const flow = new PairingFlow({
    channel,
    creds,
    pins: new PinStore(),
    backoff: new FirstPairBackoff(),
    isCurrent: () => true,
  })
  return { flow, creds }
}

/**
 * `p` rejecting is exactly what a correctly-working `abort()` produces, but a
 * broken one leaves `p` pending forever — and awaiting a promise that never
 * settles fails only via vitest's own default test timeout (5000ms), which
 * reads as an infrastructure flake ("pass a timeout value…") rather than as
 * evidence against the one behavior this test exists to pin. Racing against a
 * short, local timer turns that same failure into an immediate, unambiguous
 * "still pending" a fraction of a second in — nowhere near vitest's own
 * timeout — so a regression here can never be mistaken for flakiness.
 */
const RACE_TIMEOUT_MS = 200

function raceOrStillPending<T>(p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `expected rejection within ${RACE_TIMEOUT_MS}ms, still pending`
        )
      )
    }, RACE_TIMEOUT_MS)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      }
    )
  })
}

describe('PairingFlow.abort()', () => {
  it('a mid-pairing abort discards the run and persists no credential', async () => {
    const channel = new PausableChannel()
    const { flow, creds } = makeFlow(channel)
    channel.pauseAfter('pakeB')

    const p = flow.run({
      code: 'MTX7K2Q9',
      discovery: DISCOVERY,
      principal: PRINCIPAL,
      claimedExtensionId: 'test-extension-id',
    })

    // Wait for the run to be genuinely blocked waiting on pakeB — not just
    // for pakeA to have been sent — so abort() below is racing nothing.
    await channel.paused
    expect(channel.sentText.some((f) => f.type === 'pakeA')).toBe(true)

    flow.abort()

    await expect(raceOrStillPending(p)).rejects.toMatchObject({
      name: 'PairingFlowError',
      reason: 'aborted',
    } satisfies Partial<PairingFlowError>)

    expect(await creds.recoverOrder(PRINCIPAL)).toHaveLength(0)
    // abort() closes the channel itself (to unblock the pending receive),
    // and run()'s own catch path closes it again on every failure — both are
    // expected and close() is idempotent, but at least the first is what
    // actually has to happen for the receive to unblock at all.
    expect(channel.closeCount).toBeGreaterThanOrEqual(1)
  })
})
