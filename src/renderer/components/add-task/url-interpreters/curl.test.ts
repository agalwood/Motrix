import { describe, expect, it } from 'vitest'
import { curlInterpreter } from './curl'

function interpret(text: string) {
  return curlInterpreter.tryInterpret(text)
}

// Assertion helper for tests that assume tryInterpret succeeds. Throws with
// the input on failure so test output points to the exact regression rather
// than the generic "cannot read properties of null" from `!`.
function interpretOrFail(
  text: string
): NonNullable<ReturnType<typeof interpret>> {
  const r = interpret(text)
  if (r === null) throw new Error(`curlInterpreter rejected: ${text}`)
  return r
}

describe('curlInterpreter — detection', () => {
  it('returns null when text does not start with curl', () => {
    expect(interpret('https://a/b')).toBeNull()
  })

  it('detects leading curl command', () => {
    expect(interpret('curl https://a/b')).not.toBeNull()
  })

  it('detects curl with leading whitespace', () => {
    expect(interpret('   curl  "https://a/b"  ')).not.toBeNull()
  })
})

describe('curlInterpreter — URL extraction', () => {
  it('extracts URL from bare form', () => {
    const r = interpretOrFail('curl https://a/b')
    expect(r.urls).toEqual(['https://a/b'])
  })

  it('extracts quoted URL', () => {
    const r = interpretOrFail(`curl "https://a/b"`)
    expect(r.urls).toEqual(['https://a/b'])
  })

  it('extracts single-quoted URL', () => {
    const r = interpretOrFail(`curl 'https://a/b'`)
    expect(r.urls).toEqual(['https://a/b'])
  })
})

describe('curlInterpreter — headers', () => {
  it('extracts -H headers', () => {
    const r = interpretOrFail(`curl -H "User-Agent: Mozilla/5.0" https://a/b`)
    expect(r.headers).toEqual({ 'User-Agent': 'Mozilla/5.0' })
  })

  it('extracts multiple -H headers', () => {
    const r = interpretOrFail(
      `curl -H "User-Agent: UA" -H "Cookie: k=v" https://a/b`
    )
    expect(r.headers).toEqual({ 'User-Agent': 'UA', Cookie: 'k=v' })
  })

  it('extracts --header long form', () => {
    const r = interpretOrFail(`curl --header "Accept: */*" https://a/b`)
    expect(r.headers).toEqual({ Accept: '*/*' })
  })

  it('extracts -A user-agent shorthand', () => {
    const r = interpretOrFail(`curl -A "CustomUA/1.0" https://a/b`)
    expect(r.headers).toEqual({ 'User-Agent': 'CustomUA/1.0' })
  })

  it('extracts --user-agent long form', () => {
    const r = interpretOrFail(`curl --user-agent "UA" https://a/b`)
    expect(r.headers).toEqual({ 'User-Agent': 'UA' })
  })

  it('extracts -e referer shorthand', () => {
    const r = interpretOrFail(`curl -e "https://ref" https://a/b`)
    expect(r.headers).toEqual({ Referer: 'https://ref' })
  })

  it('extracts --referer long form', () => {
    const r = interpretOrFail(`curl --referer "https://ref" https://a/b`)
    expect(r.headers).toEqual({ Referer: 'https://ref' })
  })

  it('extracts -b cookie shorthand', () => {
    const r = interpretOrFail(`curl -b "k=v; k2=v2" https://a/b`)
    expect(r.headers).toEqual({ Cookie: 'k=v; k2=v2' })
  })

  it('extracts --cookie long form', () => {
    const r = interpretOrFail(`curl --cookie "k=v" https://a/b`)
    expect(r.headers).toEqual({ Cookie: 'k=v' })
  })

  it('extracts -u user into Authorization: Basic', () => {
    const r = interpretOrFail(`curl -u "user:pass" https://a/b`)
    expect(r.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Basic /),
    })
  })
})

describe('curlInterpreter — proxy and output', () => {
  it('extracts -x proxy', () => {
    const r = interpretOrFail(`curl -x "http://p:8080" https://a/b`)
    expect(r.proxy).toBe('http://p:8080')
  })

  it('extracts --proxy long form', () => {
    const r = interpretOrFail(`curl --proxy "http://p" https://a/b`)
    expect(r.proxy).toBe('http://p')
  })

  it('extracts -o filename', () => {
    const r = interpretOrFail(`curl -o "out.bin" https://a/b`)
    expect(r.filename).toBe('out.bin')
  })

  it('extracts --output long form', () => {
    const r = interpretOrFail(`curl --output "out.bin" https://a/b`)
    expect(r.filename).toBe('out.bin')
  })
})

describe('curlInterpreter — composite', () => {
  it('handles copy-as-curl from Chrome DevTools', () => {
    const text = `curl 'https://example.com/file.zip' \\
  -H 'authority: example.com' \\
  -H 'user-agent: Mozilla/5.0' \\
  -H 'cookie: session=abc'`
    const r = interpretOrFail(text)
    expect(r.urls).toEqual(['https://example.com/file.zip'])
    expect(r.headers).toMatchObject({
      'user-agent': 'Mozilla/5.0',
      cookie: 'session=abc',
    })
    expect(r.userNotice?.messageKey).toBe('task.add.interpretedCurl')
  })

  it('ignores -X method flag (lowercase)', () => {
    const r = interpretOrFail(`curl -X GET https://a/b`)
    expect(r.urls).toEqual(['https://a/b'])
  })

  it('ignores unknown flags gracefully', () => {
    const r = interpretOrFail(`curl --silent --fail https://a/b`)
    expect(r.urls).toEqual(['https://a/b'])
  })
})
