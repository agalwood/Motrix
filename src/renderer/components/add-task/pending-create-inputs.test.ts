import { afterEach, describe, expect, it } from 'vitest'
import {
  createInputIdentity,
  forgetPendingCreate,
  readPendingCreates,
  rememberPendingCreate,
} from './pending-create-inputs'

afterEach(() => localStorage.clear())

describe('unfinished create receipts', () => {
  it('stores opaque identities and can recover them after the form is recreated', () => {
    const request = {
      uris: ['https://example.test/file?token=private'],
      headers: [{ name: 'Cookie', value: 'sid=secret' }],
    }
    const input = {
      id: '018f3b2e-4c5d-7aaa-bbbb-cccccccccccc',
      identity: createInputIdentity(request),
    }
    rememberPendingCreate(input)
    expect(readPendingCreates()).toEqual([input])
    expect(createInputIdentity(request)).toBe(input.identity)
    expect(JSON.stringify(localStorage)).not.toMatch(/private|secret|https:/)
    forgetPendingCreate(input.id)
    expect(readPendingCreates()).toEqual([])
  })

  it('does not confuse changed options with a retry of the same request', () => {
    expect(
      createInputIdentity({ uris: ['https://a/f'], saveDir: '/one' })
    ).not.toBe(createInputIdentity({ uris: ['https://a/f'], saveDir: '/two' }))
  })
})
