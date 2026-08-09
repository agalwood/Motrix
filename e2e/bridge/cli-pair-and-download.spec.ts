// E2E acceptance: motrix-cli ↔ Electron app over the MDXP HTTP bridge.
//
// Drives the REAL `motrix` CLI binary (packages/motrix-cli/dist/bin/motrix.js)
// against a REAL packaged Electron app launched by the e2e fixture. Covers the
// two halves the product promises:
//   1. PAIRING  — device-code flow (POST /mdxp/pair/request → in-app approve
//                 via the pending-pair inbox IPC → /mdxp/pair/poll → token).
//   2. INVOCATION — download/add a real file through aria2, observe it reach
//                 `completed`, and confirm `motrix watch` streams SSE events.
// Plus adversarial probes: wrong token → exit 4, one-time token delivery,
// and the deny path.
//
// Approval is performed through `window.motrix.invoke('bridge:resolvePair', …)`
// — byte-identical to what the PendingApprovalsSection "Approve" button calls
// (renderer integration/pair-resolve.ts), exercising the real main-process
// DeviceCodeService.approve → PairingService.issueToken path.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, waitForEngineReady } from '../fixtures/electron-app'
import { startHttpFixture } from '../fixtures/http-server'

// The `motrix` CLI now ships as the published @motrix/cli npm package (a
// devDependency), not an in-tree workspace package. Resolve its bundled entry
// from node_modules so this suite drives the real published artifact.
const CLI_ENTRY = createRequire(import.meta.url).resolve(
  '@motrix/cli/dist/bin/motrix.js'
)

const USER_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface EndpointFile {
  port: number
  pid: number
  localToken: string
}

/** Poll for the bridge `endpoint.json` the app writes after server.start(). */
async function waitForEndpoint(
  userDataDir: string,
  timeoutMs = 40_000
): Promise<EndpointFile> {
  const file = path.join(userDataDir, 'bridge', 'endpoint.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const json = JSON.parse(await readFile(file, 'utf-8')) as EndpointFile
      if (json.port && json.localToken) return json
    } catch {
      // not written yet
    }
    await sleep(200)
  }
  throw new Error(`endpoint.json did not appear under ${userDataDir}/bridge`)
}

/**
 * Invoke a bridge IPC channel from the renderer. The channel + params are
 * passed THROUGH `evaluate`'s argument (serialized into the browser), so the
 * in-page callback references only its own arg — never node-scope symbols.
 * This is the same `window.motrix.invoke` the renderer transport uses.
 */
function bridgeInvoke<T = unknown>(
  page: Page,
  channel: string,
  params?: unknown
): Promise<T> {
  return page.evaluate(
    ({ channel, params }) => {
      const api = (
        window as unknown as {
          motrix: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
        }
      ).motrix
      return params === undefined
        ? api.invoke(channel)
        : api.invoke(channel, params)
    },
    { channel, params }
  ) as Promise<T>
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Spawn the real CLI for a streaming/long-running command. */
function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): {
  proc: ChildProcess
  result: Promise<CliResult>
  stdout: () => string
  stderr: () => string
} {
  const proc = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (d) => {
    stdout += String(d)
  })
  proc.stderr?.on('data', (d) => {
    stderr += String(d)
  })
  const result = new Promise<CliResult>((resolve) => {
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { proc, result, stdout: () => stdout, stderr: () => stderr }
}

/** Run a one-shot CLI command to completion. */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<CliResult> {
  return spawnCli(args, env).result
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

/** Raw JSON POST to a bridge HTTP route (for device-code probes the CLI
 *  doesn't surface, e.g. replaying a poll). */
function httpJson(
  port: number,
  routePath: string,
  body: unknown
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => {
          data += c
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data ? JSON.parse(data) : {},
          })
        )
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

test.describe('motrix-cli ↔ Electron MDXP bridge', () => {
  test('device-code pair: CLI request → inbox → approve → token issued', async ({
    mainWindow,
    userDataDir,
  }) => {
    test.setTimeout(90_000)
    const ep = await waitForEndpoint(userDataDir)
    const baseUrl = `http://127.0.0.1:${ep.port}`

    // Hermetic credentials dir so `motrix pair` doesn't write to the real home.
    const credHome = path.join(userDataDir, 'cli-home')
    await mkdir(path.join(credHome, '.config'), { recursive: true })

    // `pair` blocks polling until approved — spawn it, then approve out of band.
    const pair = spawnCli(
      ['--endpoint', baseUrl, 'pair', '--name', 'e2e-cli'],
      {
        HOME: credHome,
        XDG_CONFIG_HOME: path.join(credHome, '.config'),
      }
    )

    // The branch's headline feature: the request shows up in the pending-pair
    // inbox query (bridge:listPendingPairRequests), token-free.
    let pending: Array<Record<string, unknown>> = []
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      pending = await bridgeInvoke<Array<Record<string, unknown>>>(
        mainWindow,
        'bridge:listPendingPairRequests'
      )
      if (pending.length === 0) await sleep(150)
    }
    expect(pending.length).toBeGreaterThan(0)
    const entry = pending[0]
    expect(String(entry.userCode)).toMatch(USER_CODE_RE)
    expect(entry.clientName).toBe('e2e-cli')
    // Token-free DTO by construction.
    expect(entry).not.toHaveProperty('token')
    expect(entry).not.toHaveProperty('deviceId')

    // CLI printed the same human code on stderr.
    expect(pair.stderr()).toContain(String(entry.userCode))

    // Approve through the exact IPC the inbox "Approve" button calls.
    const requestId = String(entry.requestId)
    const approveResult = await bridgeInvoke(mainWindow, 'bridge:resolvePair', {
      kind: 'cli',
      requestId,
      decision: 'allow',
    })
    expect(approveResult).toEqual({ ok: true })

    // CLI's poll loop receives the token and exits cleanly.
    const res = await pair.result
    expect(res.code, `pair stderr: ${res.stderr}`).toBe(0)

    // The paired cli client is now listed (token still never exposed).
    const paired = await bridgeInvoke<Array<Record<string, unknown>>>(
      mainWindow,
      'bridge:listPaired'
    )
    const cli = paired.find((p) => p.kind === 'cli' && p.name === 'e2e-cli')
    expect(cli, `paired list: ${JSON.stringify(paired)}`).toBeTruthy()

    // Inbox no longer lists the now-approved request.
    const after = await bridgeInvoke<Array<Record<string, unknown>>>(
      mainWindow,
      'bridge:listPendingPairRequests'
    )
    expect(after.find((r) => r.requestId === requestId)).toBeUndefined()
  })

  test('invocation: download/add a real file, reach completed, watch streams SSE', async ({
    mainWindow,
    userDataDir,
  }) => {
    test.setTimeout(120_000)
    await waitForEngineReady(mainWindow)
    const ep = await waitForEndpoint(userDataDir)
    const baseUrl = `http://127.0.0.1:${ep.port}`
    const auth = ['--endpoint', baseUrl, '--token', ep.localToken]

    // Throttled 2 MB so the task is observably Downloading and emits several
    // $/task/progress SSE frames (a localhost 1 MB transfer finishes too fast).
    const fx = await startHttpFixture({
      size: 2 * 1024 * 1024,
      throttleBytesPerSecond: 256 * 1024,
    })
    const saveDir = path.join(userDataDir, 'cli-downloads')
    await mkdir(saveDir, { recursive: true })

    try {
      // Start watching BEFORE the add so we capture the full progress arc.
      const watch = spawnCli([...auth, '--json', 'watch'])

      const add = await runCli([
        ...auth,
        '--json',
        'add',
        fx.fileUrl,
        '--save-dir',
        saveDir,
        '--filename',
        'cli-e2e.bin',
      ])
      expect(add.code, `add stderr: ${add.stderr}`).toBe(0)
      const task = JSON.parse(add.stdout) as { id: string; status: string }
      expect(task.id).toBeTruthy()

      // Poll task/list until the task reaches a terminal state.
      let status = task.status
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const list = await runCli([...auth, '--json', 'list'])
        const parsed = JSON.parse(list.stdout) as {
          tasks: Array<{ id: string; status: string }>
        }
        const found = parsed.tasks.find((t) => t.id === task.id)
        if (found) status = found.status
        if (status === 'completed' || status === 'error') break
        await sleep(500)
      }
      expect(status, 'task should complete').toBe('completed')

      // The bytes actually landed on disk at the expected size.
      const filePath = path.join(saveDir, 'cli-e2e.bin')
      expect(existsSync(filePath), `missing ${filePath}`).toBe(true)
      expect((await stat(filePath)).size).toBe(fx.fileSize)

      // Stop watch and assert it streamed progress + a terminal/stats event.
      watch.proc.kill('SIGINT')
      const watched = await watch.result
      expect(watched.code).toBe(0)
      // `motrix watch --json` emits one NDJSON `{event,data}` per SSE frame.
      const frames = watched.stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event?: string; data?: unknown })
      const events = frames.map((f) => f.event)
      expect(events, `watch frames: ${JSON.stringify(events)}`).toContain(
        '$/task/progress'
      )
      expect(
        events.includes('$/task/completed') || events.includes('$/stats')
      ).toBe(true)
    } finally {
      await fx.close()
    }
  })

  test('adversarial: wrong bearer token → exit 4 (AUTH)', async ({
    electronApp,
    userDataDir,
  }) => {
    // electronApp is requested (not otherwise used) so the fixture launches the
    // app + bridge; assert it actually came up before probing the wrong token.
    expect(electronApp).toBeTruthy()
    const ep = await waitForEndpoint(userDataDir)
    const res = await runCli([
      '--endpoint',
      `http://127.0.0.1:${ep.port}`,
      '--token',
      'definitely-not-the-token',
      'list',
    ])
    expect(res.code).toBe(4)
    expect(res.stderr.toLowerCase()).toMatch(/auth/)
  })

  test('adversarial: one-time token delivery — replayed poll is expired', async ({
    mainWindow,
    userDataDir,
  }) => {
    const ep = await waitForEndpoint(userDataDir)
    const req = await httpJson(ep.port, '/mdxp/pair/request', {
      clientName: 'replay-probe',
    })
    expect(req.status).toBe(200)
    const requestId = String(req.body.requestId)

    const approve = await bridgeInvoke(mainWindow, 'bridge:resolvePair', {
      kind: 'cli',
      requestId,
      decision: 'allow',
    })
    expect(approve).toEqual({ ok: true })

    const first = await httpJson(ep.port, '/mdxp/pair/poll', { requestId })
    expect(first.body.status).toBe('approved')
    expect(typeof first.body.token).toBe('string')

    const replay = await httpJson(ep.port, '/mdxp/pair/poll', { requestId })
    expect(replay.body).toEqual({ status: 'expired' })
  })

  test('adversarial: deny → no token issued', async ({
    mainWindow,
    userDataDir,
  }) => {
    const ep = await waitForEndpoint(userDataDir)
    const req = await httpJson(ep.port, '/mdxp/pair/request', {
      clientName: 'deny-probe',
    })
    const requestId = String(req.body.requestId)

    const deny = await bridgeInvoke(mainWindow, 'bridge:resolvePair', {
      kind: 'cli',
      requestId,
      decision: 'deny',
    })
    expect(deny).toEqual({ ok: true })

    const poll = await httpJson(ep.port, '/mdxp/pair/poll', { requestId })
    expect(['denied', 'expired']).toContain(poll.body.status)
    expect(poll.body.token).toBeUndefined()
  })
})
