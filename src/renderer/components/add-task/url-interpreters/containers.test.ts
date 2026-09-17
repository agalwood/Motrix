import { describe, expect, it } from 'vitest'
import { curlInterpreter } from './curl'
import { jsonInterpreter } from './json'

describe('explicit input containers', () => {
  it('rejects oversized containers before importing URLs or request options', () => {
    const oversized = 'x'.repeat(MAX_DOWNLOAD_INPUT_BYTES)
    for (const [interpreter, input] of [
      [jsonInterpreter, JSON.stringify(`https://example.com/${oversized}`)],
      [
        jsonInterpreter,
        JSON.stringify(
          Array(MAX_DOWNLOAD_INPUT_LINES + 1).fill('https://example.com/file')
        ),
      ],
      [
        curlInterpreter,
        `curl https://example.com/file -H 'X-Large: ${oversized}'`,
      ],
    ] as const) {
      expect(interpreter.tryInterpret(input)).toMatchObject({ rejected: true })
    }
  })
  it('decodes a JSON string once and preserves URI escapes', () => {
    expect(
      jsonInterpreter.tryInterpret(
        String.raw`"https:\/\/example.test\/file?sig=%252F\u0026path=one\\two"`
      )
    ).toMatchObject({
      urls: [String.raw`https://example.test/file?sig=%252F&path=one\two`],
    })
    expect(jsonInterpreter.tryInterpret('https://example.test/file')).toBeNull()
  })
  it.each([
    '["https://a/f",42]',
    '"https://a/f',
    '"https://a/f\\nhttps://b/f"',
  ])('retains invalid JSON container %s', (input) => {
    expect(jsonInterpreter.tryInterpret(input)).toMatchObject({
      rejected: true,
    })
  })
  it('preserves Bash single-quote data and double-quote unknown escapes', () => {
    for (const input of [
      String.raw`curl 'https://example.test/f?q=a\b&sig=%2f'`,
      String.raw`curl "https://example.test/f?q=a\b&sig=%2f"`,
    ]) {
      expect(curlInterpreter.tryInterpret(input)).toMatchObject({
        urls: [String.raw`https://example.test/f?q=a\b&sig=%2f`],
      })
    }
  })
  it('imports GET headers, --url and a Bash line continuation', () => {
    expect(
      curlInterpreter.tryInterpret(
        "curl -L -g \\\n --url='https://example.test/a?x=%252F' -H 'X-Signature: token' -X GET"
      )
    ).toMatchObject({
      urls: ['https://example.test/a?x=%252F'],
      headers: { 'X-Signature': 'token' },
    })
  })
  it.each([
    "curl 'https://a/f' -X POST",
    "curl 'https://a/f' --data x",
    "curl -k 'https://a/f'",
    "curl --unknown 'https://a/f'",
    'curl "https://a/$TOKEN"',
    'curl https://a/$(whoami)',
    "curl 'https://a/f",
    'curl.exe https://a/f',
    "curl 'https://a/{one,two}'",
    "curl 'https://a/f' -b cookies.txt",
    "curl 'https://a/f' -u username",
    "curl 'https://a/f' 'https://b/f' -o one.bin",
  ])('does not silently reinterpret %s as a GET', (input) => {
    expect(curlInterpreter.tryInterpret(input)).toMatchObject({
      rejected: true,
    })
  })
})

import {
  MAX_DOWNLOAD_INPUT_BYTES,
  MAX_DOWNLOAD_INPUT_LINES,
} from '@shared/schemas/download-source'
