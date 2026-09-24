import { describe, expect, it } from 'vitest'
import { infoHashToMagnetUri, normalizeMagnetInputLines } from './magnet-input'

const HEX_HASH = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
const BASE32_HASH = 'U3VG6P2M2T4K4I7NL4ZATCYXMVTZHDAL'

describe('infoHashToMagnetUri', () => {
  it.each([
    [HEX_HASH, HEX_HASH],
    [HEX_HASH.toUpperCase(), HEX_HASH],
    [` \t${HEX_HASH}\r\n`, HEX_HASH],
    [BASE32_HASH, BASE32_HASH],
    [BASE32_HASH.toLowerCase(), BASE32_HASH],
  ])('expands a complete BT info hash: %s', (input, hash) => {
    expect(infoHashToMagnetUri(input)).toBe(`magnet:?xt=urn:btih:${hash}`)
  })

  it.each([
    '',
    HEX_HASH.slice(1),
    `${HEX_HASH}0`,
    `g${HEX_HASH.slice(1)}`,
    '0123456789abcdef'.repeat(2),
    'a'.repeat(64),
    `0${BASE32_HASH.slice(1)}`,
    `${BASE32_HASH}=`,
    `${HEX_HASH.slice(0, 20)} ${HEX_HASH.slice(20)}`,
    `${HEX_HASH.slice(0, 20)}\\${HEX_HASH.slice(20)}`,
    `hash: ${HEX_HASH}`,
    `https://example.com/${HEX_HASH}?sig=a%2Fb%5Cc`,
    `magnet:?xt=urn:btih:${HEX_HASH}&tr=https%3A%2F%2Ftracker.test`,
    `${HEX_HASH}\n${BASE32_HASH}`,
  ])('does not infer a bare info hash from %s', (input) => {
    expect(infoHashToMagnetUri(input)).toBeNull()
  })
})

describe('normalizeMagnetInputLines', () => {
  it('expands mixed hash lines while preserving other text and line positions', () => {
    const url = `https://example.com/${HEX_HASH}?sig=A%2Fb%5Cc`
    const magnet = `magnet:?xt=urn:btih:${HEX_HASH.toUpperCase()}&dn=a+b&tr=x&tr=y`
    const input = ` ${HEX_HASH} \r\n\n${url}\n${BASE32_HASH.toLowerCase()}\n bad text \n${magnet}`
    const expected = `magnet:?xt=urn:btih:${HEX_HASH}\n\n${url}\nmagnet:?xt=urn:btih:${BASE32_HASH}\n bad text \n${magnet}`
    expect(normalizeMagnetInputLines(input)).toBe(expected)
    expect(normalizeMagnetInputLines(expected)).toBe(expected)
  })
})
