import { describe, expect, it } from 'vitest'
import {
  matchesAnyHostPermission,
  matchesHostPermission,
  parseHostPermissionPattern,
} from './host-pattern'
import { HOST_PATTERN_CONFORMANCE_CASES } from './host-pattern.corpus'

describe('manifest-v1 host permissions', () => {
  for (const testCase of HOST_PATTERN_CONFORMANCE_CASES) {
    it(testCase.name, () => {
      expect(matchesHostPermission(testCase.pattern, testCase.url)).toBe(
        testCase.expected
      )
    })
  }

  it.each([
    'file://example.test/*',
    'https://example.test:443/*',
    'https://user@example.test/*',
    'https://example.test?confused/*',
    'https://example.test#confused/*',
    'https://%65xample.test/*',
    'https://*.*.example.test/*',
    'https://[::*]/*',
    'https://example.test',
    'not a pattern',
  ])('rejects invalid pattern %s', (pattern) => {
    expect(parseHostPermissionPattern(pattern)).toBeUndefined()
  })

  it('an empty pattern set denies', () => {
    expect(matchesAnyHostPermission([], 'https://example.test/a')).toBe(false)
  })
})
