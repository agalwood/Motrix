import { describe, expect, it } from 'vitest'
import {
  RemoteExtensionAdmissionPolicy,
  type RemoteExtensionAdmissionPolicyOptions,
  type RemoteExtensionClientSourceInput,
} from './remote-extension-admission-policy'
import {
  parseRemoteExtensionConfig,
  type RemoteExtensionConfig,
} from './remote-extension-config'

const ENABLED_CONFIG = parseRemoteExtensionConfig({
  MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
  MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'wss://motrix.example/bridge',
  MOTRIX_PUBLIC_URL: 'https://motrix.example/operator',
})

function options(
  overrides: Partial<RemoteExtensionAdmissionPolicyOptions> = {}
): RemoteExtensionAdmissionPolicyOptions {
  return {
    config: ENABLED_CONFIG,
    nonceIssuanceCap: 2,
    nonceIssuanceTtlMs: 60,
    pairPreAuthSocketCap: 2,
    pairPreAuthSocketTtlMs: 150,
    v1PreAuthSocketCap: 2,
    v1PreAuthSocketTtlMs: 15,
    pendingPromptCap: 2,
    pendingPromptTtlMs: 120,
    discoveryRate: {
      globalCap: 4,
      perSourceCap: 2,
      windowMs: 100,
    },
    nonceRate: {
      globalCap: 4,
      perSourceCap: 2,
      windowMs: 100,
    },
    ...overrides,
  }
}

function source(
  directPeerAddress: string,
  rawHeaders: readonly string[] = []
): RemoteExtensionClientSourceInput {
  return { directPeerAddress, rawHeaders }
}

function expectLease(
  result: ReturnType<RemoteExtensionAdmissionPolicy['acquirePairPreAuthSocket']>
) {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('test expected an admission lease')
  return result.lease
}

describe('RemoteExtensionAdmissionPolicy resource caps', () => {
  it('starts with independent empty counters', () => {
    const policy = new RemoteExtensionAdmissionPolicy(options())

    expect(policy.snapshot()).toEqual({
      nonceIssuances: 0,
      pairPreAuthSockets: 0,
      v1PreAuthSockets: 0,
      pendingPrompts: 0,
      discoveryRequestsInWindow: 0,
      nonceRequestsInWindow: 0,
      discoverySourcesInWindow: 0,
      nonceSourcesInWindow: 0,
    })
  })

  it('enforces nonce issuance capacity before mutating its request rate', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        nonceIssuanceCap: 1,
        nonceRate: { globalCap: 3, perSourceCap: 3, windowMs: 100 },
      })
    )
    const first = policy.admitNonceRequest(source('192.0.2.1'))
    const refused = policy.admitNonceRequest(source('192.0.2.2'))

    expect(first.ok).toBe(true)
    expect(refused).toEqual({ ok: false, reason: 'capacity' })
    expect(policy.snapshot()).toMatchObject({
      nonceIssuances: 1,
      nonceRequestsInWindow: 1,
    })
  })

  it('releases a nonce slot once and permits a replacement', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ nonceIssuanceCap: 1 })
    )
    const first = policy.admitNonceRequest(source('192.0.2.1'))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    first.lease.release()
    first.lease.release()

    expect(policy.snapshot().nonceIssuances).toBe(0)
    expect(policy.admitNonceRequest(source('192.0.2.1')).ok).toBe(true)
    expect(policy.snapshot().nonceIssuances).toBe(1)
  })

  it('expires abandoned nonce reservations exactly at their TTL boundary', () => {
    let now = 10
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ nonceIssuanceCap: 1, nonceIssuanceTtlMs: 60, now: () => now })
    )
    const first = policy.admitNonceRequest(source('192.0.2.1'))
    expect(first.ok).toBe(true)

    now = 69
    expect(policy.snapshot().nonceIssuances).toBe(1)
    now = 70
    expect(policy.snapshot().nonceIssuances).toBe(0)
    expect(policy.admitNonceRequest(source('192.0.2.1')).ok).toBe(true)
  })

  it('expires pair and v1 socket reservations on their independent deadlines', () => {
    let now = 0
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        pairPreAuthSocketCap: 1,
        pairPreAuthSocketTtlMs: 20,
        v1PreAuthSocketCap: 1,
        v1PreAuthSocketTtlMs: 10,
        now: () => now,
      })
    )
    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.acquireV1PreAuthSocket().ok).toBe(true)

    now = 10
    expect(policy.snapshot()).toMatchObject({
      pairPreAuthSockets: 1,
      v1PreAuthSockets: 0,
    })
    now = 20
    expect(policy.snapshot()).toMatchObject({
      pairPreAuthSockets: 0,
      v1PreAuthSockets: 0,
    })
  })

  it('keeps pair, v1, nonce, and prompt capacities independent', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        nonceIssuanceCap: 1,
        pairPreAuthSocketCap: 1,
        v1PreAuthSocketCap: 1,
        pendingPromptCap: 1,
      })
    )

    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    expect(policy.acquireV1PreAuthSocket().ok).toBe(true)
    expect(policy.acquireV1PreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    expect(policy.admitNonceRequest(source('192.0.2.1')).ok).toBe(true)
    expect(
      policy.acquirePendingPrompt('chrome-extension://forged-one').ok
    ).toBe(true)
    expect(policy.snapshot()).toMatchObject({
      nonceIssuances: 1,
      pairPreAuthSockets: 1,
      v1PreAuthSockets: 1,
      pendingPrompts: 1,
    })
  })

  it('deduplicates one verified Origin without weakening the global prompt cap', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ pendingPromptCap: 2 })
    )
    const first = policy.acquirePendingPrompt('chrome-extension://forged-one/')
    const duplicate = policy.acquirePendingPrompt(
      'chrome-extension://FORGED-ONE'
    )
    const rotated = policy.acquirePendingPrompt('chrome-extension://forged-two')
    const exhausted = policy.acquirePendingPrompt(
      'chrome-extension://forged-three'
    )

    expect(first.ok && first.disposition).toBe('opened')
    expect(duplicate).toEqual({ ok: true, disposition: 'deduplicated' })
    expect(rotated.ok && rotated.disposition).toBe('opened')
    expect(exhausted).toEqual({ ok: false, reason: 'capacity' })
    expect(policy.snapshot().pendingPrompts).toBe(2)
  })

  it('rejects unsafe prompt origins without allocating a map entry', () => {
    const policy = new RemoteExtensionAdmissionPolicy(options())

    for (const verifiedOrigin of [
      '',
      'https://example.test',
      'chrome-extension://one/path',
      'chrome-extension://one?query',
      'chrome-extension://one%2falias',
      `chrome-extension://${'a'.repeat(1_025)}`,
    ]) {
      expect(policy.acquirePendingPrompt(verifiedOrigin)).toEqual({
        ok: false,
        reason: 'invalid-verified-origin',
      })
    }
    expect(policy.snapshot().pendingPrompts).toBe(0)
  })

  it('does not let an expired prompt lease release its replacement', () => {
    let now = 0
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ pendingPromptCap: 1, pendingPromptTtlMs: 10, now: () => now })
    )
    const first = policy.acquirePendingPrompt('moz-extension://first-origin')
    expect(first.ok && first.disposition).toBe('opened')
    if (!first.ok || first.disposition !== 'opened') return

    now = 10
    const replacement = policy.acquirePendingPrompt(
      'moz-extension://first-origin'
    )
    expect(replacement.ok && replacement.disposition).toBe('opened')
    first.lease.release()
    expect(policy.snapshot().pendingPrompts).toBe(1)
  })

  it('makes release and dispose safe across duplicate exceptional cleanup paths', () => {
    const policy = new RemoteExtensionAdmissionPolicy(options())
    const lease = expectLease(policy.acquirePairPreAuthSocket())

    try {
      throw new Error('synthetic handler failure')
    } catch {
      lease.release()
    } finally {
      lease.release()
      policy.dispose()
      policy.dispose()
    }

    expect(policy.snapshot()).toMatchObject({
      nonceIssuances: 0,
      pairPreAuthSockets: 0,
      v1PreAuthSockets: 0,
      pendingPrompts: 0,
    })
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'disposed',
    })
  })

  it('admits concurrent callers only up to the synchronous global cap', async () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ pairPreAuthSocketCap: 3 })
    )
    const decisions = await Promise.all(
      Array.from({ length: 20 }, async () => policy.acquirePairPreAuthSocket())
    )

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(3)
    expect(policy.snapshot().pairPreAuthSockets).toBe(3)
    for (const decision of decisions) {
      if (decision.ok) decision.lease.release()
    }
    expect(policy.snapshot().pairPreAuthSockets).toBe(0)
  })
})

describe('RemoteExtensionAdmissionPolicy request rates', () => {
  it('keeps discovery and nonce global windows independent', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        nonceIssuanceCap: 4,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
        nonceRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')

    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    expect(policy.admitNonceRequest(peer).ok).toBe(true)
    expect(policy.admitNonceRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
  })

  it('expires rate entries at the exact injected-clock window boundary', () => {
    let now = 1_000
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')

    expect(policy.admitDiscoveryRequest(peer).ok).toBe(true)
    now = 1_099
    expect(policy.admitDiscoveryRequest(peer).ok).toBe(false)
    now = 1_100
    expect(policy.admitDiscoveryRequest(peer).ok).toBe(true)
  })

  it('does not let a backwards clock jump reopen a rate window', () => {
    let now = 1_000
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')

    expect(policy.admitDiscoveryRequest(peer).ok).toBe(true)
    now = 900
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
  })

  it('does not count a replayed source interval twice for a rate window', () => {
    let now = 1_000
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')

    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
    now = 1_050
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    now = 1_000
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    now = 1_050
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    now = 1_099
    expect(policy.admitDiscoveryRequest(peer)).toEqual({
      ok: false,
      reason: 'rate-limited',
    })
    now = 1_100
    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
  })

  it('does not count a replayed source interval twice for a capacity lease', () => {
    let now = 1_000
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        pairPreAuthSocketCap: 1,
        pairPreAuthSocketTtlMs: 100,
      })
    )

    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    now = 1_050
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    now = 1_000
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    now = 1_050
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    now = 1_099
    expect(policy.acquirePairPreAuthSocket()).toEqual({
      ok: false,
      reason: 'capacity',
    })
    now = 1_100
    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
  })

  it('expires records that existed before an unreplayed forward jump', () => {
    let now = 1_000
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        pairPreAuthSocketCap: 1,
        pairPreAuthSocketTtlMs: 100,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')

    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
    now = 1_100
    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
  })

  it('bounds rotating source maps by the independent global window cap', () => {
    let now = 0
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        trustedProxyAddresses: ['192.0.2.10'],
        discoveryRate: { globalCap: 3, perSourceCap: 2, windowMs: 100 },
      })
    )

    for (const forwarded of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      expect(
        policy.admitDiscoveryRequest(
          source('192.0.2.10', ['X-Forwarded-For', forwarded])
        ).ok
      ).toBe(true)
    }
    expect(
      policy.admitDiscoveryRequest(
        source('192.0.2.10', ['X-Forwarded-For', '198.51.100.4'])
      )
    ).toEqual({ ok: false, reason: 'rate-limited' })
    expect(policy.snapshot().discoverySourcesInWindow).toBe(3)

    now = 100
    expect(
      policy.admitDiscoveryRequest(
        source('192.0.2.10', ['X-Forwarded-For', '198.51.100.4'])
      ).ok
    ).toBe(true)
    expect(policy.snapshot().discoverySourcesInWindow).toBe(1)
  })

  it('does not allocate source buckets for refused rotating attempts', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        trustedProxyAddresses: ['192.0.2.10'],
        nonceIssuanceCap: 10,
        nonceRate: { globalCap: 2, perSourceCap: 1, windowMs: 100 },
      })
    )

    expect(
      policy.admitNonceRequest(
        source('192.0.2.10', ['Forwarded', 'for=198.51.100.1'])
      ).ok
    ).toBe(true)
    expect(
      policy.admitNonceRequest(
        source('192.0.2.10', ['Forwarded', 'for=198.51.100.1'])
      )
    ).toEqual({ ok: false, reason: 'rate-limited' })
    expect(policy.snapshot().nonceSourcesInWindow).toBe(1)
  })
})

describe('RemoteExtensionAdmissionPolicy source boundary', () => {
  it('ignores all forwarded fields from an arbitrary direct peer', () => {
    const policy = new RemoteExtensionAdmissionPolicy(options())
    const decision = policy.resolveClientSource(
      source('192.0.2.50', [
        'Forwarded',
        'for=198.51.100.1, for=198.51.100.2',
        'X-Forwarded-For',
        'not-an-ip',
        'X-Forwarded-For',
        '203.0.113.2',
      ])
    )

    expect(decision).toEqual({
      ok: true,
      source: '192.0.2.50',
      provenance: 'direct-peer',
    })
  })

  it('fails closed when the socket has no direct peer address', () => {
    const policy = new RemoteExtensionAdmissionPolicy(options())

    expect(
      policy.resolveClientSource({
        directPeerAddress: undefined,
        rawHeaders: ['X-Forwarded-For', '198.51.100.1'],
      })
    ).toEqual({ ok: false, reason: 'invalid-direct-peer' })
  })

  it('prevents arbitrary XFF rotation from obtaining new rate buckets', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        discoveryRate: { globalCap: 10, perSourceCap: 1, windowMs: 100 },
      })
    )

    expect(
      policy.admitDiscoveryRequest(
        source('192.0.2.50', ['X-Forwarded-For', '198.51.100.1'])
      ).ok
    ).toBe(true)
    for (const forged of ['198.51.100.2', '198.51.100.3']) {
      expect(
        policy.admitDiscoveryRequest(
          source('192.0.2.50', ['X-Forwarded-For', forged])
        )
      ).toEqual({ ok: false, reason: 'rate-limited' })
    }
    expect(policy.snapshot().discoverySourcesInWindow).toBe(1)
  })

  it.each([
    ['dotted then mapped', '192.0.2.50', '::ffff:192.0.2.50'],
    ['mapped then dotted', '::ffff:c000:232', '192.0.2.50'],
  ])(
    'does not give one IPv4 peer two source buckets via %s representation',
    (_label, firstPeer, secondPeer) => {
      const policy = new RemoteExtensionAdmissionPolicy(
        options({
          discoveryRate: { globalCap: 10, perSourceCap: 1, windowMs: 100 },
        })
      )

      expect(policy.admitDiscoveryRequest(source(firstPeer))).toEqual({
        ok: true,
      })
      expect(policy.admitDiscoveryRequest(source(secondPeer))).toEqual({
        ok: false,
        reason: 'rate-limited',
      })
      expect(policy.snapshot().discoverySourcesInWindow).toBe(1)
    }
  )

  it('shares a trusted-proxy forwarded-source bucket across dotted and mapped IPv4', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        trustedProxyAddresses: ['192.0.2.10'],
        discoveryRate: { globalCap: 10, perSourceCap: 1, windowMs: 100 },
      })
    )

    expect(
      policy.admitDiscoveryRequest(
        source('192.0.2.10', ['X-Forwarded-For', '198.51.100.7'])
      )
    ).toEqual({ ok: true })
    expect(
      policy.admitDiscoveryRequest(
        source('::ffff:192.0.2.10', ['X-Forwarded-For', '::ffff:198.51.100.7'])
      )
    ).toEqual({ ok: false, reason: 'rate-limited' })
    expect(policy.snapshot().discoverySourcesInWindow).toBe(1)
  })

  it.each([
    [
      'X-Forwarded-For IPv4',
      ['X-Forwarded-For', '198.51.100.7'],
      '198.51.100.7',
    ],
    [
      'X-Forwarded-For IPv6',
      ['X-Forwarded-For', '2001:0db8:0:0::7'],
      '2001:db8::7',
    ],
    ['Forwarded IPv4', ['Forwarded', 'for=198.51.100.8'], '198.51.100.8'],
    [
      'Forwarded IPv4 with parameters',
      ['Forwarded', 'for=198.51.100.9;proto=https;host=motrix.example'],
      '198.51.100.9',
    ],
    [
      'Forwarded quoted IPv6',
      ['Forwarded', 'for="[2001:0db8:0:0::9]";proto=https'],
      '2001:db8::9',
    ],
    [
      'Forwarded quoted IPv4-mapped IPv6',
      ['Forwarded', 'for="[::ffff:198.51.100.9]";proto=https'],
      '198.51.100.9',
    ],
  ])(
    'accepts one unambiguous %s from a trusted proxy',
    (_label, headers, ip) => {
      const policy = new RemoteExtensionAdmissionPolicy(
        options({ trustedProxyAddresses: ['192.0.2.10'] })
      )

      expect(policy.resolveClientSource(source('192.0.2.10', headers))).toEqual(
        {
          ok: true,
          source: ip,
          provenance: 'trusted-proxy',
        }
      )
    }
  )

  it('canonicalizes the direct peer before checking the proxy allowlist', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ trustedProxyAddresses: ['2001:db8::1'] })
    )

    expect(
      policy.resolveClientSource(
        source('2001:0db8:0:0:0:0:0:1', ['X-Forwarded-For', '198.51.100.10'])
      )
    ).toEqual({
      ok: true,
      source: '198.51.100.10',
      provenance: 'trusted-proxy',
    })
  })

  it.each(['192.0.2.10', '::ffff:192.0.2.10'])(
    'trusts a canonical IPv4 proxy when the socket reports %s',
    (directPeer) => {
      const policy = new RemoteExtensionAdmissionPolicy(
        options({ trustedProxyAddresses: ['192.0.2.10'] })
      )

      expect(
        policy.resolveClientSource(
          source(directPeer, ['X-Forwarded-For', '198.51.100.10'])
        )
      ).toEqual({
        ok: true,
        source: '198.51.100.10',
        provenance: 'trusted-proxy',
      })
    }
  )

  it('falls back only to the trusted proxy direct address when no forwarding field exists', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ trustedProxyAddresses: ['192.0.2.10'] })
    )

    expect(policy.resolveClientSource(source('192.0.2.10'))).toEqual({
      ok: true,
      source: '192.0.2.10',
      provenance: 'direct-peer',
    })
  })

  it.each([
    [
      'duplicate XFF',
      ['X-Forwarded-For', '198.51.100.1', 'x-forwarded-for', '198.51.100.2'],
    ],
    [
      'both standards',
      ['Forwarded', 'for=198.51.100.1', 'X-Forwarded-For', '198.51.100.1'],
    ],
    ['XFF list', ['X-Forwarded-For', '198.51.100.1, 198.51.100.2']],
    ['Forwarded list', ['Forwarded', 'for=198.51.100.1,for=198.51.100.2']],
    ['duplicate for', ['Forwarded', 'for=198.51.100.1;for=198.51.100.2']],
  ])('rejects ambiguous trusted-proxy source: %s', (_label, headers) => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ trustedProxyAddresses: ['192.0.2.10'] })
    )

    expect(policy.resolveClientSource(source('192.0.2.10', headers))).toEqual({
      ok: false,
      reason: 'ambiguous-forwarded-source',
    })
  })

  it.each([
    ['invalid direct peer', 'not-an-ip', []],
    ['invalid XFF', '192.0.2.10', ['X-Forwarded-For', 'not-an-ip']],
    ['spaced XFF', '192.0.2.10', ['X-Forwarded-For', ' 198.51.100.1']],
    ['XFF port', '192.0.2.10', ['X-Forwarded-For', '198.51.100.1:443']],
    ['unknown Forwarded', '192.0.2.10', ['Forwarded', 'for=unknown']],
    [
      'spaced Forwarded',
      '192.0.2.10',
      ['Forwarded', 'for=198.51.100.1; proto=https'],
    ],
    [
      'Forwarded IPv4 port',
      '192.0.2.10',
      ['Forwarded', 'for=198.51.100.1:443'],
    ],
    [
      'unquoted Forwarded IPv4-mapped IPv6',
      '192.0.2.10',
      ['Forwarded', 'for=::ffff:198.51.100.1'],
    ],
    ['missing for', '192.0.2.10', ['Forwarded', 'proto=https']],
    ['odd raw headers', '192.0.2.10', ['Forwarded']],
  ])('rejects malformed source input: %s', (_label, peer, headers) => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ trustedProxyAddresses: ['192.0.2.10'] })
    )
    const decision = policy.resolveClientSource(source(peer, headers))

    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(['invalid-direct-peer', 'malformed-forwarded-source']).toContain(
        decision.reason
      )
      expect(JSON.stringify(decision)).not.toContain('198.51.100.1')
    }
  })

  it('bounds trusted-proxy header parsing', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({ trustedProxyAddresses: ['192.0.2.10'] })
    )

    expect(
      policy.resolveClientSource(
        source(
          '192.0.2.10',
          Array.from({ length: 258 }, () => 'irrelevant')
        )
      )
    ).toEqual({ ok: false, reason: 'malformed-forwarded-source' })
    expect(
      policy.resolveClientSource(
        source('192.0.2.10', ['X-Forwarded-For', '1'.repeat(1_025)])
      )
    ).toEqual({ ok: false, reason: 'malformed-forwarded-source' })
    expect(
      policy.resolveClientSource(
        source('192.0.2.10', ['x'.repeat(129), 'ignored'])
      )
    ).toEqual({ ok: false, reason: 'malformed-forwarded-source' })
  })
})

describe('RemoteExtensionAdmissionPolicy configuration', () => {
  it('requires the exact parser-issued enabled configuration capability', () => {
    const disabled = parseRemoteExtensionConfig({})
    const invalid = parseRemoteExtensionConfig({
      MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
      MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'https://motrix.example/bridge',
      MOTRIX_PUBLIC_URL: 'https://motrix.example/operator',
    })
    const copied = { ...ENABLED_CONFIG } as RemoteExtensionConfig
    const forged = {
      status: 'enabled',
      publicWebSocketBaseUrl: 'wss://motrix.example/bridge',
      publicWebSocketAuthority: 'motrix.example',
      publicWebSocketBasePath: '/bridge',
      publicOperatorBaseUrl: 'https://motrix.example/operator',
      publicOperatorAuthority: 'motrix.example',
      publicOperatorBasePath: '/operator',
    } as unknown as RemoteExtensionConfig

    for (const config of [disabled, invalid, copied, forged]) {
      expect(
        () => new RemoteExtensionAdmissionPolicy(options({ config }))
      ).toThrowError('invalid remote extension admission configuration')
    }
    expect(
      new RemoteExtensionAdmissionPolicy(options()).snapshot()
    ).toMatchObject({ nonceIssuances: 0, pairPreAuthSockets: 0 })
  })

  it('accepts the exact clock horizon and preserves live state when the next tick overflows', () => {
    let now = 0
    const maximumHorizonMs = 150
    const boundary = Number.MAX_SAFE_INTEGER - maximumHorizonMs
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        nonceIssuanceCap: 2,
        pairPreAuthSocketCap: 2,
        v1PreAuthSocketCap: 2,
        pendingPromptCap: 2,
        discoveryRate: { globalCap: 2, perSourceCap: 2, windowMs: 100 },
        nonceRate: { globalCap: 2, perSourceCap: 2, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')
    expect(policy.snapshot().pairPreAuthSockets).toBe(0)

    // The equality boundary is valid. Allocate after reaching it so every
    // table contains live state immediately before the rejected +1 sample.
    now = boundary
    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.acquireV1PreAuthSocket().ok).toBe(true)
    expect(policy.admitNonceRequest(peer).ok).toBe(true)
    expect(
      policy.acquirePendingPrompt('chrome-extension://boundary-origin').ok
    ).toBe(true)
    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
    const beforeOverflow = policy.snapshot()

    now = boundary + 1
    const fixedError = 'invalid remote extension admission configuration'
    expect(() => policy.snapshot()).toThrowError(fixedError)
    expect(() => policy.acquirePairPreAuthSocket()).toThrowError(fixedError)
    expect(() => policy.admitNonceRequest(peer)).toThrowError(fixedError)
    expect(() =>
      policy.acquirePendingPrompt('chrome-extension://new-origin')
    ).toThrowError(fixedError)

    // A rejected sample cannot advance the high-water mark, sweep leases,
    // prune rates, or allocate anything. Returning to the last safe sample
    // exposes the exact pre-overflow state.
    now = boundary
    expect(policy.snapshot()).toEqual(beforeOverflow)
  })

  it('rejects an unrepresentable clock jump atomically and recovers on a safe sample', () => {
    let now = 0
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => now,
        nonceIssuanceCap: 1,
        pairPreAuthSocketCap: 1,
        v1PreAuthSocketCap: 1,
        pendingPromptCap: 1,
        discoveryRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
        nonceRate: { globalCap: 1, perSourceCap: 1, windowMs: 100 },
      })
    )
    const peer = source('192.0.2.1')
    const fixedError = 'invalid remote extension admission configuration'

    expect(policy.snapshot()).toMatchObject({
      nonceIssuances: 0,
      pairPreAuthSockets: 0,
      v1PreAuthSockets: 0,
      pendingPrompts: 0,
      discoveryRequestsInWindow: 0,
      nonceRequestsInWindow: 0,
    })
    now = Number.MAX_SAFE_INTEGER
    expect(() => policy.admitNonceRequest(peer)).toThrowError(fixedError)
    expect(() => policy.acquirePairPreAuthSocket()).toThrowError(fixedError)
    expect(() => policy.acquireV1PreAuthSocket()).toThrowError(fixedError)
    expect(() =>
      policy.acquirePendingPrompt('chrome-extension://clock-overflow')
    ).toThrowError(fixedError)
    expect(() => policy.admitDiscoveryRequest(peer)).toThrowError(fixedError)

    now = 0
    expect(policy.snapshot()).toMatchObject({
      nonceIssuances: 0,
      pairPreAuthSockets: 0,
      v1PreAuthSockets: 0,
      pendingPrompts: 0,
      discoveryRequestsInWindow: 0,
      nonceRequestsInWindow: 0,
    })
    now = 1
    expect(policy.admitNonceRequest(peer).ok).toBe(true)
    expect(policy.acquirePairPreAuthSocket().ok).toBe(true)
    expect(policy.acquireV1PreAuthSocket().ok).toBe(true)
    expect(
      policy.acquirePendingPrompt('chrome-extension://clock-overflow').ok
    ).toBe(true)
    expect(policy.admitDiscoveryRequest(peer)).toEqual({ ok: true })
  })

  it.each([
    { nonceIssuanceCap: 0 },
    { pairPreAuthSocketTtlMs: Number.POSITIVE_INFINITY },
    { pendingPromptCap: 1.5 },
    { discoveryRate: { globalCap: 0, perSourceCap: 1, windowMs: 100 } },
    { nonceRate: { globalCap: 1, perSourceCap: -1, windowMs: 100 } },
  ])('fails closed on an invalid numeric bound', (override) => {
    expect(
      () =>
        new RemoteExtensionAdmissionPolicy(
          options(override as Partial<RemoteExtensionAdmissionPolicyOptions>)
        )
    ).toThrowError('invalid remote extension admission configuration')
  })

  it.each([
    ['192.0.2.010'],
    ['::ffff:192.0.2.10'],
    ['2001:0DB8::1'],
    ['[2001:db8::1]'],
    ['proxy.example'],
    ['192.0.2.1', '192.0.2.1'],
  ])('requires a unique canonical exact-IP proxy allowlist', (...entries) => {
    expect(
      () =>
        new RemoteExtensionAdmissionPolicy(
          options({ trustedProxyAddresses: entries })
        )
    ).toThrowError('invalid remote extension admission configuration')
  })

  it('redacts an injected clock failure behind a fixed error', () => {
    const policy = new RemoteExtensionAdmissionPolicy(
      options({
        now: () => {
          throw new Error('request-derived-secret')
        },
      })
    )

    expect(() => policy.snapshot()).toThrowError(
      'invalid remote extension admission configuration'
    )
  })
})
