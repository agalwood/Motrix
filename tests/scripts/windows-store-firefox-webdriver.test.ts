// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decodeFirefoxWebDriverResponse } from '../../scripts/windows-store-firefox-webdriver.mjs'

describe('normal Firefox WebDriver response boundary', () => {
  it('returns ordinary successful response values including a null close result', () => {
    expect(
      decodeFirefoxWebDriverResponse(
        true,
        Buffer.from('{"value":{"sessionId":"owned"}}')
      )
    ).toEqual({ sessionId: 'owned' })
    expect(
      decodeFirefoxWebDriverResponse(true, Buffer.from('{"value":null}'))
    ).toBeNull()
  })
  it.each([
    [
      false,
      '{"value":{"error":"unknown error","message":"private pairing code"}}',
    ],
    [
      true,
      '{"value":{"error":"unsupported operation","message":"private profile"}}',
    ],
    [true, '{"unexpected":"private"}'],
    [true, 'private malformed JSON'],
  ])('withholds raw remote failures and unknown envelopes', (ok, body) => {
    expect(() => decodeFirefoxWebDriverResponse(ok, Buffer.from(body))).toThrow(
      'firefox-webdriver-failed'
    )
  })
  it('refuses oversized and malformed UTF-8 data', () => {
    expect(() =>
      decodeFirefoxWebDriverResponse(true, Buffer.alloc(65537, 65))
    ).toThrow('firefox-webdriver-failed')
    expect(() =>
      decodeFirefoxWebDriverResponse(true, Buffer.from([0xff]))
    ).toThrow('firefox-webdriver-failed')
  })
})
