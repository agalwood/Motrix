import { describe, expect, it } from 'vitest'
import { dsmGatewayGroup } from './runtime'

describe('DSM gateway group resolution', () => {
  it('uses the system-assigned group only when it is an actual supplementary group', () => {
    expect(
      dsmGatewayGroup('motrix:x:4500:\nhttp:x:1023:motrix\n', [4500, 1023])
    ).toBe(1023)
    // Text membership alone cannot authorize changing socket access.
    expect(() => dsmGatewayGroup('http:x:1023:motrix\n', [4500])).toThrow()
  })
  it('rejects missing, ambiguous, root and invalid groups', () => {
    for (const contents of [
      '',
      'http:x:0:motrix',
      'http:x:1023:\nhttp:x:1024:',
      'http:x:4294967295:',
      'http:x:-1:',
      'http:x:1023:extra:field',
    ]) {
      expect(() =>
        dsmGatewayGroup(contents, [0, 1023, 1024, 4294967295, -1])
      ).toThrow()
    }
  })
})
