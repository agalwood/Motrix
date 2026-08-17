import { describe, expect, it } from 'vitest'
import { dnsModeToAsyncDns, isDnsContactFailure } from './dns-fallback'

// Messages reproduce aria2's MSG_NAME_RESOLUTION_FAILED format wrapping the
// exact ares_strerror() texts. Only c-ares *transport* failures qualify for
// a system-resolver fallback; deterministic answers (NXDOMAIN, no data) must
// never retrigger a retry.
describe('isDnsContactFailure', () => {
  it.each([
    'CUID#11 - Name resolution for mikanani.me failed:Could not contact DNS servers',
    'CUID#7 - Name resolution for example.com failed:Timeout while contacting DNS servers',
    'CUID#3 - Name resolution for tracker.example failed:No DNS servers were configured',
  ])('matches transport failure %s', (message) => {
    expect(isDnsContactFailure(message)).toBe(true)
  })

  it.each([
    'CUID#11 - Name resolution for nxdomain.example failed:Domain name not found',
    'CUID#11 - Name resolution for a.example failed:DNS server returned answer with no data',
    'CUID#11 - Name resolution for b.example failed:DNS server returned general failure',
    'Connection refused by remote host',
    '',
  ])('does not match %s', (message) => {
    expect(isDnsContactFailure(message)).toBe(false)
  })

  it('does not match null', () => {
    expect(isDnsContactFailure(null)).toBe(false)
  })
})

describe('dnsModeToAsyncDns', () => {
  it.each([
    ['auto', true],
    ['engine', true],
    ['system', false],
  ] as const)('%s -> async-dns=%s', (mode, asyncDns) => {
    expect(dnsModeToAsyncDns(mode)).toBe(asyncDns)
  })
})
