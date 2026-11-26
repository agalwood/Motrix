import { describe, expect, it } from 'vitest'
import {
  dnsModeToAsyncDns,
  isDnsContactFailure,
  isUnreachableRouteFailure,
  shouldTriggerDnsFallback,
} from './dns-fallback'

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

describe('isUnreachableRouteFailure & shouldTriggerDnsFallback (#2421)', () => {
  it.each([
    'Network problem has occurred. cause:A socket operation was attempted to an unreachable network',
    'Network problem has occurred. cause:A socket operation was attempted to an unreachable host',
    'Network problem has occurred. cause:Unknown socket error 10051 (0x2743)',
    'Network problem has occurred. cause:Unknown socket error 10065 (0x2751)',
    'Network problem has occurred. cause:Network is unreachable',
    'Network problem has occurred. cause:No route to host',
  ])('matches unreachable route failure %s', (message) => {
    expect(isUnreachableRouteFailure(message)).toBe(true)
    expect(shouldTriggerDnsFallback(message)).toBe(true)
  })

  it.each([
    'Connection refused by remote host',
    'Connection reset by peer',
    'Timeout.',
    'CUID#11 - Name resolution for nxdomain.example failed:Domain name not found',
    '',
  ])('does not misclassify %s as unreachable route', (message) => {
    expect(isUnreachableRouteFailure(message)).toBe(false)
    expect(shouldTriggerDnsFallback(message)).toBe(false)
  })

  it('triggers fallback for c-ares contact failures as well', () => {
    expect(
      shouldTriggerDnsFallback(
        'CUID#11 - Name resolution for mikanani.me failed:Could not contact DNS servers'
      )
    ).toBe(true)
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
