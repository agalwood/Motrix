import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import type { SpawnLike } from './ytdlp-locator'

export const YTDLP_OUTPUT_LIMITS = Object.freeze({
  stdout: 16 * 1024 * 1024,
  stderr: 64 * 1024,
})

export class YtdlpExecutionError extends Error {
  constructor(readonly reason: 'timeout' | 'output-limit' | 'spawn-failed') {
    super(`Media extractor ${reason}`)
    this.name = 'YtdlpExecutionError'
  }
}

export function throwIfYtdlpAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  // A caller's abort reason can contain URLs or credentials. Never propagate it.
  const error = new Error('Media extraction cancelled')
  error.name = 'AbortError'
  throw error
}

export function isYtdlpAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function canonicalPublicMediaUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: batch input must contain exactly one URL
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return null
    // yt-dlp/Python interpret raw backslashes differently from WHATWG URL.
    // Policy and the external process must receive exactly the same authority.
    return url.href
  } catch {
    return null
  }
}

export function isPublicMediaUrl(value: string): boolean {
  return canonicalPublicMediaUrl(value) !== null
}

/** No inherited proxy, browser credentials, config, plugin, or persistent cache. */
export function safeYtdlpArgs(proxy?: string): string[] | null {
  const target = proxy?.trim() ?? ''
  if (target) {
    try {
      const url = new URL(target)
      if (
        !['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== '' && url.pathname !== '/')
      )
        return null
    } catch {
      return null
    }
  }
  return [
    '--ignore-config',
    '--no-config-locations',
    '--no-cookies',
    '--no-cookies-from-browser',
    '--no-cache-dir',
    '--no-plugin-dirs',
    '--no-remote-components',
    '--skip-download',
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    '--fragment-retries',
    '2',
    '--extractor-retries',
    '2',
    // Explicitly empty disables ambient HTTP_PROXY/ALL_PROXY discovery.
    '--proxy',
    target,
    // URLs can themselves contain signed credentials. Send them over stdin.
    '--batch-file',
    '-',
  ]
}

function executionEnvironment(args: readonly string[]): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(?:http|https|all|no)_proxy$/i.test(name)) delete env[name]
  }
  const proxyIndex = args.indexOf('--proxy')
  const proxy = proxyIndex >= 0 ? args[proxyIndex + 1] : undefined
  if (proxy) {
    // urllib's proxy_bypass uses environment/system settings even when a
    // ProxyHandler is explicitly configured. A nonempty explicit environment
    // and no bypass list keep it on the same app-selected proxy as requests.
    env.http_proxy = proxy
    env.https_proxy = proxy
    env.all_proxy = proxy
    env.no_proxy = ''
  }
  return env
}

function killProcessTree(child: ReturnType<SpawnLike>): void {
  const killDirect = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* The process already exited. */
    }
  }
  if (!child.pid) {
    killDirect()
    return
  }
  if (process.platform !== 'win32') {
    try {
      // The child owns a separate process group, including extractor runtimes
      // and wrappers' descendants that inherit the output pipes.
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      killDirect()
    }
    return
  }
  try {
    const taskkill = path.win32.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe'
    )
    const killer = nodeSpawn(
      taskkill,
      ['/PID', String(child.pid), '/T', '/F'],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: executionEnvironment([]),
      }
    )
    killer.once('error', killDirect)
    killer.once('exit', (code) => {
      if (code !== 0) killDirect()
    })
  } catch {
    killDirect()
  }
}

/** Bounded process I/O; failures never expose subprocess output or arguments. */
export function spawnResolve(
  binaryPath: string,
  args: readonly string[],
  timeoutMs: number,
  spawnImpl: SpawnLike,
  options: { signal?: AbortSignal; input: string }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  throwIfYtdlpAborted(options.signal)
  return new Promise((resolve, reject) => {
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = {
      stdout: [],
      stderr: [],
    }
    const sizes = { stdout: 0, stderr: 0 }
    let settled = false
    let failure: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<SpawnLike>
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      chunks.stdout.length = 0
      chunks.stderr.length = 0
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const stop = (error: Error) => {
      if (settled || failure) return
      failure = error
      clearTimeout(timer)
      killProcessTree(child)
      // Keep the promise pending until close: admission must not open another
      // slot while the terminated process still owns its output pipes.
    }
    const abort = () => {
      try {
        throwIfYtdlpAborted(options.signal)
      } catch (error) {
        stop(error as Error)
      }
    }
    try {
      child = spawnImpl(binaryPath, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: executionEnvironment(args),
      })
    } catch {
      fail(new YtdlpExecutionError('spawn-failed'))
      return
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk) => {
        if (settled || failure) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (buffer.byteLength > YTDLP_OUTPUT_LIMITS[stream] - sizes[stream]) {
          stop(new YtdlpExecutionError('output-limit'))
          return
        }
        sizes[stream] += buffer.byteLength
        chunks[stream].push(buffer)
      })
    }
    child.on('error', () =>
      fail(failure ?? new YtdlpExecutionError('spawn-failed'))
    )
    child.on('close', (code) => {
      if (settled) return
      if (failure) {
        fail(failure)
        return
      }
      const result = {
        code,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      }
      settled = true
      cleanup()
      resolve(result)
    })
    timer = setTimeout(
      () => stop(new YtdlpExecutionError('timeout')),
      timeoutMs
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    if (!child.stdin && options.input.length === 0) return
    if (!child.stdin) {
      stop(new YtdlpExecutionError('spawn-failed'))
      return
    }
    child.stdin.on?.('error', () =>
      stop(new YtdlpExecutionError('spawn-failed'))
    )
    try {
      child.stdin.end(options.input)
    } catch {
      stop(new YtdlpExecutionError('spawn-failed'))
    }
  })
}
