// Server-leg E2E acceptance: motrix-cli ↔ the headless Node/server shell.
//
// Standalone driver (NOT a Playwright spec — `.mjs`, so the suite's
// `*.spec.ts` glob skips it). Runs the REAL dist/server/index.mjs headless
// with the MDXP bridge + Spec 9 operator-auth gate, then drives the REAL
// `motrix` CLI binary against it. Covers:
//   - dual-listener topology (web + MDXP bridge on separate ports)
//   - Spec 9 deny-by-default (anonymous /rpc + /api → 401)
//   - operator login (cookie) + Bearer
//   - device-code pairing approved through the OPERATOR-GATED bridge:resolvePair
//     (incl. the self-approval-bypass negative probe)
//   - real download via aria2 (queued→completed + on-disk bytes) + watch SSE
//   - wrong-token → exit 4
//
// ─── Prerequisite: a NODE-ABI build of the server ──────────────────────
// The Electron app and the Node server need OPPOSITE better-sqlite3 ABIs and
// cannot share one node_modules. Build the server in a sibling git worktree
// (keeps the main checkout on its Electron ABI), once:
//
//   git worktree add --detach ../motrix-turbo-srv HEAD
//   cd ../motrix-turbo-srv
//   MOTRIX_SKIP_ELECTRON_REBUILD=1 pnpm --config.dangerouslyAllowAllBuilds=true install
//   pnpm build:server                 # produces dist/server + dist/renderer-web
//   cd -
//
// (The `--config.dangerouslyAllowAllBuilds=true` install runs better-sqlite3's
//  own build script under Node → Node ABI, and satisfies pnpm 11's deps-check
//  so `build:server` doesn't silently reinstall/revert the ABI.)
//
// ─── Run ────────────────────────────────────────────────────────────────
//   node e2e/bridge/server-leg.mjs
//
// Env overrides (all optional):
//   MOTRIX_SERVER_DIR   node-ABI build dir   (default: ../motrix-turbo-srv)
//   MOTRIX_E2E_WEB_PORT  web/operator port   (default: 8090)
//   MOTRIX_E2E_MDXP_PORT MDXP bridge port    (default: 16801)
//   MOTRIX_ARIA2_BIN     aria2 binary        (default: bundled extra/<platform>)
//
// Exit 0 = all checks passed; 1 = a check failed; 2 = prerequisite missing.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.resolve(HERE, '..', '..')
const WT =
  process.env.MOTRIX_SERVER_DIR ?? path.resolve(MAIN, '..', 'motrix-turbo-srv')
const SERVER_ENTRY = path.join(WT, 'dist', 'server', 'index.mjs')
const RENDERER_DIR = path.join(WT, 'dist', 'renderer-web')
// motrix now ships as the published @motrix/cli npm package (a devDependency),
// not an in-tree workspace package — resolve its bundled entry from node_modules.
const CLI = createRequire(import.meta.url).resolve(
  '@motrix/cli/dist/bin/motrix.js'
)
const ARIA2 =
  process.env.MOTRIX_ARIA2_BIN ??
  path.join(MAIN, 'extra', process.platform, process.arch, 'aria2c')
const WEB = Number(process.env.MOTRIX_E2E_WEB_PORT ?? 8090)
const MDXP = Number(process.env.MOTRIX_E2E_MDXP_PORT ?? 16801)
const WEB_BASE = `http://127.0.0.1:${WEB}`
const MDXP_BASE = `http://127.0.0.1:${MDXP}`
const OPTOK = `op-${crypto.randomBytes(8).toString('hex')}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return cond
}

// ── throttled http fixture (deterministic 2 MB) ────────────────────────
function startFixture(size, bps) {
  const payload = crypto.randomBytes(size)
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/srv.bin') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length),
    })
    const sliceMs = 100
    const chunk = Math.max(1024, Math.floor((bps * sliceMs) / 1000))
    let off = 0
    while (off < payload.length) {
      const end = Math.min(off + chunk, payload.length)
      if (!res.write(payload.subarray(off, end)))
        await new Promise((r) => res.once('drain', r))
      off = end
      if (off < payload.length) await sleep(sliceMs)
    }
    res.end()
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}/srv.bin`,
        size,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  )
}

// ── control-plane RPC ──────────────────────────────────────────────────
async function rpc(kind, channel, args, { operator } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (operator) headers.authorization = `Bearer ${OPTOK}`
  const res = await fetch(`${WEB_BASE}/rpc/${kind}/${channel}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: args ?? [] }),
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    /* empty body */
  }
  return { status: res.status, body }
}

// ── CLI process helpers ────────────────────────────────────────────────
function cliEnv(home) {
  return home ? { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } : {}
}
function runCli(args, { home } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...cliEnv(home) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => {
      out += String(d)
    })
    p.stderr.on('data', (d) => {
      err += String(d)
    })
    p.on('close', (code) => resolve({ code, out, err }))
  })
}
function spawnCli(args, { home } = {}) {
  const p = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...cliEnv(home) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  p.stdout.on('data', (d) => {
    out += String(d)
  })
  p.stderr.on('data', (d) => {
    err += String(d)
  })
  const result = new Promise((resolve) =>
    p.on('close', (code) => resolve({ code, out, err }))
  )
  return { proc: p, result, out: () => out, err: () => err }
}

async function waitFor(
  label,
  fn,
  { timeoutMs = 30_000, intervalMs = 300 } = {}
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* retry until the deadline */
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(
      `prerequisite missing: ${SERVER_ENTRY}\n` +
        'Build a node-ABI server first (see the header of this file).'
    )
    process.exit(2)
  }

  const DATA = await mkdtemp(path.join(os.tmpdir(), 'motrix-srv-e2e-'))
  const SAVE = path.join(DATA, 'dl')
  const credHome = path.join(DATA, 'home')
  await mkdir(SAVE, { recursive: true })
  await mkdir(path.join(credHome, '.config'), { recursive: true })
  console.log(`DATA=${DATA}`)

  const fx = await startFixture(2 * 1024 * 1024, 256 * 1024)
  console.log(`fixture: ${fx.url}`)

  let serverLog = ''
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WT,
    env: {
      ...process.env,
      PORT: String(WEB),
      MOTRIX_MDXP_HOST: '127.0.0.1',
      MOTRIX_MDXP_PORT: String(MDXP),
      MOTRIX_DATA_DIR: DATA,
      MOTRIX_OPERATOR_TOKEN: OPTOK,
      MOTRIX_ARIA2_BIN: ARIA2,
      MOTRIX_PUBLIC_URL: WEB_BASE,
      MOTRIX_RENDERER_DIR: RENDERER_DIR,
      MOTRIX_SKIP_ELECTRON_REBUILD: '1',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => {
    serverLog += String(d)
  })
  server.stderr.on('data', (d) => {
    serverLog += String(d)
  })

  const cleanup = async () => {
    try {
      server.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await fx.close().catch(() => {})
  }

  try {
    // ── 1. dual-listener up ────────────────────────────────────────────
    console.log('\n[1] Dual-listener topology')
    await waitFor(
      'web /healthz',
      async () => (await fetch(`${WEB_BASE}/healthz`)).ok,
      { timeoutMs: 30_000 }
    ).catch(() => {
      console.log('--- server log ---\n', serverLog.slice(-2000))
      throw new Error('server /healthz never came up')
    })
    const health = await (await fetch(`${WEB_BASE}/healthz`)).json()
    check('web control plane /healthz {ok:true}', health.ok === true)

    const ep = await waitFor('bridge endpoint.json', async () => {
      const j = JSON.parse(
        await readFile(path.join(DATA, 'bridge', 'endpoint.json'), 'utf-8')
      )
      return j.port && j.localToken ? j : null
    })
    check(
      'MDXP bridge wrote endpoint.json (port + localToken)',
      ep.port === MDXP && typeof ep.localToken === 'string'
    )
    const nonce = await fetch(`${MDXP_BASE}/nonce`).then((r) => r.status)
    check('MDXP bridge answers GET /nonce', nonce === 200, `status=${nonce}`)
    const auth = ['--endpoint', MDXP_BASE, '--token', ep.localToken]

    // ── 2. Spec 9 deny-by-default ──────────────────────────────────────
    console.log('\n[2] Spec 9 operator-auth gate (deny-by-default)')
    const anonQuery = await rpc('query', 'bridge:listPendingPairRequests', [])
    check(
      'anonymous /rpc/query → 401',
      anonQuery.status === 401,
      `got ${anonQuery.status}`
    )
    const anonApi = await fetch(`${WEB_BASE}/api/tasks/pause-all`, {
      method: 'POST',
    })
    check(
      'anonymous /api/tasks/pause-all → 401 (outside /rpc)',
      anonApi.status === 401,
      `got ${anonApi.status}`
    )

    // ── 3. operator login (cookie) + Bearer ────────────────────────────
    console.log('\n[3] Operator authentication')
    const login = await fetch(`${WEB_BASE}/rpc/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: OPTOK }),
    })
    const setCookie = login.headers.get('set-cookie') ?? ''
    check(
      'POST /rpc/auth/login → 200 + Set-Cookie mtx_op',
      login.status === 200 && setCookie.includes('mtx_op='),
      `status=${login.status}`
    )
    const opQuery = await rpc('query', 'bridge:listPendingPairRequests', [], {
      operator: true,
    })
    check(
      'operator Bearer authorizes /rpc/query (200, array)',
      opQuery.status === 200 && Array.isArray(opQuery.body),
      `status=${opQuery.status}`
    )

    // ── 4. engine ready (tolerant) ─────────────────────────────────────
    console.log('\n[4] Engine readiness')
    let engineReady = false
    try {
      await waitFor(
        'engine ready',
        async () => {
          const r = await rpc('query', 'query:getEngineStatus', [], {
            operator: true,
          })
          return r.status === 200 && r.body?.state === 'ready'
        },
        { timeoutMs: 30_000 }
      )
      engineReady = true
    } catch {
      /* download poll below will surface a genuinely-down engine */
    }
    check('aria2 engine reached ready', engineReady)

    // ── 5. INVOCATION — real download + watch SSE (localToken) ──────────
    console.log('\n[5] Invocation: download/add + watch SSE')
    const watch = spawnCli([...auth, '--json', 'watch'])
    const add = await runCli([
      ...auth,
      '--json',
      'add',
      fx.url,
      '--save-dir',
      SAVE,
      '--filename',
      'srv-e2e.bin',
    ])
    check(
      'motrix add → exit 0',
      add.code === 0,
      `code=${add.code} err=${add.err.trim()}`
    )
    let taskId = ''
    try {
      taskId = JSON.parse(add.out).id
    } catch {
      /* asserted below */
    }
    check('add returned a task id', !!taskId, `stdout=${add.out.slice(0, 200)}`)

    let finalStatus = ''
    if (taskId) {
      finalStatus = await waitFor(
        'task completed',
        async () => {
          const r = await runCli([...auth, '--json', 'list'])
          const found = JSON.parse(r.out).tasks.find((t) => t.id === taskId)
          if (
            found &&
            (found.status === 'completed' || found.status === 'error')
          )
            return found.status
          return null
        },
        { timeoutMs: 90_000, intervalMs: 500 }
      ).catch(() => 'timeout')
    }
    check(
      'task reached completed',
      finalStatus === 'completed',
      `status=${finalStatus}`
    )

    const filePath = path.join(SAVE, 'srv-e2e.bin')
    const onDisk = existsSync(filePath)
    const size = onDisk ? (await stat(filePath)).size : -1
    check(
      'downloaded bytes on disk match fixture size',
      onDisk && size === fx.size,
      `exists=${onDisk} size=${size} want=${fx.size}`
    )

    watch.proc.kill('SIGINT')
    const watched = await watch.result
    const events = watched.out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).event
        } catch {
          return null
        }
      })
      .filter(Boolean)
    check('watch exits 0 on SIGINT', watched.code === 0, `code=${watched.code}`)
    check(
      'watch streamed $/task/progress (SSE)',
      events.includes('$/task/progress'),
      `events=${JSON.stringify(events.slice(0, 12))}`
    )
    check(
      'watch streamed a terminal/stats event',
      events.includes('$/task/completed') || events.includes('$/stats')
    )

    // ── 6. PAIRING — device-code approved by the OPERATOR ───────────────
    console.log('\n[6] Device-code pairing via operator-gated approval')
    const pair = spawnCli(
      ['--endpoint', MDXP_BASE, 'pair', '--name', 'srv-cli'],
      {
        home: credHome,
      }
    )
    const pending = await waitFor(
      'pending pair request in operator inbox',
      async () => {
        const r = await rpc('query', 'bridge:listPendingPairRequests', [], {
          operator: true,
        })
        return (r.body ?? []).find((x) => x.clientName === 'srv-cli') ?? null
      },
      { timeoutMs: 15_000 }
    )
    check(
      'operator inbox lists the cli request (userCode, token-free)',
      /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pending.userCode) &&
        !('token' in pending) &&
        !('deviceId' in pending)
    )
    check(
      'CLI printed the same userCode on stderr',
      pair.err().includes(pending.userCode)
    )

    // self-approval bypass MUST be closed: anonymous resolvePair → 401
    const anonApprove = await rpc('command', 'bridge:resolvePair', [
      { kind: 'cli', requestId: pending.requestId, decision: 'allow' },
    ])
    check(
      'anonymous bridge:resolvePair → 401 (self-approval bypass closed)',
      anonApprove.status === 401,
      `got ${anonApprove.status}`
    )

    // operator approves through the gated control plane
    const approve = await rpc(
      'command',
      'bridge:resolvePair',
      [{ kind: 'cli', requestId: pending.requestId, decision: 'allow' }],
      { operator: true }
    )
    check(
      'operator bridge:resolvePair allow → {ok:true}',
      approve.status === 200 && approve.body?.ok === true,
      `status=${approve.status} body=${JSON.stringify(approve.body)}`
    )

    const pairRes = await Promise.race([
      pair.result,
      sleep(15_000).then(() => ({ code: 'timeout' })),
    ])
    check(
      'motrix pair exits 0 after approval',
      pairRes.code === 0,
      `code=${pairRes.code} err=${pair.err().slice(-200)}`
    )

    const paired = await rpc('query', 'bridge:listPaired', [], {
      operator: true,
    })
    check(
      'paired list now includes the cli client srv-cli',
      Array.isArray(paired.body) &&
        paired.body.some((p) => p.kind === 'cli' && p.name === 'srv-cli')
    )

    // ── 7. adversarial: wrong bridge token → exit 4 ─────────────────────
    console.log('\n[7] Adversarial')
    const wrong = await runCli([
      '--endpoint',
      MDXP_BASE,
      '--token',
      'definitely-not-the-token',
      'list',
    ])
    check(
      'wrong bridge token → exit 4 (AUTH)',
      wrong.code === 4,
      `code=${wrong.code}`
    )
  } finally {
    await cleanup()
  }

  console.log(
    `\n================  ${passed} passed, ${failed} failed  ================`
  )
  if (failed > 0)
    console.log('\n--- server log tail ---\n', serverLog.slice(-1500))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('DRIVER ERROR:', err)
  process.exit(1)
})
