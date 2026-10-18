import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  safeYtdlpArgs,
  spawnResolve,
  YTDLP_OUTPUT_LIMITS,
} from './ytdlp-execution'
import type { SpawnLike } from './ytdlp-locator'

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
  })
  const spawnImpl = vi.fn(() => child) as unknown as SpawnLike
  return { child, spawnImpl }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('bounded yt-dlp execution', () => {
  it('does not spawn an already-cancelled request or expose its abort reason', () => {
    const { spawnImpl } = fixture()
    const controller = new AbortController()
    controller.abort('PRIVATE_ABORT_REASON')
    expect(() =>
      spawnResolve('fixture', [], 1000, spawnImpl, {
        input: '',
        signal: controller.signal,
      })
    ).toThrow('Media extraction cancelled')
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('kills on cancellation but keeps the request pending until process close', async () => {
    const { child, spawnImpl } = fixture()
    const controller = new AbortController()
    const pending = spawnResolve('fixture', [], 1000, spawnImpl, {
      input: 'https://example.test/\n',
      signal: controller.signal,
    })
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    controller.abort('PRIVATE_ABORT_REASON')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', null)
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Media extraction cancelled',
    })
  })

  it.each(['stdout', 'stderr'] as const)(
    'rejects a single over-limit %s chunk before retaining it',
    async (stream) => {
      const { child, spawnImpl } = fixture()
      const pending = spawnResolve('fixture', [], 1000, spawnImpl, {
        input: '',
      })
      child[stream].emit('data', Buffer.alloc(YTDLP_OUTPUT_LIMITS[stream] + 1))
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      child.emit('close', null)
      await expect(pending).rejects.toMatchObject({ reason: 'output-limit' })
    }
  )

  it('counts bytes in string chunks and refuses the accumulated next byte', async () => {
    const { child, spawnImpl } = fixture()
    const pending = spawnResolve('fixture', [], 1000, spawnImpl, { input: '' })
    child.stderr.emit('data', '界'.repeat(21845)) // 65535 UTF-8 bytes.
    expect(child.kill).not.toHaveBeenCalled()
    child.stderr.emit('data', 'xx')
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('close', 0)
    await expect(pending).rejects.toMatchObject({ reason: 'output-limit' })
  })

  it('kills and reaps on timeout without turning it into cancellation', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = fixture()
    const pending = spawnResolve('fixture', [], 20, spawnImpl, { input: '' })
    vi.advanceTimersByTime(20)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)
    await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
  })

  it.skipIf(process.platform === 'win32')(
    'kills a wrapper process group including descendants holding the pipes',
    { timeout: 5000 },
    async () => {
      const controller = new AbortController()
      let grandchildPid: number | undefined
      const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,process.stderr]}); console.log(child.pid); setInterval(()=>{},1000)`
      const spawnImpl: SpawnLike = (command, args, options) => {
        const child = spawn(command, [...args], options)
        child.stdout?.once('data', (chunk: Buffer) => {
          grandchildPid = Number(chunk.toString().trim())
          controller.abort()
        })
        return child as ReturnType<SpawnLike>
      }
      try {
        await expect(
          spawnResolve(process.execPath, ['-e', script], 2000, spawnImpl, {
            input: '',
            signal: controller.signal,
          })
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(grandchildPid).toBeGreaterThan(0)
        await vi.waitFor(
          () => expect(() => process.kill(grandchildPid!, 0)).toThrow(),
          { timeout: 1000 }
        )
      } finally {
        if (grandchildPid) {
          try {
            process.kill(grandchildPid, 'SIGKILL')
          } catch {
            /* Already reaped. */
          }
        }
      }
    }
  )

  it('replaces ambient proxy bypass with the explicit application proxy', async () => {
    vi.stubEnv('NO_PROXY', '*')
    vi.stubEnv('http_proxy', 'http://unselected.test:80')
    const { child, spawnImpl } = fixture()
    const selected = 'http://127.0.0.1:8080'
    const pending = spawnResolve(
      'fixture',
      safeYtdlpArgs(selected)!,
      1000,
      spawnImpl,
      { input: '' }
    )
    const options = vi.mocked(spawnImpl).mock.calls[0]?.[2]
    expect(options?.env?.NO_PROXY).toBeUndefined()
    expect(options?.env?.no_proxy).toBe('')
    expect(options?.env?.http_proxy).toBe(selected)
    child.emit('close', 0)
    await pending
  })

  it('does not surface raw spawn failures or accept authenticated proxy URLs', async () => {
    const spawnImpl = (() => {
      throw new Error('SECRET in spawnargs')
    }) as SpawnLike
    await expect(
      spawnResolve('fixture', [], 1000, spawnImpl, { input: '' })
    ).rejects.toMatchObject({ message: 'Media extractor spawn-failed' })
    for (const proxy of [
      'http://user:secret@proxy.test:8080',
      'http://proxy.test/?token=secret',
      'file:///secret',
    ])
      expect(safeYtdlpArgs(proxy)).toBeNull()
    for (const proxy of [
      'http://127.0.0.1:8080',
      'socks5://127.0.0.1:1080',
      'socks4://127.0.0.1:1080/',
    ])
      expect(safeYtdlpArgs(proxy)).toContain(proxy)
  })
})

const smokeBinary = process.env.MOTRIX_YTDLP_SMOKE_BINARY
it.skipIf(!smokeBinary)(
  'runs the actual CLI through stdin without config, cookies, cache, or ambient proxy',
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'motrix-ytdlp-public-smoke-')
    )
    const cookies: Array<string | undefined> = []
    const server = createServer((request, response) => {
      cookies.push(request.headers.cookie)
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': '32',
      })
      response.end(Buffer.alloc(32))
    })
    try {
      await mkdir(path.join(dir, 'yt-dlp'))
      await writeFile(
        path.join(dir, 'yt-dlp', 'config'),
        '--add-header Cookie:SYNTHETIC_SECRET\n--cookies-from-browser nonexistent\n'
      )
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address')
      const url = `http://127.0.0.1:${address.port}/clip.mp4?token=synthetic-only`
      const args = safeYtdlpArgs()!
      const spawnImpl: SpawnLike = (command, argv, options) =>
        spawn(command, [...argv], {
          ...options,
          cwd: dir,
          env: {
            ...process.env,
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            HTTP_PROXY: 'http://127.0.0.1:1',
            HTTPS_PROXY: 'http://127.0.0.1:1',
            ALL_PROXY: 'http://127.0.0.1:1',
            ...options.env,
          },
        }) as ReturnType<SpawnLike>
      const result = await spawnResolve(smokeBinary!, args, 10_000, spawnImpl, {
        input: `${url}\n`,
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).url).toBe(url)
      expect(cookies.length).toBeGreaterThan(0)
      expect(cookies.every((cookie) => cookie === undefined)).toBe(true)
      expect(args.join(' ')).not.toContain('synthetic-only')
      expect(result.stderr).not.toContain('SYNTHETIC_SECRET')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.skipIf(!smokeBinary)(
  'keeps the actual urllib backend on the selected proxy despite ambient NO_PROXY',
  { timeout: 20_000 },
  async () => {
    vi.stubEnv('NO_PROXY', '*')
    vi.stubEnv('no_proxy', '*')
    let originHits = 0
    let proxyHits = 0
    const answer = (response: import('node:http').ServerResponse) => {
      response.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': '32',
      })
      response.end(Buffer.alloc(32))
    }
    const origin = createServer((_request, response) => {
      originHits += 1
      answer(response)
    })
    const proxy = createServer((_request, response) => {
      proxyHits += 1
      answer(response)
    })
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    try {
      await listen(origin)
      await listen(proxy)
      const sourceAddress = origin.address()
      const proxyAddress = proxy.address()
      if (
        !sourceAddress ||
        typeof sourceAddress === 'string' ||
        !proxyAddress ||
        typeof proxyAddress === 'string'
      )
        throw new Error('Missing fixture address')
      const url = `http://127.0.0.1:${sourceAddress.port}/clip.mp4`
      const args = safeYtdlpArgs(`http://127.0.0.1:${proxyAddress.port}`)!
      args.push('--compat-options', 'prefer-legacy-http-handler')
      const result = await spawnResolve(
        smokeBinary!,
        args,
        10_000,
        spawn as unknown as SpawnLike,
        { input: `${url}\n` }
      )
      expect(result.code).toBe(0)
      expect(proxyHits).toBeGreaterThan(0)
      expect(originHits).toBe(0)
    } finally {
      await Promise.all(
        [origin, proxy].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve()))
        )
      )
    }
  }
)

it.skipIf(!smokeBinary)(
  'never turns an allowlisted backslash URL into a loopback target in the actual CLI',
  { timeout: 20_000 },
  async () => {
    const { createYtdlpFormatLister } = await import('./ytdlp-formats')
    const { isLikelyMediaSite } = await import('./media-site-allowlist')
    let forbiddenHits = 0
    const authorities: string[] = []
    const forbidden = createServer((_request, response) => {
      forbiddenHits += 1
      response.end('not an allowed media source')
    })
    // This fixture rejects every proxy request and never forwards it to the Internet.
    const proxy = createServer((request, response) => {
      authorities.push(new URL(request.url ?? '').hostname)
      response.writeHead(403)
      response.end()
    })
    proxy.on('connect', (request, socket) => {
      authorities.push((request.url ?? '').split(':')[0] ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    try {
      await listen(forbidden)
      await listen(proxy)
      const forbiddenAddress = forbidden.address()
      const proxyAddress = proxy.address()
      if (
        !forbiddenAddress ||
        typeof forbiddenAddress === 'string' ||
        !proxyAddress ||
        typeof proxyAddress === 'string'
      )
        throw new Error('Missing fixture address')
      const lister = createYtdlpFormatLister({
        resolveBinaryPath: async () => smokeBinary ?? null,
        readOptions: () => ({
          enabled: true,
          allUrls: false,
          proxy: `http://127.0.0.1:${proxyAddress.port}`,
        }),
        isMediaSite: isLikelyMediaSite,
      })
      const url = `http://youtube.com\\@127.0.0.1:${forbiddenAddress.port}/clip.mp4`
      expect(isLikelyMediaSite(url)).toBe(true)
      const result = await lister({ url, audioExtractAvailable: false })
      expect(result.available).toBe(false)
      expect(forbiddenHits).toBe(0)
      expect(authorities).not.toContain('127.0.0.1')
    } finally {
      await Promise.all(
        [forbidden, proxy].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve()))
        )
      )
    }
  }
)
