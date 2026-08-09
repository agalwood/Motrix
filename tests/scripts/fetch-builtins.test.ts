import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — .mjs without types
import {
  downloadBytes,
  parseLock,
  releaseUrl,
  resolveArtifact,
  resolveSignature,
  verifyDigest,
  verifySignature,
} from '../../scripts/fetch-builtins.mjs'

const LOCK = {
  repo: 'motrixapp/builtin-plugins',
  plugins: {
    'motrix.test-plugin': {
      tag: 'motrix.test-plugin@1.0.0',
      version: '1.0.0',
      file: 'motrix.test-plugin-1.0.0.moext',
      sha256: '',
      size: 3,
    },
  },
}
const BYTES = Buffer.from('abc')
LOCK.plugins['motrix.test-plugin'].sha256 = createHash('sha256')
  .update(BYTES)
  .digest('hex')

describe('parseLock', () => {
  it('accepts a well-formed lockfile', () => {
    expect(parseLock(JSON.stringify(LOCK)).repo).toBe(
      'motrixapp/builtin-plugins'
    )
  })
  it('rejects entries missing sha256', () => {
    const bad = structuredClone(LOCK)
    bad.plugins['motrix.test-plugin'].sha256 = ''
    expect(() => parseLock(JSON.stringify(bad))).toThrow(/sha256/)
  })
})

describe('parseLock rejects malicious shapes', () => {
  const base = structuredClone(LOCK)
  it('rejects a path-traversal id key', () => {
    const bad = {
      repo: base.repo,
      plugins: { '../../src': base.plugins['motrix.test-plugin'] },
    }
    expect(() => parseLock(JSON.stringify(bad))).toThrow(/illegal plugin id/)
  })
  it('rejects a non-canonical file field', () => {
    const bad = structuredClone(base)
    bad.plugins['motrix.test-plugin'].file = '../evil.moext'
    expect(() => parseLock(JSON.stringify(bad))).toThrow(/canonical name/)
  })
  it('rejects an empty plugins map', () => {
    expect(() =>
      parseLock(JSON.stringify({ repo: base.repo, plugins: {} }))
    ).toThrow(/empty/)
  })
  it('rejects a backslash-smuggling version', () => {
    const bad = structuredClone(base)
    bad.plugins['motrix.test-plugin'].version = '1.0.0\\..\\..\\x'
    // keep file canonical to that version so only the backslash guard trips
    bad.plugins['motrix.test-plugin'].file =
      `motrix.test-plugin-${bad.plugins['motrix.test-plugin'].version}.moext`
    expect(() => parseLock(JSON.stringify(bad))).toThrow(/backslash/)
  })
  it('rejects a size beyond the 5 MiB pack cap (TOTAL_MAX)', () => {
    // TOTAL_MAX isn't exported from fetch-builtins.mjs; 6 MiB is well past
    // its 5<<20 value either way, so the assertion doesn't need the export.
    const bad = structuredClone(base)
    bad.plugins['motrix.test-plugin'].size = 6 * 1024 * 1024
    expect(() => parseLock(JSON.stringify(bad))).toThrow(
      /size must be a positive integer/
    )
  })
})

describe('verifyDigest', () => {
  it('matches lowercase hex', () => {
    expect(verifyDigest(BYTES, LOCK.plugins['motrix.test-plugin'].sha256)).toBe(
      true
    )
    expect(
      verifyDigest(
        Buffer.from('abd'),
        LOCK.plugins['motrix.test-plugin'].sha256
      )
    ).toBe(false)
  })
})

describe('resolveArtifact', () => {
  const entry = LOCK.plugins['motrix.test-plugin']

  it('prefers the local artifact dir and verifies digest', async () => {
    const deps = {
      readLocal: vi.fn(async () => BYTES),
      readCache: vi.fn(),
      download: vi.fn(),
      writeCache: vi.fn(async () => {}),
    }
    const got = await resolveArtifact(entry, LOCK.repo, deps, '/artifacts')
    expect(got.equals(BYTES)).toBe(true)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('rejects a local artifact with a wrong digest (no fallback)', async () => {
    const deps = {
      readLocal: vi.fn(async () => Buffer.from('evil')),
      readCache: vi.fn(),
      download: vi.fn(),
      writeCache: vi.fn(async () => {}),
    }
    await expect(
      resolveArtifact(entry, LOCK.repo, deps, '/artifacts')
    ).rejects.toThrow(/digest/)
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('falls through cache miss to download, verifies, then caches', async () => {
    const deps = {
      readLocal: vi.fn(async () => null),
      readCache: vi.fn(async () => null),
      download: vi.fn(async (url: string) => {
        expect(url).toBe(
          'https://github.com/motrixapp/builtin-plugins/releases/download/motrix.test-plugin%401.0.0/motrix.test-plugin-1.0.0.moext'
        )
        return BYTES
      }),
      writeCache: vi.fn(async () => {}),
    }
    const got = await resolveArtifact(entry, LOCK.repo, deps, undefined)
    expect(got.equals(BYTES)).toBe(true)
    expect(deps.writeCache).toHaveBeenCalled()
  })

  it('rejects a tampered download', async () => {
    const deps = {
      readLocal: vi.fn(async () => null),
      readCache: vi.fn(async () => null),
      download: vi.fn(async () => Buffer.from('evil')),
      writeCache: vi.fn(async () => {}),
    }
    await expect(
      resolveArtifact(entry, LOCK.repo, deps, undefined)
    ).rejects.toThrow(/digest/)
    expect(deps.writeCache).not.toHaveBeenCalled()
  })

  it('rejects a tampered cache entry (no silent fallthrough to download)', async () => {
    const deps = {
      readLocal: vi.fn(async () => null),
      readCache: vi.fn(async () => Buffer.from('TAMPERED')),
      download: vi.fn(),
      writeCache: vi.fn(async () => {}),
    }
    await expect(
      resolveArtifact(entry, LOCK.repo, deps, undefined)
    ).rejects.toThrow(/digest/)
    expect(deps.download).not.toHaveBeenCalled()
  })
})

describe('verifySignature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const sig = signBytes(null, BYTES, privateKey).toString('base64')

  it('accepts a valid detached signature', () => {
    expect(verifySignature(BYTES, sig, pubPem)).toBe(true)
    // trailing whitespace from a text sidecar must not break verification
    expect(verifySignature(BYTES, `${sig}\n`, pubPem)).toBe(true)
  })

  it('rejects tampered bytes', () => {
    expect(verifySignature(Buffer.from('abd'), sig, pubPem)).toBe(false)
  })

  it('rejects a signature minted by a different key', () => {
    const other = generateKeyPairSync('ed25519')
    const otherSig = signBytes(null, BYTES, other.privateKey).toString('base64')
    expect(verifySignature(BYTES, otherSig, pubPem)).toBe(false)
  })

  it('rejects empty or garbage signature text', () => {
    expect(verifySignature(BYTES, '', pubPem)).toBe(false)
    expect(verifySignature(BYTES, '!!!not-base64!!!', pubPem)).toBe(false)
  })

  it('rejects a garbage public key instead of throwing', () => {
    expect(verifySignature(BYTES, sig, 'not a pem')).toBe(false)
  })
})

describe('resolveSignature', () => {
  const entry = LOCK.plugins['motrix.test-plugin']

  it('prefers the local artifact dir sidecar', async () => {
    const deps = {
      readLocal: vi.fn(async (p: string) => {
        expect(p).toBe('/artifacts/motrix.test-plugin-1.0.0.moext.sig')
        return Buffer.from('local-sig')
      }),
      readCacheSig: vi.fn(),
      download: vi.fn(),
    }
    const got = await resolveSignature(entry, LOCK.repo, deps, '/artifacts')
    expect(got).toBe('local-sig')
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('falls through cache miss to the release .sig URL', async () => {
    const deps = {
      readLocal: vi.fn(async () => null),
      readCacheSig: vi.fn(async () => null),
      download: vi.fn(async (url: string) => {
        expect(url).toBe(
          'https://github.com/motrixapp/builtin-plugins/releases/download/motrix.test-plugin%401.0.0/motrix.test-plugin-1.0.0.moext.sig'
        )
        return Buffer.from('remote-sig')
      }),
    }
    const got = await resolveSignature(entry, LOCK.repo, deps, undefined)
    expect(got).toBe('remote-sig')
  })

  it('propagates a missing sidecar (download failure) as a hard error', async () => {
    const deps = {
      readLocal: vi.fn(async () => null),
      readCacheSig: vi.fn(async () => null),
      download: vi.fn(async () => {
        throw new Error('GET .sig -> 404')
      }),
    }
    await expect(
      resolveSignature(entry, LOCK.repo, deps, undefined)
    ).rejects.toThrow(/404/)
  })
})

describe('releaseUrl', () => {
  it('percent-encodes both the tag and the file segment', () => {
    const entry = LOCK.plugins['motrix.test-plugin']
    const url = releaseUrl(LOCK.repo, entry)
    expect(url).not.toContain('\\')
    expect(url).toBe(
      'https://github.com/motrixapp/builtin-plugins/releases/download/motrix.test-plugin%401.0.0/motrix.test-plugin-1.0.0.moext'
    )
  })
})

// Fake a fetch Response with a streamable body (a WHATWG ReadableStream
// reader, as undici's global fetch provides via `res.body.getReader()`) so
// downloadBytes' chunk-by-chunk overflow guard can be driven without a real
// network call.
function fakeStreamResponse(
  chunks: Uint8Array[],
  { contentLength }: { contentLength?: number } = {}
) {
  let i = 0
  const read = vi.fn(async () => {
    if (i >= chunks.length) return { done: true, value: undefined }
    return { done: false, value: chunks[i++] }
  })
  const cancel = vi.fn(async () => {})
  return {
    response: {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name === 'content-length' && contentLength != null
            ? String(contentLength)
            : null,
      },
      body: { getReader: () => ({ read, cancel }) },
    },
    read,
    cancel,
  }
}

describe('downloadBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams a body within sizeCap and returns the concatenated bytes', async () => {
    const { response } = fakeStreamResponse([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    const bytes = await downloadBytes('https://example.test/f.moext', 10)
    expect(Buffer.from(bytes).equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
  })

  it('aborts as soon as the streamed total exceeds sizeCap, without reading the whole body', async () => {
    // 3 chunks of 3 bytes each (9B total) against a 5B cap: the running
    // total crosses the cap after the 2nd chunk, so the 3rd must never be
    // requested from the reader — that's the pre-verification-OOM guard.
    const chunks = [new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)]
    const { response, read, cancel } = fakeStreamResponse(chunks)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    await expect(
      downloadBytes('https://example.test/big.moext', 5)
    ).rejects.toThrow(/exceeds lock size/)
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalled()
  })

  it('rejects on an over-cap Content-Length before reading any body chunk', async () => {
    const { response, read } = fakeStreamResponse([new Uint8Array(3)], {
      contentLength: 999,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    )
    await expect(
      downloadBytes('https://example.test/big.moext', 5)
    ).rejects.toThrow(/Content-Length/)
    expect(read).not.toHaveBeenCalled()
  })
})
