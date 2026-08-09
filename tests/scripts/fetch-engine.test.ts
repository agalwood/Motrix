import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs without types
import {
  binaryName,
  bundledPath,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_UNSUPPORTED_HOST,
  EXIT_USAGE,
  extractArchive,
  fetchWithRetry,
  installAsset,
  parseArgs,
  parseSha256Sums,
  resolveExtractCommand,
  resolveHostKey,
  run,
  selectKeys,
  sha256Hex,
  verifyDigest,
} from '../../scripts/fetch-engine.mjs'

// A trimmed lockfile shaped exactly like scripts/engine.lock.json but with
// obviously-fake digests — these tests only exercise selection/parse logic.
const LOCK = {
  repo: 'motrixapp/aria2',
  tag: 'v1.37.0-motrix.1',
  version: '1.37.0-motrix.1',
  assets: {
    'darwin-arm64': { file: 'a-darwin-arm64.tar.gz', bin: 'aria2c' },
    'darwin-x64': { file: 'a-darwin-x64.tar.gz', bin: 'aria2c' },
    'win32-x64': { file: 'a-win32-x64.zip', bin: 'aria2c.exe' },
    'win32-ia32': { file: 'a-win32-ia32.zip', bin: 'aria2c.exe' },
    'linux-x64': { file: 'a-linux-x64.tar.gz', bin: 'aria2c' },
    'linux-arm64': { file: 'a-linux-arm64.tar.gz', bin: 'aria2c' },
    'linux-arm': { file: 'a-linux-armv7l.tar.gz', bin: 'aria2c' },
  },
}

describe('binaryName', () => {
  it('is aria2c.exe on win32, aria2c elsewhere', () => {
    expect(binaryName('win32')).toBe('aria2c.exe')
    expect(binaryName('darwin')).toBe('aria2c')
    expect(binaryName('linux')).toBe('aria2c')
  })
})

describe('bundledPath', () => {
  it('joins extraDir/platform/arch/binary', () => {
    expect(bundledPath('/x/extra', 'darwin', 'arm64')).toBe(
      path.join('/x/extra', 'darwin', 'arm64', 'aria2c')
    )
    expect(bundledPath('/x/extra', 'win32', 'x64')).toBe(
      path.join('/x/extra', 'win32', 'x64', 'aria2c.exe')
    )
  })
})

describe('resolveHostKey', () => {
  it('concatenates platform and arch with a dash', () => {
    expect(resolveHostKey('darwin', 'arm64')).toBe('darwin-arm64')
    expect(resolveHostKey('linux', 'arm')).toBe('linux-arm')
  })
})

describe('sha256Hex / verifyDigest', () => {
  it('computes lowercase hex sha256', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
  })

  it('verifyDigest compares case-insensitively against the expected hex', () => {
    const bytes = Buffer.from('hello world')
    const digest = createHash('sha256').update(bytes).digest('hex')
    expect(verifyDigest(bytes, digest)).toBe(true)
    expect(verifyDigest(bytes, digest.toUpperCase())).toBe(true)
    expect(verifyDigest(bytes, `${'0'.repeat(64)}`)).toBe(false)
  })
})

describe('parseSha256Sums', () => {
  it('parses "<hash>  <file>" lines into a lowercased map', () => {
    const text = [
      '9E498107E9A5E27345642FD0AAB1E976279E1E70882931F65634062D5EA1E338  aria2c-1.37.0-motrix.1-darwin-arm64.tar.gz',
      'ea5d4c5c9ffafb2a4bbddfcddb7e9709dbc61b011b7d33d973b145a440a13ef8  aria2c-1.37.0-motrix.1-win32-x64.zip',
      '',
    ].join('\n')
    const map = parseSha256Sums(text)
    expect(map.get('aria2c-1.37.0-motrix.1-darwin-arm64.tar.gz')).toBe(
      '9e498107e9a5e27345642fd0aab1e976279e1e70882931f65634062d5ea1e338'
    )
    expect(map.get('aria2c-1.37.0-motrix.1-win32-x64.zip')).toBe(
      'ea5d4c5c9ffafb2a4bbddfcddb7e9709dbc61b011b7d33d973b145a440a13ef8'
    )
    expect(map.size).toBe(2)
  })

  it('tolerates the "<hash> *<file>" binary-mode marker', () => {
    const map = parseSha256Sums(`${'a'.repeat(64)} *bin.tar.gz`)
    expect(map.get('bin.tar.gz')).toBe('a'.repeat(64))
  })
})

describe('parseArgs', () => {
  it('defaults to host mode with no flags', () => {
    expect(parseArgs([])).toEqual({
      writeLock: false,
      tag: undefined,
      all: false,
      platform: undefined,
      arch: undefined,
      force: false,
    })
  })

  it('parses --all and --force', () => {
    const a = parseArgs(['--all', '--force'])
    expect(a.all).toBe(true)
    expect(a.force).toBe(true)
  })

  it('parses --platform / --arch in both spaced and = forms', () => {
    expect(parseArgs(['--platform', 'linux']).platform).toBe('linux')
    expect(parseArgs(['--platform=win32']).platform).toBe('win32')
    expect(parseArgs(['--arch', 'x64']).arch).toBe('x64')
    expect(parseArgs(['--arch=ia32']).arch).toBe('ia32')
  })

  it('parses --write-lock with an optional --tag', () => {
    const a = parseArgs(['--write-lock', '--tag', 'v2.0.0-motrix.1'])
    expect(a.writeLock).toBe(true)
    expect(a.tag).toBe('v2.0.0-motrix.1')
    expect(parseArgs(['--write-lock', '--tag=v3']).tag).toBe('v3')
  })

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown/i)
  })

  it('throws when a value-taking flag is missing its value', () => {
    expect(() => parseArgs(['--platform'])).toThrow(/--platform/)
  })
})

describe('selectKeys', () => {
  const host = { platform: 'darwin' as NodeJS.Platform, arch: 'arm64' }

  it('host mode returns the single host key', () => {
    expect(selectKeys(LOCK, parseArgs([]), host)).toEqual(['darwin-arm64'])
  })

  it('--all returns every lockfile key', () => {
    expect(selectKeys(LOCK, parseArgs(['--all']), host).sort()).toEqual(
      Object.keys(LOCK.assets).sort()
    )
  })

  it('--platform without --arch returns every arch of that platform', () => {
    expect(
      selectKeys(LOCK, parseArgs(['--platform', 'linux']), host).sort()
    ).toEqual(['linux-arm', 'linux-arm64', 'linux-x64'])
  })

  it('--platform with --arch returns that single key', () => {
    expect(
      selectKeys(
        LOCK,
        parseArgs(['--platform', 'win32', '--arch', 'ia32']),
        host
      )
    ).toEqual(['win32-ia32'])
  })

  it('--arch without --platform pins the host platform to that arch', () => {
    expect(selectKeys(LOCK, parseArgs(['--arch', 'x64']), host)).toEqual([
      'darwin-x64',
    ])
  })

  it('throws when an explicitly requested key is not in the lockfile', () => {
    expect(() =>
      selectKeys(
        LOCK,
        parseArgs(['--platform', 'win32', '--arch', 'arm64']),
        host
      )
    ).toThrow(/win32-arm64/)
  })

  it('throws when a requested platform has no assets', () => {
    expect(() =>
      selectKeys(LOCK, parseArgs(['--platform', 'plan9']), host)
    ).toThrow(/plan9/)
  })
})

// --------------------------------------------------------------------------
// Injected-stub flow tests — network / fs / extract are all stubbed, so these
// exercise installAsset + run without touching the real filesystem or network.
// --------------------------------------------------------------------------

const hex = (s: string) => sha256Hex(Buffer.from(s))

interface Stub {
  deps: Record<string, unknown>
  files: Map<string, Buffer>
  modes: Map<string, number>
  downloads: string[]
  extracted: number
  logs: string[]
  errors: string[]
}

// Build a deps object backed by an in-memory filesystem. `extract` simulates
// tar by dropping the named binary into the work dir. `downloadError`, when
// set, makes every download reject (simulating an offline/failed fetch).
function makeStub(opts: {
  host?: { platform: string; arch: string }
  lock?: unknown
  archive?: Buffer
  binary?: Buffer
  extraDir?: string
  downloadError?: Error
}): Stub {
  const files = new Map<string, Buffer>()
  const modes = new Map<string, number>()
  const downloads: string[] = []
  const logs: string[] = []
  const errors: string[] = []
  let mkdtempCounter = 0
  let extracted = 0
  const stub: Stub = {
    deps: {},
    files,
    modes,
    downloads,
    extracted: 0,
    logs,
    errors,
  }

  stub.deps = {
    host: () => opts.host ?? { platform: 'darwin', arch: 'arm64' },
    extraDir: () => opts.extraDir ?? '/extra',
    readLock: async () => opts.lock ?? null,
    download: async (url: string) => {
      downloads.push(url)
      if (opts.downloadError) throw opts.downloadError
      return opts.archive ?? Buffer.from('ARCHIVE')
    },
    extract: async (_archivePath: string, destDir: string) => {
      extracted += 1
      stub.extracted = extracted
      // Drop both possible binary names; installAsset reads only asset.bin.
      files.set(path.join(destDir, 'aria2c'), opts.binary ?? Buffer.from('BIN'))
      files.set(
        path.join(destDir, 'aria2c.exe'),
        opts.binary ?? Buffer.from('BIN')
      )
    },
    mkdtemp: async (prefix: string) => {
      mkdtempCounter += 1
      return `/work/${prefix}${mkdtempCounter}`
    },
    randomId: () => 'rand',
    fileExists: (p: string) => files.has(p),
    readFile: async (p: string) => {
      const b = files.get(p)
      if (!b) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      }
      return b
    },
    writeFile: async (p: string, data: Buffer) => {
      files.set(p, Buffer.from(data))
    },
    rename: async (from: string, to: string) => {
      const b = files.get(from)
      if (b) files.set(to, b)
      files.delete(from)
      const m = modes.get(from)
      if (m !== undefined) {
        modes.set(to, m)
        modes.delete(from)
      }
    },
    chmod: async (p: string, mode: number) => {
      modes.set(p, mode)
    },
    mkdir: async () => {},
    rm: async (dir: string) => {
      for (const k of [...files.keys()]) if (k.startsWith(dir)) files.delete(k)
    },
    log: (...parts: unknown[]) => {
      logs.push(parts.join(' '))
    },
    logError: (...parts: unknown[]) => {
      errors.push(parts.join(' '))
    },
  }
  return stub
}

describe('installAsset', () => {
  const ARCHIVE = Buffer.from('ARCHIVE-BYTES')
  const BINARY = Buffer.from('BINARY-BYTES')
  const baseAsset = {
    file: 'aria2c-1-darwin-arm64.tar.gz',
    bin: 'aria2c',
    archiveSha256: hex('ARCHIVE-BYTES'),
    binarySha256: hex('BINARY-BYTES'),
  }
  const ctx = {
    key: 'darwin-arm64',
    repo: 'motrixapp/aria2',
    tag: 'v1',
    extraDir: '/extra',
    force: false,
  }
  const target = path.join('/extra', 'darwin', 'arm64', 'aria2c')

  it('downloads, verifies both digests, and atomically installs (0o755)', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    const res = await installAsset({ ...ctx, asset: baseAsset }, s.deps)
    expect(res).toBe('installed')
    expect(s.files.get(target)?.toString()).toBe('BINARY-BYTES')
    expect(s.modes.get(target)).toBe(0o755)
    expect(s.downloads[0]).toBe(
      'https://github.com/motrixapp/aria2/releases/download/v1/' +
        'aria2c-1-darwin-arm64.tar.gz'
    )
  })

  it('skips (no download) when target already matches binarySha256', async () => {
    // archiveSha256 is deliberately WRONG — the skip MUST key on the binary
    // digest, not the archive digest (rev 2 core bug fix).
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    s.files.set(target, BINARY)
    const asset = { ...baseAsset, archiveSha256: 'f'.repeat(64) }
    const res = await installAsset({ ...ctx, asset }, s.deps)
    expect(res).toBe('skipped')
    expect(s.downloads).toHaveLength(0)
  })

  it('re-downloads under --force even when the target matches', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    s.files.set(target, BINARY)
    const res = await installAsset(
      { ...ctx, force: true, asset: baseAsset },
      s.deps
    )
    expect(res).toBe('installed')
    expect(s.downloads).toHaveLength(1)
  })

  it('hard-fails on an archive digest mismatch, without extracting', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    const asset = { ...baseAsset, archiveSha256: '0'.repeat(64) }
    await expect(installAsset({ ...ctx, asset }, s.deps)).rejects.toThrow(
      /archive digest mismatch/
    )
    expect(s.extracted).toBe(0)
    expect(s.files.has(target)).toBe(false)
  })

  it('hard-fails on a binary digest mismatch, without installing', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    const asset = { ...baseAsset, binarySha256: '0'.repeat(64) }
    await expect(installAsset({ ...ctx, asset }, s.deps)).rejects.toThrow(
      /binary digest mismatch/
    )
    expect(s.files.has(target)).toBe(false)
  })

  it('does not chmod on win32', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    const winTarget = path.join('/extra', 'win32', 'x64', 'aria2c.exe')
    const asset = {
      file: 'aria2c-1-win32-x64.zip',
      bin: 'aria2c.exe',
      archiveSha256: hex('ARCHIVE-BYTES'),
      binarySha256: hex('BINARY-BYTES'),
    }
    const res = await installAsset({ ...ctx, key: 'win32-x64', asset }, s.deps)
    expect(res).toBe('installed')
    expect(s.files.get(winTarget)?.toString()).toBe('BINARY-BYTES')
    expect(s.modes.has(winTarget)).toBe(false)
  })

  it('cleans up the staging temp file when the final rename fails', async () => {
    const s = makeStub({ archive: ARCHIVE, binary: BINARY })
    s.deps.rename = async () => {
      throw new Error('EACCES: rename denied')
    }
    await expect(
      installAsset({ ...ctx, asset: baseAsset }, s.deps)
    ).rejects.toThrow(/rename denied/)
    // No `.aria2c.tmp-*` staging artifact may leak in the target dir.
    const leaked = [...s.files.keys()].filter((k) => k.includes('.tmp-'))
    expect(leaked).toEqual([])
    expect(s.files.has(target)).toBe(false)
  })
})

describe('run', () => {
  const ARCHIVE = Buffer.from('A')
  const BINARY = Buffer.from('B')
  const makeLock = (keys: string[]) => ({
    repo: 'motrixapp/aria2',
    tag: 'v1',
    version: '1',
    assets: Object.fromEntries(
      keys.map((key) => {
        const win = key.startsWith('win32')
        return [
          key,
          {
            file: `aria2c-1-${key}.${win ? 'zip' : 'tar.gz'}`,
            bin: win ? 'aria2c.exe' : 'aria2c',
            archiveSha256: hex('A'),
            binarySha256: hex('B'),
          },
        ]
      })
    ),
  })

  it('host mode installs only the host key and returns EXIT_OK', async () => {
    const s = makeStub({
      host: { platform: 'darwin', arch: 'arm64' },
      lock: makeLock(['darwin-arm64', 'linux-x64']),
      archive: ARCHIVE,
      binary: BINARY,
    })
    const code = await run([], s.deps)
    expect(code).toBe(EXIT_OK)
    expect(s.files.has(path.join('/extra', 'darwin', 'arm64', 'aria2c'))).toBe(
      true
    )
    expect(s.files.has(path.join('/extra', 'linux', 'x64', 'aria2c'))).toBe(
      false
    )
  })

  it('returns EXIT_UNSUPPORTED_HOST (soft) for a host absent from the lock', async () => {
    const s = makeStub({
      host: { platform: 'sunos', arch: 'sparc' },
      lock: makeLock(['darwin-arm64']),
    })
    const code = await run([], s.deps)
    expect(code).toBe(EXIT_UNSUPPORTED_HOST)
    expect(s.downloads).toHaveLength(0)
  })

  it('--all installs every lockfile key', async () => {
    const s = makeStub({
      lock: makeLock(['darwin-arm64', 'linux-x64', 'win32-x64']),
      archive: ARCHIVE,
      binary: BINARY,
    })
    const code = await run(['--all'], s.deps)
    expect(code).toBe(EXIT_OK)
    expect(s.downloads).toHaveLength(3)
    expect(s.files.has(path.join('/extra', 'win32', 'x64', 'aria2c.exe'))).toBe(
      true
    )
  })

  it('--platform installs only that platform (host arch irrelevant)', async () => {
    const s = makeStub({
      host: { platform: 'darwin', arch: 'arm64' },
      lock: makeLock(['darwin-arm64', 'linux-x64', 'linux-arm64']),
      archive: ARCHIVE,
      binary: BINARY,
    })
    const code = await run(['--platform', 'linux'], s.deps)
    expect(code).toBe(EXIT_OK)
    expect(s.downloads).toHaveLength(2)
    expect(s.files.has(path.join('/extra', 'darwin', 'arm64', 'aria2c'))).toBe(
      false
    )
  })

  it('returns EXIT_FAILURE when the lockfile is missing', async () => {
    const s = makeStub({ lock: null })
    expect(await run([], s.deps)).toBe(EXIT_FAILURE)
  })

  it('returns EXIT_USAGE on an unknown flag', async () => {
    const s = makeStub({ lock: makeLock(['darwin-arm64']) })
    expect(await run(['--bogus'], s.deps)).toBe(EXIT_USAGE)
  })

  it('prints an actionable MOTRIX_SKIP_ENGINE_FETCH hint when a host fetch fails', async () => {
    const s = makeStub({
      host: { platform: 'darwin', arch: 'arm64' },
      lock: makeLock(['darwin-arm64']),
      downloadError: new Error('getaddrinfo ENOTFOUND github.com'),
    })
    expect(await run([], s.deps)).toBe(EXIT_FAILURE)
    expect(s.errors.some((e) => e.includes('MOTRIX_SKIP_ENGINE_FETCH=1'))).toBe(
      true
    )
  })
})

// A1 — GNU tar (Linux) cannot read a .zip, so extraction must dispatch by
// extension: .zip prefers unzip (falls back to tar only when unzip is absent),
// .tar.gz always uses `tar -xzf`.
describe('resolveExtractCommand', () => {
  it('uses unzip -o for .zip when unzip is available', () => {
    expect(
      resolveExtractCommand('/w/a.zip', '/dest', { unzipAvailable: true })
    ).toEqual({ command: 'unzip', args: ['-o', '/w/a.zip', '-d', '/dest'] })
  })

  it('falls back to tar -xf for .zip when unzip is unavailable', () => {
    expect(
      resolveExtractCommand('/w/a.zip', '/dest', { unzipAvailable: false })
    ).toEqual({ command: 'tar', args: ['-xf', '/w/a.zip', '-C', '/dest'] })
  })

  it('uses tar -xzf for .tar.gz regardless of unzip', () => {
    expect(
      resolveExtractCommand('/w/a.tar.gz', '/dest', { unzipAvailable: true })
    ).toEqual({ command: 'tar', args: ['-xzf', '/w/a.tar.gz', '-C', '/dest'] })
  })
})

// A fake `spawn` that records the command it is asked to run and completes with
// the given exit code on the next microtask.
function fakeSpawn(calls: { command: string; args: string[] }[], code = 0) {
  return (command: string, args: string[]) => {
    calls.push({ command, args })
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {}
    const child = {
      stderr: { on: () => {} },
      on(event: string, cb: (arg?: unknown) => void) {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
        return child
      },
    }
    queueMicrotask(() => {
      for (const cb of listeners.close ?? []) cb(code)
    })
    return child
  }
}

describe('extractArchive (spawn dispatch)', () => {
  it('spawns unzip for a .zip when unzip is available', async () => {
    const calls: { command: string; args: string[] }[] = []
    await extractArchive('/w/a.zip', '/dest', {
      spawn: fakeSpawn(calls),
      unzipAvailable: true,
    })
    expect(calls[0].command).toBe('unzip')
  })

  it('spawns tar (-xzf) for a .tar.gz', async () => {
    const calls: { command: string; args: string[] }[] = []
    await extractArchive('/w/a.tar.gz', '/dest', {
      spawn: fakeSpawn(calls),
      unzipAvailable: true,
    })
    expect(calls[0]).toEqual({
      command: 'tar',
      args: ['-xzf', '/w/a.tar.gz', '-C', '/dest'],
    })
  })

  it('rejects when the spawned extractor exits non-zero', async () => {
    const calls: { command: string; args: string[] }[] = []
    await expect(
      extractArchive('/w/a.tar.gz', '/dest', {
        spawn: fakeSpawn(calls, 1),
        unzipAvailable: false,
      })
    ).rejects.toThrow(/tar exited 1/)
  })
})

// A4 — downloads must have a timeout (AbortController) and retry transient
// failures with backoff, but fail fast on non-transient 4xx.
describe('fetchWithRetry', () => {
  const okResponse = (body: string) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () =>
      Uint8Array.from(Buffer.from(body)).buffer as ArrayBuffer,
  })

  it('returns the body on first success', async () => {
    let calls = 0
    const buf = await fetchWithRetry('https://x/a', {
      fetch: async () => {
        calls += 1
        return okResponse('HELLO')
      },
      retries: 3,
      sleep: async () => {},
    })
    expect(buf.toString()).toBe('HELLO')
    expect(calls).toBe(1)
  })

  it('retries transient network errors up to `retries`, then throws', async () => {
    let calls = 0
    let sleeps = 0
    await expect(
      fetchWithRetry('https://x/a', {
        fetch: async () => {
          calls += 1
          throw new Error('socket hang up')
        },
        retries: 3,
        sleep: async () => {
          sleeps += 1
        },
      })
    ).rejects.toThrow(/failed after 3 attempt\(s\).*socket hang up/s)
    expect(calls).toBe(3)
    expect(sleeps).toBe(2)
  })

  it('retries a 500 then succeeds', async () => {
    let calls = 0
    const buf = await fetchWithRetry('https://x/a', {
      fetch: async () => {
        calls += 1
        if (calls === 1) return { ok: false, status: 500, statusText: 'ERR' }
        return okResponse('OK2')
      },
      retries: 3,
      sleep: async () => {},
    })
    expect(buf.toString()).toBe('OK2')
    expect(calls).toBe(2)
  })

  it('does NOT retry a non-transient 404', async () => {
    let calls = 0
    await expect(
      fetchWithRetry('https://x/missing', {
        fetch: async () => {
          calls += 1
          return { ok: false, status: 404, statusText: 'Not Found' }
        },
        retries: 3,
        sleep: async () => {},
      })
    ).rejects.toThrow(/HTTP 404/)
    expect(calls).toBe(1)
  })

  it('aborts a stalled request via the timeout and retries', async () => {
    let calls = 0
    // fetch never resolves on its own — it only rejects when the injected
    // timeout fires controller.abort().
    const buf = await fetchWithRetry('https://x/slow', {
      fetch: (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          calls += 1
          if (calls === 2) {
            resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              arrayBuffer: async () =>
                Uint8Array.from(Buffer.from('LATE')).buffer as ArrayBuffer,
            })
            return
          }
          opts.signal.addEventListener('abort', () =>
            reject(new Error('aborted'))
          )
        }),
      timeoutMs: 5,
      retries: 3,
      sleep: async () => {},
    })
    expect(buf.toString()).toBe('LATE')
    expect(calls).toBe(2)
  })
})
