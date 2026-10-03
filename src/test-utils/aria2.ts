// Integration test harness: spawns a real aria2c process against the bundled
// binary at `extra/<platform>/<arch>/aria2c` and exposes helpers to construct
// a full Aria2Adapter wired to it.
//
// Used by L3 integration tests that exercise aria2 behaviour end-to-end.
// Gated on binary presence via `bundledAria2Exists()` so tests skip cleanly
// on platforms that do not ship the binary.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { aria2BinaryName } from '@shared/platform/aria2'
import { Aria2Adapter } from '../core/engine/aria2/aria2-adapter'
import { Aria2RpcClient } from '../core/engine/aria2/aria2-rpc-client'
import { JsonRpcProtocol } from '../core/engine/aria2/json-rpc-protocol'
import { WebSocketTransport } from '../core/engine/aria2/web-socket-transport'

export interface Aria2Handle {
  proc: ChildProcess
  port: number
  secret: string
  kill(): Promise<void>
}

export interface SpawnAria2Options {
  baseDir: string
  /** Optional explicit binary for compatibility tests against older engines. */
  binaryPath?: string
  /** Additional engine flags for focused integration scenarios. */
  extraArgs?: readonly string[]
  port?: number
  secret?: string
  waitForHttpRpc?: boolean
}

// Resolve the bundled binary path relative to the repo root.
// `src/test-utils/` sits two levels below the repo root.
const REPO_ROOT = path.resolve(__dirname, '../..')
const EXTRA_DIR = path.resolve(REPO_ROOT, 'extra')

export function bundledAria2ExtraDir(): string {
  return EXTRA_DIR
}

export function resolveBundledAria2(): string {
  if (process.env.MOTRIX_ARIA2_TEST_BIN) {
    return path.resolve(process.env.MOTRIX_ARIA2_TEST_BIN)
  }
  return path.join(
    EXTRA_DIR,
    process.platform,
    process.arch,
    aria2BinaryName(process.platform)
  )
}

/** Returns true iff the bundled aria2 binary for the current platform exists. */
export function bundledAria2Exists(): boolean {
  try {
    accessSync(resolveBundledAria2())
    return true
  } catch {
    return false
  }
}

/**
 * Returns true iff the current test process is allowed to bind a loopback TCP
 * port. Some sandboxes allow process spawning but deny `listen(2)`, which makes
 * real aria2 RPC tests impossible even when the bundled binary exists.
 */
export function canBindLoopbackTcp(): boolean {
  const script = `
    const net = require('node:net')
    const server = net.createServer()
    server.on('error', () => process.exit(1))
    server.listen(0, '127.0.0.1', () => {
      server.close(() => process.exit(0))
    })
  `

  const result = spawnSync(process.execPath, ['-e', script], {
    stdio: 'ignore',
    timeout: 3000,
  })

  return result.status === 0
}

/**
 * Spawn a fresh aria2c process for a test suite. The caller MUST invoke
 * `handle.kill()` in `afterAll` to avoid leaking processes.
 */
export async function spawnAria2ForTest(
  opts: SpawnAria2Options
): Promise<Aria2Handle> {
  const port = opts.port ?? (await availablePort())
  const secret = opts.secret ?? randomBytes(24).toString('hex')
  const bin = opts.binaryPath ?? resolveBundledAria2()

  const proc = spawn(
    bin,
    [
      '--no-conf=true',
      '--no-netrc=true',
      '--enable-rpc=true',
      `--rpc-listen-port=${port}`,
      `--rpc-secret=${secret}`,
      '--rpc-allow-origin-all=true',
      '--enable-dht=false',
      '--enable-peer-exchange=false',
      '--bt-save-metadata=true',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--bt-metadata-only=false',
      '--rpc-save-upload-metadata=true',
      '--console-log-level=warn',
      `--dir=${opts.baseDir}`,
      ...(opts.extraArgs ?? []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  // Swallow stdout/stderr so test output stays clean. If a spawn fails we
  // still see the exit code / signal from `proc` itself.
  proc.stdout?.on('data', () => {})
  proc.stderr?.on('data', () => {})
  let spawnError: Error | undefined
  proc.once('error', (error) => {
    spawnError = error
  })
  const failure = () =>
    spawnError ??
    (proc.exitCode !== null || proc.signalCode !== null
      ? new Error('Test aria2 exited before its authenticated RPC was ready')
      : undefined)

  if (opts.waitForHttpRpc !== false) {
    try {
      await waitForRpc(port, 5000, secret, failure)
    } catch (err) {
      // Bail out cleanly if RPC never comes up.
      if (!proc.killed) proc.kill('SIGKILL')
      throw err
    }
  }

  return {
    proc,
    port,
    secret,
    kill: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const hardKill = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL')
          }
        }, 1000)
        hardKill.unref()
        proc.once('exit', () => {
          clearTimeout(hardKill)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    },
  }
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.unref()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) reject(error)
        else if (address && typeof address !== 'string') resolve(address.port)
        else reject(new Error('Unable to reserve a test aria2 port'))
      })
    })
  })
}

/**
 * Poll aria2's RPC endpoint until it responds or the timeout elapses.
 * Uses HTTP POST (simpler than WebSocket for readiness probing).
 */
export async function waitForRpc(
  port: number,
  timeoutMs: number,
  secret?: string,
  processFailure?: () => Error | undefined
): Promise<void> {
  const start = Date.now()
  let lastErr: unknown = null
  while (Date.now() - start < timeoutMs) {
    const failure = processFailure?.()
    if (failure) throw failure
    try {
      const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
        method: 'POST',
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(500, timeoutMs - (Date.now() - start)))
        ),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'probe',
          method: secret ? 'aria2.getVersion' : 'system.listMethods',
          params: secret ? [`token:${secret}`] : [],
        }),
      })
      if (res.ok) {
        const body = (await res.json()) as {
          result?: { version?: unknown }
          error?: unknown
        }
        if (
          !body.error &&
          (secret
            ? typeof body.result?.version === 'string'
            : Array.isArray(body.result))
        ) {
          const failure = processFailure?.()
          if (failure) throw failure
          return
        }
      }
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  const detail = lastErr instanceof Error ? `: ${lastErr.message}` : ''
  throw new Error(`aria2 RPC did not come up within ${timeoutMs}ms${detail}`)
}

/**
 * Build an `Aria2Adapter` connected to a running test aria2. The caller is
 * responsible for disconnecting the transport during cleanup via the returned
 * `disconnect` callback (which tears down the shared WebSocket).
 */
export async function connectAdapter(handle: Aria2Handle): Promise<{
  adapter: Aria2Adapter
  rpc: Aria2RpcClient
  disconnect: () => void
}> {
  const transport = new WebSocketTransport()
  const protocol = new JsonRpcProtocol(transport)
  const rpc = new Aria2RpcClient(transport, protocol, handle.secret)
  await rpc.connect(handle.port)
  const adapter = new Aria2Adapter(rpc)
  await adapter.connect()
  return {
    adapter,
    rpc,
    disconnect: () => rpc.disconnect(),
  }
}
