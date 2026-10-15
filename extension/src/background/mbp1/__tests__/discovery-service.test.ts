import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DiscoveryService,
  type DiscoveryServiceOptions,
  type NativeBootstrapReply,
  type PinReader,
} from '@/background/mbp1/discovery-service'
import type { Pin } from '@/background/mbp1/pin-store'

/** Every `/discovery` and `/nonce` request the service made, in order. */
let requests: Array<{ url: string; init: RequestInit }> = []

beforeEach(() => {
  requests = []
})

afterEach(() => {
  vi.useRealTimers()
})

function record(url: string, init: RequestInit | undefined): void {
  requests.push({ url, init: init ?? {} })
}

function liveBody(
  instanceId: string,
  extra: Record<string, unknown> = {}
): Response {
  return new Response(
    JSON.stringify({
      app: 'motrix-bridge',
      apiVersion: 1,
      instanceId,
      appVersion: '2.0.0',
      runtime: 'electron',
      extensionPairing: { protocol: 'mbp1', versions: [1] },
      applicationProtocols: { mdxp: ['1.0'] },
      ...extra,
    })
  )
}

function rawBody(body: unknown): Response {
  return new Response(JSON.stringify(body))
}

function deadBody(): Response {
  return new Response('', { status: 500 })
}

function portOf(url: string): number {
  return Number(new URL(url).port)
}

/** A fetch that answers `/discovery` per port and rejects everything else. */
function discoveryFetch(
  answer: (port: number) => Response | Promise<Response>
): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    record(url, init)
    if (!url.endsWith('/discovery')) {
      throw new Error(`unexpected request: ${url}`)
    }
    return answer(portOf(url))
  }) as unknown as typeof fetch
}

/**
 * A fetch that never answers and only rejects when its `AbortSignal` fires --
 * the only way to observe which timeout the caller actually passed.
 */
function abortableFetch(): typeof fetch {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    record(String(input), init)
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  }) as unknown as typeof fetch
}

function pinReader(pin: Pin | null): PinReader & {
  commit: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  return {
    get: vi.fn(async () => pin),
    // Present only so the tests can prove discovery never reaches for them.
    commit: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  }
}

function make(
  options: Partial<DiscoveryServiceOptions> = {}
): DiscoveryService {
  return new DiscoveryService({
    pins: pinReader(null),
    ...options,
  } as DiscoveryServiceOptions)
}

function bootstrapPort(reply: NativeBootstrapReply | Error): {
  bootstrap: ReturnType<typeof vi.fn>
} {
  return {
    bootstrap: vi.fn(async () => {
      if (reply instanceof Error) throw reply
      return reply
    }),
  }
}

function fakeTabs(
  overrides: Record<string, unknown> = {}
): Record<string, ReturnType<typeof vi.fn>> {
  return {
    create: vi.fn(async () => ({ id: 7 })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>
}

describe('DiscoveryService', () => {
  describe('tryPinnedPort', () => {
    it('returns a probe result on instanceId match', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.tryPinnedPort('c1')).toEqual({
        transport: 'probe',
        wsPort: 16803,
        instanceId: 'inst-x',
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('http://127.0.0.1:16803/discovery')
    })

    it('probes only the pinned port, not the candidate range', async () => {
      const d = make({
        pins: pinReader({ port: 16805, instanceId: 'inst-x' }),
        candidatePorts: [16802, 16803, 16804, 16805, 16806],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      await d.tryPinnedPort('c1')
      expect(requests.map((r) => portOf(r.url))).toEqual([16805])
    })

    it('returns null with no pin, and issues no request at all', async () => {
      const d = make({
        pins: pinReader(null),
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
      expect(requests).toHaveLength(0)
    })

    it('returns null when the responder reports a different instanceId', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(() => liveBody('someone-else')),
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
    })

    it('returns null on a non-2xx status that still carries a valid body', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(
          () =>
            new Response(
              JSON.stringify({
                app: 'motrix-bridge',
                apiVersion: 1,
                instanceId: 'inst-x',
                appVersion: '2.0.0',
              }),
              { status: 503 }
            )
        ),
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
    })

    it('returns null on a dead port', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
    })

    it('returns null when the connection is refused', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl,
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
    })

    it('rejects a non-Motrix service squatting the pinned port', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(() =>
          rawBody({
            app: 'something-else',
            apiVersion: 1,
            instanceId: 'inst-x',
            appVersion: '2.0.0',
          })
        ),
      })
      expect(await d.tryPinnedPort('c1')).toBeNull()
    })

    it('never writes to the pin store, on match or on mismatch', async () => {
      const matching = pinReader({ port: 16803, instanceId: 'inst-x' })
      await make({
        pins: matching,
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      }).tryPinnedPort('c1')
      const mismatching = pinReader({ port: 16803, instanceId: 'inst-x' })
      await make({
        pins: mismatching,
        fetchImpl: discoveryFetch(() => liveBody('other')),
      }).tryPinnedPort('c1')
      for (const pins of [matching, mismatching]) {
        expect(pins.commit).not.toHaveBeenCalled()
        expect(pins.clear).not.toHaveBeenCalled()
      }
    })

    it('sends the §4.1 liveness probe, not a §4.2 nonce fetch', async () => {
      const d = make({
        pins: pinReader({ port: 16803, instanceId: 'inst-x' }),
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      await d.tryPinnedPort('c1')
      const init = requests[0]?.init
      expect(init?.method).toBeUndefined()
      expect(init?.headers).toBeUndefined()
      expect(init?.cache).toBe('no-store')
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    })
  })

  describe('sweepCandidates', () => {
    it('enumerates all live candidates for first pair', async () => {
      let call = 0
      const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
        record(String(input), init)
        call += 1
        return call <= 2
          ? new Response(
              JSON.stringify({
                app: 'motrix-bridge',
                apiVersion: 1,
                instanceId: `i${call}`,
                appVersion: '2.0',
              })
            )
          : new Response('', { status: 500 })
      }) as unknown as typeof fetch
      const d = make({ candidatePorts: [16802, 16803, 16804], fetchImpl })
      const live = await d.sweepCandidates()
      expect(live).toHaveLength(2)
    })

    it('probes every candidate port exactly once', async () => {
      const d = make({
        candidatePorts: [16802, 16803, 16804, 16805, 16806],
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      await d.sweepCandidates()
      expect(requests.map((r) => portOf(r.url))).toEqual([
        16802, 16803, 16804, 16805, 16806,
      ])
    })

    it('keeps candidate-port order regardless of completion order', async () => {
      const delays: Record<number, number> = {
        16802: 24,
        16803: 12,
        16804: 1,
      }
      const d = make({
        candidatePorts: [16802, 16803, 16804],
        fetchImpl: discoveryFetch(async (port) => {
          await new Promise((resolve) => setTimeout(resolve, delays[port] ?? 0))
          return liveBody(`i-${port}`)
        }),
      })
      const live = await d.sweepCandidates()
      expect(live.map((c) => c.port)).toEqual([16802, 16803, 16804])
    })

    it('issues no request when the configured probe timeout is non-positive', async () => {
      const d = make({
        candidatePorts: [16802, 16803],
        discoveryTimeoutMs: 0,
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.sweepCandidates()).toEqual([])
      expect(requests).toHaveLength(0)
    })

    it('returns an empty list when nothing is listening', async () => {
      const d = make({
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      expect(await d.sweepCandidates()).toEqual([])
    })

    it('skips a port whose body is not JSON', async () => {
      const d = make({
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch((port) =>
          port === 16802 ? new Response('<html>') : liveBody('i-2')
        ),
      })
      const live = await d.sweepCandidates()
      expect(live.map((c) => c.port)).toEqual([16803])
    })

    const rejected: Array<[string, Record<string, unknown>]> = [
      [
        'a missing instanceId',
        { app: 'motrix-bridge', apiVersion: 1, appVersion: '2.0.0' },
      ],
      [
        'an empty instanceId',
        {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: '',
          appVersion: '2.0.0',
        },
      ],
      [
        'an over-long instanceId',
        {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 'a'.repeat(129),
          appVersion: '2.0.0',
        },
      ],
      [
        'a non-string instanceId',
        {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 7,
          appVersion: '2.0.0',
        },
      ],
      [
        'a missing apiVersion',
        { app: 'motrix-bridge', instanceId: 'i-1', appVersion: '2.0.0' },
      ],
      [
        'a stringified apiVersion',
        {
          app: 'motrix-bridge',
          apiVersion: '1',
          instanceId: 'i-1',
          appVersion: '2.0.0',
        },
      ],
      [
        'a wrong app name',
        {
          app: 'motrix',
          apiVersion: 1,
          instanceId: 'i-1',
          appVersion: '2.0.0',
        },
      ],
    ]

    for (const [label, body] of rejected) {
      it(`skips a responder with ${label}`, async () => {
        const d = make({
          candidatePorts: [16802],
          fetchImpl: discoveryFetch(() => rawBody(body)),
        })
        expect(await d.sweepCandidates()).toEqual([])
      })
    }

    it('accepts a document with no appVersion (display data only)', async () => {
      const d = make({
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() =>
          rawBody({ app: 'motrix-bridge', apiVersion: 1, instanceId: 'i-1' })
        ),
      })
      expect(await d.sweepCandidates()).toEqual([
        {
          port: 16802,
          instanceId: 'i-1',
          appVersion: '',
          compatibility: 'backendUpgradeRequired',
        },
      ])
    })

    it('accepts a newer apiVersion rather than hiding a newer Motrix', async () => {
      const d = make({
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() =>
          rawBody({
            app: 'motrix-bridge',
            apiVersion: 2,
            instanceId: 'i-1',
            appVersion: '3.0.0',
          })
        ),
      })
      expect(await d.sweepCandidates()).toEqual([
        {
          port: 16802,
          instanceId: 'i-1',
          appVersion: '3.0.0',
          compatibility: 'backendUpgradeRequired',
        },
      ])
    })

    it('marks an explicit higher-only protocol set as requiring a newer extension', async () => {
      const d = make({
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() =>
          liveBody('i-1', {
            extensionPairing: { protocol: 'mbp1', versions: [2] },
            applicationProtocols: { mdxp: ['2.0'] },
          })
        ),
      })

      expect((await d.sweepCandidates())[0]?.compatibility).toBe(
        'extensionUpgradeRequired'
      )
    })

    it('marks lower or malformed capabilities as requiring a backend update', async () => {
      const d = make({
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() =>
          liveBody('i-1', {
            extensionPairing: { protocol: 'mbp1', versions: [0] },
          })
        ),
      })

      expect((await d.sweepCandidates())[0]?.compatibility).toBe(
        'backendUpgradeRequired'
      )
    })

    it('marks the server runtime as unsupported for extension pairing', async () => {
      const d = make({
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() => liveBody('i-1', { runtime: 'server' })),
      })

      expect((await d.sweepCandidates())[0]?.compatibility).toBe(
        'unsupportedRemote'
      )
    })
  })

  describe('discoverForReconnect', () => {
    it('returns the pinned port without sweeping when it matches', async () => {
      const d = make({
        pins: pinReader({ port: 16805, instanceId: 'inst-x' }),
        candidatePorts: [16802, 16803, 16804, 16805, 16806],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.discoverForReconnect('c1')).toEqual({
        transport: 'probe',
        wsPort: 16805,
        instanceId: 'inst-x',
      })
      expect(requests.map((r) => portOf(r.url))).toEqual([16805])
    })

    it('sweeps for the pinned instanceId when the port moved', async () => {
      const d = make({
        pins: pinReader({ port: 16802, instanceId: 'inst-x' }),
        candidatePorts: [16802, 16803, 16804],
        fetchImpl: discoveryFetch((port) =>
          port === 16804 ? liveBody('inst-x') : liveBody('someone-else')
        ),
      })
      expect(await d.discoverForReconnect('c1')).toEqual({
        transport: 'probe',
        wsPort: 16804,
        instanceId: 'inst-x',
        appVersion: '2.0.0',
        compatibility: 'compatible',
      })
    })

    it('returns null when live candidates exist but none is the pinned instance', async () => {
      const d = make({
        pins: pinReader({ port: 16802, instanceId: 'inst-x' }),
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch((port) => liveBody(`other-${port}`)),
      })
      expect(await d.discoverForReconnect('c1')).toBeNull()
    })

    describe('a credential with no pin (interrupted rotation)', () => {
      it('accepts the single live candidate', async () => {
        const d = make({
          pins: pinReader(null),
          candidatePorts: [16802, 16803, 16804],
          fetchImpl: discoveryFetch((port) =>
            port === 16803 ? liveBody('inst-x') : deadBody()
          ),
        })
        expect(await d.discoverForReconnect('c1')).toEqual({
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        })
      })

      it('refuses to choose between two live candidates', async () => {
        const d = make({
          pins: pinReader(null),
          candidatePorts: [16802, 16803, 16804],
          fetchImpl: discoveryFetch((port) =>
            port === 16804 ? deadBody() : liveBody(`i-${port}`)
          ),
        })
        expect(await d.discoverForReconnect('c1')).toBeNull()
      })

      it('returns null when nothing is live', async () => {
        const d = make({
          pins: pinReader(null),
          candidatePorts: [16802, 16803],
          fetchImpl: discoveryFetch(() => deadBody()),
        })
        expect(await d.discoverForReconnect('c1')).toBeNull()
      })
    })

    it('reads the pin once across the whole chain', async () => {
      const pins = pinReader({ port: 16802, instanceId: 'inst-x' })
      const d = make({
        pins,
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch(() => liveBody('other')),
      })
      await d.discoverForReconnect('c1')
      expect(pins.get).toHaveBeenCalledTimes(1)
    })

    it('never writes to the pin store even when nothing matches', async () => {
      const pins = pinReader({ port: 16802, instanceId: 'inst-x' })
      const d = make({
        pins,
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      expect(await d.discoverForReconnect('c1')).toBeNull()
      expect(pins.clear).not.toHaveBeenCalled()
      expect(pins.commit).not.toHaveBeenCalled()
    })
  })

  describe('discoverForFirstPair', () => {
    it('prefers the NM bootstrap and issues no HTTP request', async () => {
      const nm = bootstrapPort({
        port: 16803,
        nonce: 'nonce-abc',
        nmTicket: { v: 1, purpose: 'mbp1-attestation' },
      })
      const d = make({
        nativeBootstrap: nm as never,
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.discoverForFirstPair({ allowLaunch: true })).toEqual([
        {
          transport: 'nm',
          wsPort: 16803,
          nonce: 'nonce-abc',
          nmTicket: { v: 1, purpose: 'mbp1-attestation' },
        },
      ])
      expect(requests).toHaveLength(0)
    })

    it('forwards allowLaunch to the host verbatim', async () => {
      for (const allowLaunch of [true, false]) {
        const nm = bootstrapPort({ port: 16803, nonce: 'n' })
        await make({ nativeBootstrap: nm as never }).discoverForFirstPair({
          allowLaunch,
        })
        expect(nm.bootstrap).toHaveBeenCalledWith({ allowLaunch })
      }
    })

    it('forwards the exact binding public key to the native bootstrap', async () => {
      const bindingPub = new Uint8Array(32).fill(7)
      const nm = bootstrapPort({ port: 16803, nonce: 'n' })
      await make({ nativeBootstrap: nm as never }).discoverForFirstPair({
        allowLaunch: true,
        bindingPub,
      })

      expect(nm.bootstrap).toHaveBeenCalledWith({
        allowLaunch: true,
        bindingPub,
      })
    })

    it('passes an nmTicket through byte-for-byte', async () => {
      const ticket = { v: 1, serverGeneration: 'gen-1', exp: 123, nested: [1] }
      const nm = bootstrapPort({ port: 16803, nonce: 'n', nmTicket: ticket })
      const [result] = await make({
        nativeBootstrap: nm as never,
      }).discoverForFirstPair({ allowLaunch: true })
      expect(result?.nmTicket).toBe(ticket)
    })

    it('omits nmTicket entirely for a ticketless host reply', async () => {
      const nm = bootstrapPort({ port: 16803, nonce: 'n', nmTicket: null })
      const [result] = await make({
        nativeBootstrap: nm as never,
      }).discoverForFirstPair({ allowLaunch: true })
      // §5/§9.2: a ticketless attempt omits both ticket fields; it does not
      // send `null`.
      expect(result).toEqual({ transport: 'nm', wsPort: 16803, nonce: 'n' })
      expect('nmTicket' in (result ?? {})).toBe(false)
    })

    it('omits nonce for a degraded old host that supplied none', async () => {
      const nm = bootstrapPort({ port: 16803, nonce: null })
      const [result] = await make({
        nativeBootstrap: nm as never,
      }).discoverForFirstPair({ allowLaunch: true })
      expect(result).toEqual({ transport: 'nm', wsPort: 16803 })
      expect('nonce' in (result ?? {})).toBe(false)
    })

    const badHostNonces: Array<[string, string]> = [
      ['an over-long nonce', 'a'.repeat(513)],
      ['a non-ASCII nonce', 'nonce-\u00e4'],
      ['a nonce with a space', 'nonce abc'],
      ['an empty nonce', ''],
    ]

    for (const [label, nonce] of badHostNonces) {
      it(`omits ${label} from the host reply`, async () => {
        const nm = bootstrapPort({ port: 16803, nonce })
        const [result] = await make({
          nativeBootstrap: nm as never,
        }).discoverForFirstPair({ allowLaunch: true })
        // Dropping it degrades to the §4.2 fetch, which is recoverable; a
        // non-ASCII nonce would instead throw out of `enc()` mid-handshake.
        expect(result).toEqual({ transport: 'nm', wsPort: 16803 })
      })
    }

    it('falls back to the sweep when the host errors', async () => {
      const nm = bootstrapPort(new Error('no NM host'))
      const d = make({
        nativeBootstrap: nm as never,
        candidatePorts: [16802, 16803],
        fetchImpl: discoveryFetch((port) =>
          port === 16803 ? liveBody('inst-x') : deadBody()
        ),
      })
      expect(await d.discoverForFirstPair({ allowLaunch: true })).toEqual([
        {
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
    })

    it('falls back to the sweep when the host reports an impossible port', async () => {
      const nm = bootstrapPort({ port: 0, nonce: 'n' })
      const d = make({
        nativeBootstrap: nm as never,
        candidatePorts: [16802],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.discoverForFirstPair({ allowLaunch: true })).toEqual([
        {
          transport: 'probe',
          wsPort: 16802,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
    })

    it('enumerates every live candidate when no host is available', async () => {
      const d = make({
        candidatePorts: [16802, 16803, 16804],
        fetchImpl: discoveryFetch((port) =>
          port === 16803 ? deadBody() : liveBody(`i-${port}`)
        ),
      })
      expect(await d.discoverForFirstPair({ allowLaunch: false })).toEqual([
        {
          transport: 'probe',
          wsPort: 16802,
          instanceId: 'i-16802',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
        {
          transport: 'probe',
          wsPort: 16804,
          instanceId: 'i-16804',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
    })

    it('fetches no nonce for candidates the user has not chosen', async () => {
      const d = make({
        candidatePorts: [16802, 16803, 16804, 16805, 16806],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      await d.discoverForFirstPair({ allowLaunch: false })
      // §4.2: nonces are one-shot, capped and rate-limited. Fetching one per
      // enumerated candidate is what burned ~75 nonces per bootstrap on Line B.
      expect(requests.filter((r) => r.url.endsWith('/nonce'))).toHaveLength(0)
      expect(requests).toHaveLength(5)
    })
  })

  describe('preflightCompatibility', () => {
    it('probes a legacy-shaped NM reply exactly once and preserves its ticket/nonce', async () => {
      const d = make({
        candidatePorts: [16803],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      const nmResult = {
        transport: 'nm' as const,
        wsPort: 16803,
        nonce: 'host-nonce',
        nmTicket: { opaque: true },
      }

      const result = await d.preflightCompatibility(nmResult)

      expect(result).toMatchObject({
        ...nmResult,
        instanceId: 'inst-x',
        compatibility: 'compatible',
      })
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:16803/discovery',
      ])
    })

    it('fails closed when the NM port has no Motrix discovery document', async () => {
      const d = make({
        candidatePorts: [16803],
        fetchImpl: discoveryFetch(() => deadBody()),
      })

      expect(
        await d.preflightCompatibility({ transport: 'nm', wsPort: 16803 })
      ).toMatchObject({ compatibility: 'backendUpgradeRequired' })
    })
  })

  describe('ensureNonce', () => {
    function nonceFetch(
      answer: () => Response | Promise<Response>
    ): typeof fetch {
      return vi.fn(async (input: unknown, init?: RequestInit) => {
        record(String(input), init)
        return answer()
      }) as unknown as typeof fetch
    }

    it('fetches a nonce with POST and the X-Motrix-Bridge header', async () => {
      const d = make({
        fetchImpl: nonceFetch(() =>
          rawBody({ nonce: 'nonce-abc', ttlSeconds: 60 })
        ),
      })
      const out = await d.ensureNonce({
        transport: 'probe',
        wsPort: 16803,
        instanceId: 'inst-x',
      })
      expect(out).toEqual({
        transport: 'probe',
        wsPort: 16803,
        instanceId: 'inst-x',
        nonce: 'nonce-abc',
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('http://127.0.0.1:16803/nonce')
      expect(requests[0]?.init.method).toBe('POST')
      expect(requests[0]?.init.headers).toEqual({ 'X-Motrix-Bridge': '1' })
      expect(requests[0]?.init.redirect).toBe('error')
    })

    it('is a no-op when the NM host already supplied one', async () => {
      const d = make({
        fetchImpl: nonceFetch(() =>
          rawBody({ nonce: 'fresh', ttlSeconds: 60 })
        ),
      })
      const already = {
        transport: 'nm' as const,
        wsPort: 16803,
        nonce: 'from-host',
      }
      expect(await d.ensureNonce(already)).toEqual(already)
      expect(requests).toHaveLength(0)
    })

    it('returns null when the nonce route refuses', async () => {
      const d = make({ fetchImpl: nonceFetch(() => deadBody()) })
      expect(
        await d.ensureNonce({ transport: 'probe', wsPort: 16803 })
      ).toBeNull()
    })

    it('returns null when the connection is refused', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch
      expect(
        await make({ fetchImpl }).ensureNonce({
          transport: 'probe',
          wsPort: 16803,
        })
      ).toBeNull()
    })

    it('returns null on a rate-limited response that still carries a nonce', async () => {
      // §4.2 rate-limits issuance. A 429 body may well be well-formed JSON, so
      // the status check has to stand on its own rather than lean on a parse
      // failure.
      const d = make({
        fetchImpl: nonceFetch(
          () =>
            new Response(JSON.stringify({ nonce: 'nope', ttlSeconds: 60 }), {
              status: 429,
            })
        ),
      })
      expect(
        await d.ensureNonce({ transport: 'probe', wsPort: 16803 })
      ).toBeNull()
    })

    const badNonces: Array<[string, unknown]> = [
      ['a missing nonce', { ttlSeconds: 60 }],
      ['an empty nonce', { nonce: '', ttlSeconds: 60 }],
      ['a non-string nonce', { nonce: 7, ttlSeconds: 60 }],
      ['an over-long nonce', { nonce: 'a'.repeat(513), ttlSeconds: 60 }],
      // Length 2, all bytes < 0x80: fails only the ">= 0x21" half of the
      // printable check.
      ['a control character', { nonce: 'a ', ttlSeconds: 60 }],
      // Length 2, printable but non-ASCII: `enc()` would throw mid-handshake.
      ['a non-ASCII nonce', { nonce: 'ää', ttlSeconds: 60 }],
    ]

    for (const [label, body] of badNonces) {
      it(`returns null for ${label}`, async () => {
        const d = make({ fetchImpl: nonceFetch(() => rawBody(body)) })
        expect(
          await d.ensureNonce({ transport: 'probe', wsPort: 16803 })
        ).toBeNull()
      })
    }

    it('accepts a nonce at exactly the length bound', async () => {
      const nonce = 'a'.repeat(512)
      const d = make({ fetchImpl: nonceFetch(() => rawBody({ nonce })) })
      const out = await d.ensureNonce({ transport: 'probe', wsPort: 16803 })
      expect(out?.nonce).toBe(nonce)
    })
  })

  describe('wakeAndPoll', () => {
    it('opens motrix://open and polls only GET /discovery', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs()
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16802, 16803],
        wakeDeadlineMs: 3_000,
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toEqual([])
      expect(tabs.create).toHaveBeenCalledWith({ url: 'motrix://open' })
      expect(requests.length).toBeGreaterThan(0)
      // The headline invariant: Line B used POST /nonce as its liveness probe
      // here and burned ~75 nonces per bootstrap.
      for (const request of requests) {
        expect(request.url.endsWith('/discovery')).toBe(true)
        expect(request.init.method).toBeUndefined()
        expect(request.init.headers).toBeUndefined()
      }
    })

    it('honours one wall-clock deadline for the whole call', async () => {
      vi.useFakeTimers()
      // Each probe consumes 200 ms of the budget, so a deadline recomputed per
      // sweep (or per port) would let this run forever.
      const d = make({
        tabs: fakeTabs() as never,
        candidatePorts: [16802, 16803],
        wakeDeadlineMs: 3_000,
        discoveryTimeoutMs: 5_000,
        fetchImpl: discoveryFetch(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200))
          return deadBody()
        }),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await pending).toEqual([])
      // 3000 ms of budget, ~700 ms per round (200 probe + 500 gap), 2 ports:
      // comfortably under this bound, and unbounded without a single deadline.
      expect(requests.length).toBeLessThanOrEqual(10)
    })

    it('returns as soon as a candidate answers, and closes the wake tab', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs()
      let round = 0
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16803],
        fetchImpl: discoveryFetch(() => {
          round += 1
          return round < 3 ? deadBody() : liveBody('inst-x')
        }),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await pending).toEqual([
        {
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
      expect(tabs.remove).toHaveBeenCalledWith(7)
    })

    it('leaves the wake tab alone when the deadline expires', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs()
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 1_500,
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await pending).toEqual([])
      // The external-protocol confirmation may still be on screen; closing the
      // tab would cancel the wake we asked for.
      expect(tabs.remove).not.toHaveBeenCalled()
    })

    it('stops after a sweep that overruns the budget, tab untouched', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs()
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 500,
        discoveryTimeoutMs: 5_000,
        fetchImpl: discoveryFetch(async () => {
          await new Promise((resolve) => setTimeout(resolve, 600))
          return deadBody()
        }),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await pending).toEqual([])
      expect(requests).toHaveLength(1)
      expect(tabs.remove).not.toHaveBeenCalled()
    })

    it('tolerates a tabs API that cannot open the URL', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs({
        create: vi.fn(async () => {
          throw new Error('cannot open motrix://')
        }),
      })
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 1_000,
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(2_000)
      // Motrix may already be starting for another reason: poll regardless.
      expect(await pending).toEqual([
        {
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
    })

    it('tolerates an already-closed tab on the success path', async () => {
      vi.useFakeTimers()
      const tabs = fakeTabs({
        remove: vi.fn(async () => {
          throw new Error('No tab with id: 7')
        }),
      })
      const d = make({
        tabs: tabs as never,
        candidatePorts: [16803],
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).toEqual([
        {
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
      expect(tabs.remove).toHaveBeenCalled()
    })

    it('tolerates an environment with no browser.tabs.create', async () => {
      vi.useFakeTimers()
      // No `tabs` injected: the ambient stub in the test setup has only
      // `query`, which is the older-Firefox / restricted-context shape.
      const d = make({
        candidatePorts: [16803],
        wakeDeadlineMs: 1_000,
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      const pending = d.wakeAndPoll()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await pending).toEqual([
        {
          transport: 'probe',
          wsPort: 16803,
          instanceId: 'inst-x',
          appVersion: '2.0.0',
          compatibility: 'compatible',
        },
      ])
    })

    it('never sleeps past the deadline', async () => {
      vi.useFakeTimers()
      const started = Date.now()
      let resolvedAt = -1
      const d = make({
        tabs: fakeTabs() as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 600,
        fetchImpl: discoveryFetch(() => deadBody()),
      })
      const pending = d.wakeAndPoll().then((value) => {
        resolvedAt = Date.now()
        return value
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toEqual([])
      // Two sweeps fit in 600 ms at a 500 ms gap; an unclamped final gap would
      // push the call out to 1000 ms, overshooting the budget it advertises.
      expect(resolvedAt - started).toBeLessThanOrEqual(600)
    })

    it('clamps each probe timeout to the budget that is left', async () => {
      // Real timers: `AbortSignal.timeout` is not driven by vitest's fake ones.
      // With the clamp this settles in ~50 ms; without it the probe waits the
      // full configured 30 s and the test times out instead.
      const started = Date.now()
      const d = make({
        tabs: fakeTabs() as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 50,
        discoveryTimeoutMs: 30_000,
        fetchImpl: abortableFetch(),
      })
      expect(await d.wakeAndPoll()).toEqual([])
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(requests).toHaveLength(1)
    })

    it('returns immediately without probing when the budget is zero', async () => {
      const d = make({
        tabs: fakeTabs() as never,
        candidatePorts: [16803],
        wakeDeadlineMs: 0,
        fetchImpl: discoveryFetch(() => liveBody('inst-x')),
      })
      expect(await d.wakeAndPoll()).toEqual([])
      expect(requests).toHaveLength(0)
    })
  })
})

describe('wakeForReconnect', () => {
  it('discards the v1 nonce and routes only the matching pinned identity', async () => {
    const nm = bootstrapPort({ port: 35001, nonce: 'unused-nonce' })
    const pins: PinReader = {
      get: vi.fn(async (id) => ({ port: 16802, instanceId: id })),
    }
    const service = make({
      pins,
      nativeBootstrap: nm,
      fetchImpl: discoveryFetch(() => liveBody('known')),
    })
    const results = await service.wakeForReconnect(['known', 'other'])
    expect([...results.keys()]).toEqual(['known'])
    expect(results.get('known')).toMatchObject({
      wsPort: 35001,
      instanceId: 'known',
    })
    expect(results.get('known')).not.toHaveProperty('nonce')
    expect(nm.bootstrap).toHaveBeenCalledExactlyOnceWith({ allowLaunch: true })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toMatch(/discovery$/)
  })

  it('does not guess an identity for an unpinned credential when multiple apps are live', async () => {
    const service = make({
      nativeBootstrap: bootstrapPort({ port: 35001, nonce: 'unused' }),
      fetchImpl: discoveryFetch(() => liveBody('known')),
    })
    expect((await service.wakeForReconnect(['uncommitted'])).size).toBe(0)
    expect(requests.every((r) => r.url.endsWith('/discovery'))).toBe(true)
  })

  it('propagates a failed host attempt without scanning or taking another nonce', async () => {
    const service = make({
      nativeBootstrap: bootstrapPort(new Error('host failed')),
    })
    await expect(service.wakeForReconnect(['known'])).rejects.toThrow(
      'host failed'
    )
    expect(requests).toHaveLength(0)
  })
})
