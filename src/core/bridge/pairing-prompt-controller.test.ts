import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { PairDialogRequest } from './mbp1/pair-session'
import {
  PairingPromptController,
  type PairingPromptControllerOptions,
  type PairingPromptEnqueueResult,
  type PairingPromptSnapshot,
  type PairingPromptTerminalEvent,
  PairingPromptTerminalOutcomes,
  type PairingPromptTimeSource,
} from './pairing-prompt-controller'

const REQUEST: PairDialogRequest = {
  browser: 'chromium',
  claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  identity: 'official',
  code: '1234-5678',
  pairingNonce: 'nonce-1',
  verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}
const DELIVERED = 'delivered' as const

class FakeTimeSource implements PairingPromptTimeSource {
  private current = 1_000
  private nextId = 1
  private readonly timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >()

  now = (): number => this.current

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at: this.current + delayMs, callback })
    let cancelled = false
    return () => {
      if (cancelled) return
      cancelled = true
      this.timers.delete(id)
    }
  }

  advance(ms: number): void {
    this.current += ms
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (due === undefined) return
      this.timers.delete(due[0])
      due[1].callback()
    }
  }

  pendingTimers(): number {
    return this.timers.size
  }
}

function accepted(result: PairingPromptEnqueueResult) {
  if (!result.ok)
    throw new Error(`expected accepted prompt, got ${result.reason}`)
  return result.handle
}

function request(
  overrides: Partial<PairDialogRequest> = {}
): PairDialogRequest {
  return { ...REQUEST, ...overrides }
}

function makeController(overrides: PairingPromptControllerOptions = {}): {
  controller: PairingPromptController
  time: FakeTimeSource
} {
  const time = new FakeTimeSource()
  return {
    controller: new PairingPromptController({
      timeSource: time,
      ...overrides,
    }),
    time,
  }
}

describe('PairingPromptController contract', () => {
  it('freezes the complete typed terminal vocabulary', () => {
    expect(PairingPromptTerminalOutcomes).toEqual({
      Paired: 'paired',
      Denied: 'denied',
      Expired: 'expired',
      Aborted: 'aborted',
    })
    expect(Object.isFrozen(PairingPromptTerminalOutcomes)).toBe(true)
  })

  it('restricts a PairSession handle to paired or aborted outcomes', () => {
    const { controller } = makeController()
    const handle = accepted(controller.enqueue(REQUEST))

    expectTypeOf(handle.settle)
      .parameter(0)
      .toEqualTypeOf<'paired' | 'aborted'>()
    expectTypeOf(controller.deny).parameter(0).toEqualTypeOf<string>()
    expectTypeOf<
      ReturnType<NonNullable<PairingPromptControllerOptions['onEnqueued']>>
    >().toEqualTypeOf<'delivered' | 'failed'>()
    expectTypeOf<
      ReturnType<NonNullable<PairingPromptControllerOptions['onTerminal']>>
    >().toEqualTypeOf<'delivered' | 'failed'>()
  })

  it.each([
    [{ ttlMs: 0 }, 'ttl'],
    [{ ttlMs: 1.5 }, 'ttl'],
    [{ ttlMs: Number.POSITIVE_INFINITY }, 'ttl'],
    [{ maxPending: 0 }, 'cap'],
    [{ maxPending: 1.5 }, 'cap'],
  ] as const)('rejects invalid programmer option %s', (options, _label) => {
    expect(() => new PairingPromptController(options)).toThrow()
  })
})

describe('PairingPromptController.enqueue and snapshot', () => {
  it('publishes one frozen in-memory snapshot with verified identity', async () => {
    const published = vi.fn((_prompt: PairingPromptSnapshot) => DELIVERED)
    const { controller } = makeController({ onEnqueued: published })
    const handle = accepted(
      controller.enqueue(
        request({ verifiedOrigin: `${REQUEST.verifiedOrigin}/` })
      )
    )

    expect(await handle.published).toBe('delivered')
    expect(published).toHaveBeenCalledTimes(1)
    const prompt = published.mock.calls[0]?.[0]
    expect(prompt).toEqual({
      promptId: handle.promptId,
      verifiedIdentity: {
        browser: 'chromium',
        verifiedOrigin: REQUEST.verifiedOrigin,
        originHost: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      claimedExtensionId: REQUEST.claimedExtensionId,
      identity: 'official',
      pairingNonce: 'nonce-1',
      code: '1234-5678',
      createdAt: 1_000,
      expiresAt: 121_000,
    })
    expect(Object.isFrozen(prompt)).toBe(true)
    expect(Object.isFrozen(prompt?.verifiedIdentity)).toBe(true)
  })

  it('returns an immutable snapshot that tracks live prompts only', async () => {
    const { controller } = makeController()
    const first = accepted(controller.enqueue(REQUEST))
    const second = accepted(
      controller.enqueue(
        request({
          pairingNonce: 'nonce-2',
          claimedExtensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          verifiedOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        })
      )
    )

    const snapshot = controller.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.map((item) => item.promptId)).toEqual([
      first.promptId,
      second.promptId,
    ])

    controller.deny(first.promptId)
    expect(controller.snapshot().map((item) => item.promptId)).toEqual([
      second.promptId,
    ])
  })

  it.each([
    ['empty', ''],
    ['wrong scheme', 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['missing host', 'chrome-extension:///'],
    ['userinfo', 'chrome-extension://user@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['path', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/path'],
    ['query', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1'],
    ['fragment', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#x'],
    ['whitespace', ` ${REQUEST.verifiedOrigin}`],
    ['port', `${REQUEST.verifiedOrigin}:1234`],
    ['backslash', `${REQUEST.verifiedOrigin}\\alias`],
    ['percent alias', `${REQUEST.verifiedOrigin}%2falias`],
    ['non-ASCII host', 'chrome-extension://\u00eddentity'],
  ])('rejects an invalid verified Origin (%s)', (_label, verifiedOrigin) => {
    const { controller } = makeController()

    expect(controller.enqueue(request({ verifiedOrigin }))).toEqual({
      ok: false,
      reason: 'invalid-origin',
    })
    expect(controller.snapshot()).toEqual([])
  })

  it('deduplicates by verified browser+Origin, never claimed id', async () => {
    const published = vi.fn(() => DELIVERED)
    const { controller } = makeController({ onEnqueued: published })
    const first = accepted(controller.enqueue(REQUEST))
    await first.published

    const duplicate = controller.enqueue(
      request({
        pairingNonce: 'nonce-attacker',
        claimedExtensionId: 'attacker-self-report',
      })
    )

    expect(duplicate).toEqual({ ok: false, reason: 'duplicate' })
    expect(controller.snapshot()).toHaveLength(1)
    expect(published).toHaveBeenCalledTimes(1)
  })

  it('does not let the same claimed id suppress a different verified Origin', () => {
    const { controller } = makeController()
    accepted(
      controller.enqueue(
        request({
          browser: 'firefox',
          verifiedOrigin:
            'moz-extension://11111111-1111-1111-1111-111111111111',
        })
      )
    )

    const other = controller.enqueue(
      request({
        browser: 'firefox',
        pairingNonce: 'nonce-2',
        verifiedOrigin: 'moz-extension://22222222-2222-2222-2222-222222222222',
      })
    )

    expect(other.ok).toBe(true)
    expect(controller.snapshot()).toHaveLength(2)
  })

  it('enforces a global cap and frees the slot synchronously on settle', async () => {
    const { controller } = makeController({ maxPending: 1 })
    const first = accepted(controller.enqueue(REQUEST))
    const otherRequest = request({
      pairingNonce: 'nonce-2',
      claimedExtensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      verifiedOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })

    expect(controller.enqueue(otherRequest)).toEqual({
      ok: false,
      reason: 'capacity',
    })
    const settling = first.settle('paired')
    expect(controller.enqueue(otherRequest).ok).toBe(true)
    expect(settling).toEqual({ ok: true, outcome: 'paired' })
  })

  it.each([
    [
      'throw',
      {
        now: (): number => 0,
        schedule: () => {
          throw new Error('timer unavailable')
        },
      },
    ],
    [
      'fire synchronously',
      {
        now: (): number => 0,
        schedule: (callback: () => void) => {
          callback()
          return () => {}
        },
      },
    ],
  ] as const)(
    'fails closed when the timer scheduler would %s',
    (_label, timeSource) => {
      const controller = new PairingPromptController({ timeSource })

      expect(controller.enqueue(REQUEST)).toEqual({
        ok: false,
        reason: 'scheduling-failed',
      })
      expect(controller.snapshot()).toEqual([])
    }
  )

  it('keeps the PAKE code out of ids, handles, and non-snapshot JSON', async () => {
    const terminalEvents: unknown[] = []
    const { controller } = makeController({
      onTerminal: (event) => {
        terminalEvents.push(event)
        return DELIVERED
      },
    })
    const handle = accepted(controller.enqueue(REQUEST))

    expect(handle.promptId).not.toContain(REQUEST.code)
    expect(handle.promptId).not.toContain(REQUEST.pairingNonce)
    expect(handle.promptId).not.toContain(REQUEST.verifiedOrigin)
    expect(JSON.stringify(handle)).not.toContain(REQUEST.code)
    controller.deny(handle.promptId)
    expect(JSON.stringify(terminalEvents)).not.toContain(REQUEST.code)
    expect(JSON.stringify(controller.callbackFailureSnapshot())).not.toContain(
      REQUEST.code
    )
  })
})

describe('PairingPromptController TTL', () => {
  it('expires exactly at the injected deadline and emits once', async () => {
    const terminal = vi.fn((_event: PairingPromptTerminalEvent) => DELIVERED)
    const { controller, time } = makeController({
      ttlMs: 10_000,
      onTerminal: terminal,
    })
    const handle = accepted(controller.enqueue(REQUEST))
    let outcome: string | undefined
    void handle.terminal.then((value) => {
      outcome = value
    })

    time.advance(9_999)
    await Promise.resolve()
    expect(outcome).toBeUndefined()
    expect(controller.snapshot()).toHaveLength(1)

    time.advance(1)
    expect(await handle.terminal).toBe('expired')
    await Promise.resolve()
    expect(controller.snapshot()).toEqual([])
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'expired' })
    )
  })

  it('lazily expires a prompt when the injected scheduler is delayed', async () => {
    let now = 50
    const delayedTime: PairingPromptTimeSource = {
      now: () => now,
      schedule: () => () => {},
    }
    const controller = new PairingPromptController({
      ttlMs: 100,
      timeSource: delayedTime,
    })
    const handle = accepted(controller.enqueue(REQUEST))

    now = 150
    expect(controller.snapshot()).toEqual([])
    expect(await handle.terminal).toBe('expired')
  })

  it('lets expiry win over an explicit decision at the deadline', async () => {
    let now = 0
    const delayedTime: PairingPromptTimeSource = {
      now: () => now,
      schedule: () => () => {},
    }
    const controller = new PairingPromptController({
      ttlMs: 100,
      timeSource: delayedTime,
    })
    const handle = accepted(controller.enqueue(REQUEST))

    now = 100
    expect(controller.deny(handle.promptId)).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    await expect(handle.terminal).resolves.toBe('expired')
  })

  it('cancels the TTL after explicit settle so it cannot emit twice', async () => {
    const terminal = vi.fn(() => DELIVERED)
    const { controller, time } = makeController({
      ttlMs: 100,
      onTerminal: terminal,
    })
    const handle = accepted(controller.enqueue(REQUEST))

    expect(handle.settle('paired')).toEqual({
      ok: true,
      outcome: 'paired',
    })
    expect(time.pendingTimers()).toBe(0)
    time.advance(1_000)
    await Promise.resolve()

    expect(terminal).toHaveBeenCalledTimes(1)
    await expect(handle.terminal).resolves.toBe('paired')
  })
})

describe('PairingPromptController settle', () => {
  it.each(['paired', 'aborted'] as const)(
    'lets the PairSession handle settle %s exactly once',
    async (outcome) => {
      const { controller } = makeController()
      const handle = accepted(controller.enqueue(REQUEST))

      expect(handle.settle(outcome)).toEqual({ ok: true, outcome })
      await expect(handle.terminal).resolves.toBe(outcome)
      expect(controller.snapshot()).toEqual([])
    }
  )

  it('gives the operator a deny-only terminal transition', async () => {
    const { controller } = makeController()
    const handle = accepted(controller.enqueue(REQUEST))

    expect(controller.deny(handle.promptId)).toEqual({
      ok: true,
      outcome: 'denied',
    })
    await expect(handle.terminal).resolves.toBe('denied')
  })

  it('returns unavailable and invokes no callback on duplicate settle', async () => {
    const terminal = vi.fn(() => DELIVERED)
    const { controller } = makeController({ onTerminal: terminal })
    const handle = accepted(controller.enqueue(REQUEST))

    expect(controller.deny(handle.promptId)).toEqual({
      ok: true,
      outcome: 'denied',
    })
    expect(handle.settle('paired')).toEqual({
      ok: false,
      reason: 'unavailable',
    })

    await Promise.resolve()
    expect(terminal).toHaveBeenCalledTimes(1)
    await expect(handle.terminal).resolves.toBe('denied')
  })

  it('re-admits the verified identity after any terminal outcome', async () => {
    const { controller } = makeController()
    const first = accepted(controller.enqueue(REQUEST))

    controller.deny(first.promptId)
    expect(controller.enqueue(request({ pairingNonce: 'nonce-2' })).ok).toBe(
      true
    )
  })

  it('publishes a frozen code-free terminal event', async () => {
    const terminal = vi.fn((_event: PairingPromptTerminalEvent) => DELIVERED)
    const { controller } = makeController({ onTerminal: terminal })
    const handle = accepted(controller.enqueue(REQUEST))

    controller.deny(handle.promptId)
    await Promise.resolve()
    const event = terminal.mock.calls[0]?.[0]
    expect(event).toEqual({
      promptId: handle.promptId,
      verifiedIdentity: {
        browser: 'chromium',
        verifiedOrigin: REQUEST.verifiedOrigin,
        originHost: REQUEST.claimedExtensionId,
      },
      outcome: 'denied',
    })
    expect(Object.isFrozen(event)).toBe(true)
    expect(event).not.toHaveProperty('code')
    expect(event).not.toHaveProperty('pairingNonce')
  })

  it('removes state before synchronously publishing the terminal callback', async () => {
    let duplicate: ReturnType<PairingPromptController['deny']> | undefined
    let controller!: PairingPromptController
    const terminal = vi.fn((event: { promptId: string }) => {
      duplicate = controller.deny(event.promptId)
      return DELIVERED
    })
    controller = makeController({ onTerminal: terminal }).controller
    const handle = accepted(controller.enqueue(REQUEST))

    const first = handle.settle('paired')
    expect(duplicate).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    await expect(handle.terminal).resolves.toBe('paired')
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(first).toEqual({ ok: true, outcome: 'paired' })
  })
})

describe('PairingPromptController callback failures', () => {
  it.each([
    [
      'throw',
      () => {
        throw new Error('secret callback detail')
      },
    ],
    ['reject', () => Promise.reject(new Error('secret callback detail'))],
  ] as const)(
    'observes an enqueue callback %s without dropping the prompt',
    async (_label, onEnqueued) => {
      const observed = vi.fn()
      const { controller } = makeController({
        onEnqueued: onEnqueued as unknown as NonNullable<
          PairingPromptControllerOptions['onEnqueued']
        >,
        onCallbackFailure: observed,
      })
      const handle = accepted(controller.enqueue(REQUEST))

      await expect(handle.published).resolves.toBe('failed')
      expect(controller.snapshot()).toHaveLength(1)
      expect(controller.callbackFailureSnapshot()).toEqual([
        { phase: 'enqueue' },
      ])
      expect(observed).toHaveBeenCalledExactlyOnceWith({ phase: 'enqueue' })
      expect(
        JSON.stringify(controller.callbackFailureSnapshot())
      ).not.toContain('secret callback detail')
    }
  )

  it('fails an invalid never-settling enqueue callback without hanging PairSession', async () => {
    const never = new Promise<void>(() => {})
    const { controller } = makeController({
      onEnqueued: (() => never) as unknown as NonNullable<
        PairingPromptControllerOptions['onEnqueued']
      >,
    })
    const handle = accepted(controller.enqueue(REQUEST))

    await expect(handle.published).resolves.toBe('failed')
    expect(handle.settle('aborted')).toEqual({
      ok: true,
      outcome: 'aborted',
    })
    await expect(controller.dispose()).resolves.toBeUndefined()
    expect(controller.callbackFailureSnapshot()).toEqual([{ phase: 'enqueue' }])
  })

  it.each(['resolve', 'reject'] as const)(
    'does not revise terminal lifecycle when an invalid thenable %ss late',
    async (completion) => {
      let resolve!: () => void
      let reject!: (reason: Error) => void
      const returned = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
      })
      const { controller } = makeController({
        onEnqueued: (() => returned) as unknown as NonNullable<
          PairingPromptControllerOptions['onEnqueued']
        >,
      })
      const handle = accepted(controller.enqueue(REQUEST))

      await expect(handle.published).resolves.toBe('failed')
      expect(handle.settle('aborted')).toEqual({
        ok: true,
        outcome: 'aborted',
      })
      if (completion === 'resolve') {
        resolve()
      } else {
        reject(new Error('late adapter contract violation'))
      }
      await Promise.resolve()

      await expect(handle.terminal).resolves.toBe('aborted')
      expect(handle.settle('paired')).toEqual({
        ok: false,
        reason: 'unavailable',
      })
      expect(controller.callbackFailureSnapshot()).toEqual([
        { phase: 'enqueue' },
      ])
    }
  )

  it.each([
    [
      'throw',
      () => {
        throw new Error('secret callback detail')
      },
    ],
    ['reject', () => Promise.reject(new Error('secret callback detail'))],
  ] as const)(
    'observes a terminal callback %s and never settles twice',
    async (_label, onTerminal) => {
      const observed = vi.fn()
      const { controller } = makeController({
        onTerminal: onTerminal as unknown as NonNullable<
          PairingPromptControllerOptions['onTerminal']
        >,
        onCallbackFailure: observed,
      })
      const handle = accepted(controller.enqueue(REQUEST))

      expect(controller.deny(handle.promptId)).toEqual({
        ok: true,
        outcome: 'denied',
      })
      expect(handle.settle('paired')).toEqual({
        ok: false,
        reason: 'unavailable',
      })
      await expect(handle.terminal).resolves.toBe('denied')
      await controller.dispose()
      expect(controller.callbackFailureSnapshot()).toEqual([
        { phase: 'terminal', outcome: 'denied' },
      ])
      expect(observed).toHaveBeenCalledTimes(1)
    }
  )

  it('retains failure observability when the failure observer also breaks', async () => {
    const { controller } = makeController({
      onTerminal: () => {
        throw new Error('terminal failure')
      },
      onCallbackFailure: () => {
        throw new Error('observer failure')
      },
    })
    const handle = accepted(controller.enqueue(REQUEST))

    handle.settle('aborted')
    await controller.dispose()
    expect(controller.callbackFailureSnapshot()).toEqual([
      { phase: 'terminal', outcome: 'aborted' },
    ])
  })
})

describe('PairingPromptController.dispose', () => {
  it('commits code publication synchronously before enqueue returns', async () => {
    const published = vi.fn(() => DELIVERED)
    const { controller } = makeController({ onEnqueued: published })
    const handle = accepted(controller.enqueue(REQUEST))

    expect(published).toHaveBeenCalledTimes(1)
    await controller.dispose()

    await expect(handle.published).resolves.toBe('delivered')
    await expect(handle.terminal).resolves.toBe('aborted')
    expect(published).toHaveBeenCalledTimes(1)
    expect(controller.callbackFailureSnapshot()).toEqual([])
  })

  it('aborts every pending prompt, cancels timers, and is idempotent', async () => {
    const terminal = vi.fn(() => DELIVERED)
    const { controller, time } = makeController({ onTerminal: terminal })
    const first = accepted(controller.enqueue(REQUEST))
    const second = accepted(
      controller.enqueue(
        request({
          pairingNonce: 'nonce-2',
          claimedExtensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          verifiedOrigin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        })
      )
    )

    const disposing = controller.dispose()
    expect(controller.dispose()).toBe(disposing)
    expect(controller.snapshot()).toEqual([])
    expect(time.pendingTimers()).toBe(0)
    await disposing

    await expect(first.terminal).resolves.toBe('aborted')
    await expect(second.terminal).resolves.toBe('aborted')
    expect(terminal).toHaveBeenCalledTimes(2)
  })

  it('rejects future enqueue after disposal', async () => {
    const { controller } = makeController()
    await controller.dispose()

    expect(controller.enqueue(REQUEST)).toEqual({
      ok: false,
      reason: 'disposed',
    })
  })

  it('fails an invalid never-settling terminal callback without blocking disposal', async () => {
    const never = new Promise<void>(() => {})
    const { controller } = makeController({
      onTerminal: (() => never) as unknown as NonNullable<
        PairingPromptControllerOptions['onTerminal']
      >,
    })
    accepted(controller.enqueue(REQUEST))

    await expect(controller.dispose()).resolves.toBeUndefined()
    expect(controller.callbackFailureSnapshot()).toEqual([
      { phase: 'terminal', outcome: 'aborted' },
    ])
  })
})
