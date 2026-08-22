import { describe, expect, it } from 'vitest'
import { isConnectionLimitRangeError } from './error-utils'

describe('isConnectionLimitRangeError', () => {
  it('recognizes official aria2 connection ceiling failures', () => {
    expect(
      isConnectionLimitRangeError(
        new Error(
          'JSON-RPC errorCode=28: max-connection-per-server must be between 1 and 16'
        )
      )
    ).toBe(true)
    expect(
      isConnectionLimitRangeError(
        'errorCode=28: The integer must be between 1 and 16.'
      )
    ).toBe(true)
  })

  it('does not classify unrelated option or transport failures', () => {
    expect(
      isConnectionLimitRangeError(
        'errorCode=28: max-tries must be between 1 and 16'
      )
    ).toBe(true)
    expect(
      isConnectionLimitRangeError(
        'max-connection-per-server must be between 1 and 32'
      )
    ).toBe(false)
    expect(isConnectionLimitRangeError('connection refused')).toBe(false)
  })
})
