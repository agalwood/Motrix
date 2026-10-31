import { describe, expect, it } from 'vitest'
import { BDictionary, type BInput, decode, encode } from '../src/index.js'

const utf8 = new TextEncoder()

describe('bounded binary bencode', () => {
  it('roundtrips binary keys, large integers, empty containers and canonical ordering', () => {
    const value = new Map<string | Uint8Array, BInput>([
      [new Uint8Array([255, 0]), [9007199254740993n, -999999999999999999999n]],
      ['__proto__', {}],
      ['a', new Uint8Array([0, 255])],
    ])
    const encoded = encode(value)
    const parsed = decode(encoded)
    expect(encode(parsed.value)).toEqual(encoded)
    expect((parsed.value as BDictionary).get(new Uint8Array([255, 0]))).toEqual(
      [9007199254740993n, -999999999999999999999n]
    )
    expect(parsed.canonical).toBe(true)
  })
  it.each([
    '',
    'i-0e',
    'i01e',
    'i+1e',
    'ie',
    'i1.2e',
    '01:a',
    '1:',
    'd1:ai1e1:ai2ee',
    'di1ei2ee',
    'd1:ble',
    '0:e',
    'l',
  ])('rejects malformed input %j', (input) => {
    expect(() =>
      decode(utf8.encode(input), { allowUnsortedKeys: true })
    ).toThrow()
  })
  it('rejects every truncated prefix of a valid nested document', () => {
    const bytes = encode({
      info: { name: 'a', length: 5, pieces: new Uint8Array(20) },
      x: [[1, -2, 'string']],
    })
    for (let i = 0; i < bytes.length; i++)
      expect(() => decode(bytes.subarray(0, i))).toThrow()
  })
  it('retains exact info range when explicitly accepting old unsorted dictionaries', () => {
    const bytes = utf8.encode('d4:infod1:bi1e1:ai2eee')
    expect(() => decode(bytes)).toThrow(/Unsorted/)
    const decoded = decode(bytes, { allowUnsortedKeys: true })
    expect(decoded.canonical).toBe(false)
    expect(decoded.infoCanonical).toBe(false)
    expect(
      new TextDecoder().decode(bytes.subarray(...decoded.infoRange!))
    ).toBe('d1:bi1e1:ai2ee')
  })
  it('enforces depth, nodes, bytes, string and integer budgets on both codecs', () => {
    for (const options of [
      { maxBytes: 2 },
      { maxDepth: 0 },
      { maxNodes: 1 },
      { maxStringBytes: 1 },
    ]) {
      expect(() => encode(['long'], options)).toThrow()
      expect(() => decode(encode(['long']), options)).toThrow()
    }
    expect(() =>
      decode(utf8.encode('i123e'), { maxIntegerDigits: 2 })
    ).toThrow()
    expect(() => encode(123n, { maxIntegerDigits: 2 })).toThrow()
    expect(() => encode(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    expect(() => decode(utf8.encode('0:'), { maxDepth: 10000 })).toThrow()
    const cycle: BInput[] = []
    cycle.push(cycle)
    expect(() => encode(cycle)).toThrow(/complexity/)
  })
  it('borrows byte strings instead of copying piece tables', () => {
    const bytes = encode(new Uint8Array(10000))
    expect((decode(bytes).value as Uint8Array).buffer).toBe(bytes.buffer)
  })
  it('indexes binary keys by contents while retaining the original entry order', () => {
    const entries = [
      [new Uint8Array([255]), 3n],
      [new Uint8Array([0, 255]), 2n],
      [new Uint8Array(), 0n],
      [new Uint8Array([0]), 1n],
    ] as const
    const dictionary = new BDictionary(entries)
    expect(dictionary.entries).toEqual(entries)
    for (const [key, value] of entries)
      expect(dictionary.get(key.slice())).toBe(value)
    expect(dictionary.get(new Uint8Array([0, 254]))).toBeUndefined()
    expect(dictionary.has(new Uint8Array([255, 0]))).toBe(false)
    expect(
      () => new BDictionary([...entries, [new Uint8Array([0, 255]), 9n]])
    ).toThrow(/Duplicate/)
  })

  it('rejects nonadjacent duplicate keys in compatibility mode', () => {
    expect(() =>
      decode(utf8.encode('d1:bi1e1:ai2e1:bi3ee'), { allowUnsortedKeys: true })
    ).toThrow(/Duplicate/)
    const dictionary = decode(utf8.encode('d1:bi1e1:ai2ee'), {
      allowUnsortedKeys: true,
    }).value as BDictionary
    expect(dictionary.get('a')).toBe(2n)
    expect(dictionary.get('b')).toBe(1n)
    expect(
      dictionary.entries.map(([key]) => new TextDecoder().decode(key))
    ).toEqual(['b', 'a'])
  })

  it('charges dictionary keys and values to the node budget before indexing', () => {
    const bytes = encode({ a: 1, b: 2 })
    expect(() => decode(bytes, { maxNodes: 4 })).toThrow(/complexity/)
    expect((decode(bytes, { maxNodes: 5 }).value as BDictionary).get('b')).toBe(
      2n
    )
  })

  it('property checks canonical roundtrips and deterministic malformed-byte fuzzing', () => {
    let seed = 0x12345678
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed
    }
    const value = (depth: number): BInput => {
      const tag = random() % (depth > 3 ? 3 : 5)
      if (tag === 0) return BigInt(random()) * BigInt(random())
      if (tag === 1)
        return new Uint8Array(
          Array.from({ length: random() % 32 }, () => random() & 255)
        )
      if (tag === 2) return `name-${random()}`
      if (tag === 3)
        return Array.from({ length: random() % 5 }, () => value(depth + 1))
      return { z: value(depth + 1), a: value(depth + 1) }
    }
    for (let i = 0; i < 500; i++) {
      const bytes = encode(value(0))
      expect(encode(decode(bytes).value)).toEqual(bytes)
    }
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(
        Array.from({ length: random() % 128 }, () => random() & 255)
      )
      try {
        const parsed = decode(bytes)
        expect(encode(parsed.value)).toEqual(bytes)
      } catch (error) {
        expect(error).toHaveProperty('name', 'TorrentError')
      }
    }
  })
})
