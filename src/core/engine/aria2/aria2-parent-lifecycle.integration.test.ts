// @vitest-environment node
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DEFAULT_ENGINE_SETTINGS } from '@core/settings/validators'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  resolveBundledAria2,
  waitForRpc,
} from '@test-utils/aria2'
import { describe, expect, it } from 'vitest'
import { Aria2ConfigBuilder } from './aria2-config-builder'

// The disposable host owns aria2 and its output pipes, just like either
// production shell. The test runner survives its SIGKILL to observe recovery.
const hostSource = `
  const { spawn } = require('node:child_process')
  process.once('message', ({ binary, args }) => {
    const engine = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    engine.stdout.on('data', () => {})
    engine.stderr.on('data', () => {})
    engine.once('spawn', () => process.send({ pid: engine.pid }))
    engine.once('error', (error) => process.send({ error: error.message }))
  })
  setInterval(() => {}, 1000)
`

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

function portIsListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

async function stopHost(host: ChildProcess): Promise<void> {
  if (host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit', { signal: AbortSignal.timeout(5_000) })
  host.kill('SIGKILL')
  await exited
}

function stopEngine(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function engineIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    if (process.platform === 'linux') {
      // An orphan can briefly remain a zombie until its new parent reaps it.
      // It has already exited and cannot hold sockets or write session data.
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !['Z', 'X'].includes(
        stat.slice(stat.lastIndexOf(') ') + 2, stat.lastIndexOf(') ') + 3)
      )
    }
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH' || code === 'ENOENT') return false
    throw error
  }
}

describe.skipIf(!bundledAria2Exists() || !canBindLoopbackTcp())(
  'aria2 host crash recovery',
  () => {
    it.each([false, true])(
      'survives only while its watched host is alive (watch=%s)',
      async (watch) => {
        const root = await mkdtemp(path.join(tmpdir(), 'motrix-parent-watch-'))
        const port = await availablePort()
        const secret = 'isolated-parent-watch-test'
        const host = spawn(process.execPath, ['-e', hostSource], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        })
        let enginePid: number | undefined
        try {
          await once(host, 'spawn')
          if (!host.pid) throw new Error('No host PID')
          // A stale advanced config must not override the host's L1 argument.
          await writeFile(
            path.join(root, 'aria2.conf'),
            watch ? `stop-with-process=${process.pid}\n` : ''
          )
          const builder = new Aria2ConfigBuilder('', root, {
            supervisorPid: watch ? host.pid : undefined,
          })
          const args = builder.buildArgs(
            {
              ...DEFAULT_ENGINE_SETTINGS,
              rpcPort: port,
              rpcSecret: secret,
              dhtEnabled: false,
            },
            false,
            null,
            { download: 0, upload: 0 },
            root
          )
          args.push(
            '--disable-ipv6=true',
            '--summary-interval=0',
            `--log=${path.join(root, 'engine.log')}`,
            '--log-level=info'
          )
          const spawned = once(host, 'message', {
            signal: AbortSignal.timeout(5_000),
          })
          host.send({ binary: resolveBundledAria2(), args })
          const [message] = await spawned
          if (typeof message.pid !== 'number') throw new Error(message.error)
          enginePid = message.pid
          await waitForRpc(port, 5_000, secret)
          // Cross a watcher tick before crashing the host; an incorrect PID
          // must fail here rather than accidentally passing the exit assertion.
          await delay(1_500)
          await waitForRpc(port, 1_000, secret)
          const uri = `http://127.0.0.1:${port}/paused-download.bin`
          const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
            method: 'POST',
            signal: AbortSignal.timeout(2_000),
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'aria2.addUri',
              params: [`token:${secret}`, [uri], { pause: 'true' }],
            }),
          })
          expect(await response.json()).toMatchObject({
            result: expect.any(String),
          })
          await stopHost(host)

          if (watch) {
            await expect
              .poll(() => portIsListening(port), { timeout: 8_000 })
              .toBe(false)
            await expect
              .poll(
                async () => readFile(path.join(root, 'aria2.session'), 'utf8'),
                {
                  timeout: 3_000,
                }
              )
              .toContain(uri)
            expect(
              await readFile(path.join(root, 'engine.log'), 'utf8')
            ).toContain(
              `Process ${host.pid} is not running. Commencing shutdown.`
            )
            await expect
              .poll(() => engineIsRunning(message.pid), { timeout: 3_000 })
              .toBe(false)
          } else {
            // The control proves that host termination / pipe closure alone
            // does not account for the successful cleanup in the watched case.
            await delay(2_000)
            await waitForRpc(port, 1_000, secret)
          }
        } finally {
          await stopHost(host)
          if (enginePid !== undefined && (await engineIsRunning(enginePid))) {
            stopEngine(enginePid)
            await expect.poll(() => portIsListening(port)).toBe(false)
          }
          await rm(root, { recursive: true, force: true })
        }
      },
      25_000
    )
  }
)
