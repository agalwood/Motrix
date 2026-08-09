#!/usr/bin/env node
// PoC: verify aria2 behavioral assumptions for the incomplete-suffix feature.
// See: docs/superpowers/specs/2026-04-23-incomplete-suffix-design.md §8.5
//      docs/superpowers/plans/2026-04-23-incomplete-suffix-plan.md Task 0

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const ARIA2_BIN = path.resolve(REPO_ROOT, 'extra/darwin/arm64/aria2c')
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures')

const RPC_SECRET = 'poc_secret'
const RPC_PORT = 16800
const WS_URL = `ws://localhost:${RPC_PORT}/jsonrpc`

// ---------------------------------------------------------------------------
// aria2 process helpers
// ---------------------------------------------------------------------------

let workDir = ''

function spawnAria2() {
  const proc = spawn(
    ARIA2_BIN,
    [
      '--enable-rpc=true',
      `--rpc-listen-port=${RPC_PORT}`,
      `--rpc-secret=${RPC_SECRET}`,
      '--rpc-allow-origin-all=true',
      '--enable-dht=false',
      '--enable-peer-exchange=false',
      '--bt-save-metadata=true',
      '--bt-metadata-only=false',
      '--bt-tracker=',
      '--console-log-level=warn',
      `--dir=${workDir}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  proc.stdout.on('data', (d) => process.stdout.write(`[aria2] ${d}`))
  proc.stderr.on('data', (d) => process.stderr.write(`[aria2!] ${d}`))
  return proc
}

async function waitForRpcReady(timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const ws = new WebSocket(WS_URL)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      ws.close()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('aria2 RPC did not become ready within timeout')
}

// ---------------------------------------------------------------------------
// JSON-RPC over WebSocket, with a single persistent socket and notification sink
// ---------------------------------------------------------------------------

/** @type {WebSocket | null} */
let sharedWs = null
/** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void }>} */
const pending = new Map()
/** @type {Array<{ method: string, params: any }>} */
const notifications = []

async function connectWs() {
  sharedWs = new WebSocket(WS_URL)
  await new Promise((resolve, reject) => {
    sharedWs.once('open', resolve)
    sharedWs.once('error', reject)
  })
  sharedWs.on('message', (msg) => {
    const raw = msg.toString()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (parsed.method && Array.isArray(parsed.params)) {
      notifications.push({ method: parsed.method, params: parsed.params })
      return
    }
    if (parsed.id && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id)
      pending.delete(parsed.id)
      if (parsed.error) reject(parsed.error)
      else resolve(parsed.result)
    }
  })
}

function rpc(method, params = []) {
  const id = crypto.randomBytes(8).toString('hex')
  const payload = {
    jsonrpc: '2.0',
    id,
    method,
    params: [`token:${RPC_SECRET}`, ...params],
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    sharedWs.send(JSON.stringify(payload))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`RPC ${method} timed out`))
      }
    }, 8000)
  })
}

async function waitUntil(fn, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `waitUntil timeout after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ''}`
  )
}

// ---------------------------------------------------------------------------
// Minimal bencode decoder (enough to extract info-hash from a .torrent file)
// ---------------------------------------------------------------------------

function _bdecode(buf) {
  let i = 0
  function decode() {
    const c = buf[i]
    if (c === 0x69) {
      // 'i' ... 'e'
      i++
      const end = buf.indexOf(0x65, i)
      const n = Number(buf.slice(i, end).toString('ascii'))
      i = end + 1
      return n
    }
    if (c === 0x6c) {
      // 'l' ... 'e'
      i++
      const arr = []
      while (buf[i] !== 0x65) arr.push(decode())
      i++
      return arr
    }
    if (c === 0x64) {
      // 'd' ... 'e'
      i++
      const obj = {}
      while (buf[i] !== 0x65) {
        const key = decode()
        const keyStr = Buffer.isBuffer(key)
          ? key.toString('ascii')
          : String(key)
        obj[keyStr] = { __value: decode(), __startRaw: null }
      }
      i++
      return obj
    }
    // byte string: <len>:<bytes>
    const colon = buf.indexOf(0x3a, i)
    const len = Number(buf.slice(i, colon).toString('ascii'))
    i = colon + 1
    const bytes = buf.slice(i, i + len)
    i += len
    return bytes
  }
  return decode()
}

// Finds the raw byte slice of the value for key `info` at top-level dict.
function findInfoDictRaw(buf) {
  // naive: locate "4:info" then capture its bencoded value slice by re-parsing
  const needle = Buffer.from('4:info')
  const idx = buf.indexOf(needle)
  if (idx === -1) throw new Error('info dict not found')
  const valueStart = idx + needle.length
  // parse starting at valueStart and track end
  let i = valueStart
  function skip() {
    const c = buf[i]
    if (c === 0x69) {
      i++
      i = buf.indexOf(0x65, i) + 1
      return
    }
    if (c === 0x6c) {
      i++
      while (buf[i] !== 0x65) skip()
      i++
      return
    }
    if (c === 0x64) {
      i++
      while (buf[i] !== 0x65) {
        skip() // key
        skip() // value
      }
      i++
      return
    }
    const colon = buf.indexOf(0x3a, i)
    const len = Number(buf.slice(i, colon).toString('ascii'))
    i = colon + 1 + len
  }
  skip()
  return buf.slice(valueStart, i)
}

function computeInfoHash(torrentBuf) {
  const infoRaw = findInfoDictRaw(torrentBuf)
  return crypto.createHash('sha1').update(infoRaw).digest('hex')
}

// ---------------------------------------------------------------------------
// PoC items
// ---------------------------------------------------------------------------

async function pocItem1_btSeedUnverified(results) {
  const torrentPath = path.join(FIXTURE_DIR, 'sample.torrent')
  const torrentB64 = (await fs.readFile(torrentPath)).toString('base64')

  // aria2 expects dir to contain the torrent's top-level folder ("sample-data")
  // Place fixture dir so <workDir>/sample-data/test.bin already exists.
  const stagingDir = path.join(workDir, 'item1-staging')
  await fs.mkdir(stagingDir, { recursive: true })
  await fs.cp(
    path.join(FIXTURE_DIR, 'sample-data'),
    path.join(stagingDir, 'sample-data'),
    { recursive: true }
  )

  const start = Date.now()
  const gid = await rpc('aria2.addTorrent', [
    torrentB64,
    [],
    {
      dir: stagingDir,
      'bt-seed-unverified': 'true',
      'seed-time': '0',
      pause: 'false',
    },
  ])

  // Should reach 'active' (= seeding since complete) without going through verify
  const status = await waitUntil(async () => {
    const s = await rpc('aria2.tellStatus', [
      gid,
      ['status', 'totalLength', 'completedLength', 'verifiedLength'],
    ])
    if (
      (s.status === 'active' || s.status === 'complete') &&
      s.completedLength === s.totalLength &&
      Number(s.totalLength) > 0
    ) {
      return s
    }
    return null
  }, 5000)
  const elapsed = Date.now() - start

  // Clean up so item5/6 GIDs don't interfere
  try {
    await rpc('aria2.forceRemove', [gid])
  } catch {}

  results.item1 = {
    pass:
      status.completedLength === status.totalLength &&
      Number(status.totalLength) > 0 &&
      elapsed < 1000,
    status: status.status,
    elapsedMs: elapsed,
    completedLength: status.completedLength,
    totalLength: status.totalLength,
    verifiedLength: status.verifiedLength,
    notes:
      elapsed < 1000
        ? 'reached seeding state without pre-verification'
        : `elapsed ${elapsed}ms exceeded 1000ms budget`,
  }
}

async function pocItem2_btSaveMetadata(results) {
  const torrentPath = path.join(FIXTURE_DIR, 'sample.torrent')
  const torrentBuf = await fs.readFile(torrentPath)
  const infoHash = computeInfoHash(torrentBuf)
  const torrentFileSha1 = crypto
    .createHash('sha1')
    .update(torrentBuf)
    .digest('hex')

  const metadataDir = path.join(workDir, 'item2-metadata')
  await fs.mkdir(metadataDir, { recursive: true })

  // We verify this by adding the torrent directly (metadata already present)
  // and inspecting the filesystem for a <something>.torrent file under --dir.
  // aria2 1.37.0 empirically writes `<SHA1-of-full-torrent-file>.torrent`,
  // NOT `<info-hash>.torrent` — we check both so the results document the
  // actual naming convention.
  const torrentB64 = torrentBuf.toString('base64')
  const gid = await rpc('aria2.addTorrent', [
    torrentB64,
    [],
    {
      dir: metadataDir,
      'bt-save-metadata': 'true',
      'bt-seed-unverified': 'true',
      'seed-time': '0',
      pause: 'false',
    },
  ])

  // Give aria2 a moment to write the metadata file (if it will)
  await new Promise((r) => setTimeout(r, 1000))

  const byInfoHash = path.join(metadataDir, `${infoHash}.torrent`)
  const byTorrentSha1 = path.join(metadataDir, `${torrentFileSha1}.torrent`)
  const hasByInfoHash = existsSync(byInfoHash)
  const hasByTorrentSha1 = existsSync(byTorrentSha1)

  // Also enumerate what's actually there, for documentation
  const entries = await fs.readdir(metadataDir)
  const torrentFiles = entries.filter((e) => e.endsWith('.torrent'))

  try {
    await rpc('aria2.forceRemove', [gid])
  } catch {}

  const found = hasByInfoHash || hasByTorrentSha1
  let namingConvention = 'unknown'
  if (hasByInfoHash) namingConvention = 'info-hash'
  else if (hasByTorrentSha1) namingConvention = 'torrent-file-sha1'

  results.item2 = {
    pass: found,
    infoHash,
    torrentFileSha1,
    namingConvention,
    foundFiles: torrentFiles,
    notes: found
      ? `metadata saved under --dir using naming convention: ${namingConvention} (file: ${torrentFiles.join(', ')})`
      : `no .torrent file saved under ${metadataDir}`,
  }
}

async function pocItem3_selectFile(results) {
  const torrentPath = path.join(FIXTURE_DIR, 'multi.torrent')
  const torrentB64 = (await fs.readFile(torrentPath)).toString('base64')

  const selectDir = path.join(workDir, 'item3-select')
  await fs.mkdir(selectDir, { recursive: true })
  // Pre-stage both source files so aria2 doesn't actually have to download
  // anything across the wire (it'll see the data is already present).
  await fs.cp(
    path.join(FIXTURE_DIR, 'multi-data'),
    path.join(selectDir, 'multi-data'),
    { recursive: true }
  )

  const gid = await rpc('aria2.addTorrent', [
    torrentB64,
    [],
    {
      dir: selectDir,
      'select-file': '1',
      'bt-seed-unverified': 'true',
      'seed-time': '0',
      pause: 'false',
    },
  ])

  // Wait briefly then inspect tellStatus's files array for selected flags
  let files
  await waitUntil(async () => {
    const s = await rpc('aria2.tellStatus', [gid, ['files', 'status']])
    if (s.files && s.files.length === 2) {
      files = s.files
      return true
    }
    return null
  }, 3000)

  const file1 = files.find((f) => f.index === '1')
  const file2 = files.find((f) => f.index === '2')

  try {
    await rpc('aria2.forceRemove', [gid])
  } catch {}

  const pass =
    file1 && file2 && file1.selected === 'true' && file2.selected === 'false'

  results.item3 = {
    pass,
    file1Selected: file1?.selected,
    file2Selected: file2?.selected,
    notes: pass
      ? 'select-file="1" correctly marks file index 1 selected, file index 2 not selected'
      : `unexpected selected flags: file1=${file1?.selected} file2=${file2?.selected}`,
  }
}

async function pocItem4_windowsDirRename(results) {
  results.item4 = {
    pass: 'N/A (macOS run)',
    notes:
      'Windows-specific; directory-rename atomicity must be verified on Windows CI before relying on it. Deferred.',
  }
}

async function pocItem5_removeDownloadResultOnActive(results) {
  const torrentPath = path.join(FIXTURE_DIR, 'sample.torrent')
  const torrentB64 = (await fs.readFile(torrentPath)).toString('base64')

  const stagingDir = path.join(workDir, 'item5-staging')
  await fs.mkdir(stagingDir, { recursive: true })
  await fs.cp(
    path.join(FIXTURE_DIR, 'sample-data'),
    path.join(stagingDir, 'sample-data'),
    { recursive: true }
  )

  const gid = await rpc('aria2.addTorrent', [
    torrentB64,
    [],
    {
      dir: stagingDir,
      'bt-seed-unverified': 'true',
      'seed-time': '0',
      pause: 'false',
    },
  ])

  // Wait until it's active (seeding)
  await waitUntil(async () => {
    const s = await rpc('aria2.tellStatus', [gid, ['status']])
    return s.status === 'active' ? s : null
  }, 5000)

  // Step A: try removeDownloadResult directly on an active task — expect error
  let directError = null
  try {
    await rpc('aria2.removeDownloadResult', [gid])
  } catch (e) {
    directError = e
  }

  // Step B: remove first, then removeDownloadResult
  await rpc('aria2.remove', [gid])

  let secondStepOk = false
  let secondStepError = null
  try {
    const r = await rpc('aria2.removeDownloadResult', [gid])
    secondStepOk = r === 'OK'
  } catch (e) {
    secondStepError = e
  }

  const pass = directError !== null && secondStepOk
  results.item5 = {
    pass,
    directCallRejected: directError !== null,
    directErrorMessage: directError?.message ?? null,
    twoStepOk: secondStepOk,
    twoStepError: secondStepError?.message ?? null,
    notes: pass
      ? 'confirmed: remove() then removeDownloadResult() is the correct sequence for active tasks'
      : `unexpected: directError=${!!directError}, twoStepOk=${secondStepOk}`,
  }
}

async function pocItem6_onBtDownloadCompleteWithSelectFile(results) {
  const torrentPath = path.join(FIXTURE_DIR, 'multi.torrent')
  const torrentB64 = (await fs.readFile(torrentPath)).toString('base64')

  const eventDir = path.join(workDir, 'item6-event')
  await fs.mkdir(eventDir, { recursive: true })
  // Pre-stage data so completion is immediate
  await fs.cp(
    path.join(FIXTURE_DIR, 'multi-data'),
    path.join(eventDir, 'multi-data'),
    { recursive: true }
  )

  const notifsBefore = notifications.length

  const gid = await rpc('aria2.addTorrent', [
    torrentB64,
    [],
    {
      dir: eventDir,
      'select-file': '1',
      // Do NOT use bt-seed-unverified here: we want aria2 to go through the
      // normal check-integrity path so onBtDownloadComplete fires.
      'check-integrity': 'true',
      'seed-time': '0',
      pause: 'false',
    },
  ])

  let eventFired = false
  try {
    await waitUntil(() => {
      for (let i = notifsBefore; i < notifications.length; i++) {
        const n = notifications[i]
        if (
          n.method === 'aria2.onBtDownloadComplete' &&
          Array.isArray(n.params) &&
          n.params[0]?.gid === gid
        ) {
          eventFired = true
          return true
        }
      }
      return null
    }, 8000)
  } catch {
    /* timed out */
  }

  try {
    await rpc('aria2.forceRemove', [gid])
  } catch {}

  results.item6 = {
    pass: eventFired,
    notes: eventFired
      ? 'aria2.onBtDownloadComplete fired for torrent with select-file="1"'
      : 'aria2.onBtDownloadComplete did NOT fire within 8s for select-file-restricted torrent',
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Create a unique work dir so runs don't collide with each other
  workDir = await fs.mkdtemp(path.join(FIXTURE_DIR, 'work-'))
  console.log(`[poc] work dir: ${workDir}`)

  const results = {}
  const proc = spawnAria2()

  let exitCode = 0
  try {
    await waitForRpcReady()
    await connectWs()

    // Run each item sequentially; don't abort on per-item failure.
    const steps = [
      ['item1', pocItem1_btSeedUnverified],
      ['item2', pocItem2_btSaveMetadata],
      ['item3', pocItem3_selectFile],
      ['item4', pocItem4_windowsDirRename],
      ['item5', pocItem5_removeDownloadResultOnActive],
      ['item6', pocItem6_onBtDownloadCompleteWithSelectFile],
    ]
    for (const [name, fn] of steps) {
      try {
        console.log(`[poc] running ${name}...`)
        await fn(results)
        console.log(`[poc] ${name} done: ${JSON.stringify(results[name])}`)
      } catch (e) {
        console.error(`[poc] ${name} threw:`, e)
        results[name] = {
          pass: false,
          error: e?.message ?? String(e),
        }
      }
    }
  } catch (e) {
    console.error('[poc] fatal:', e)
    exitCode = 1
  } finally {
    if (sharedWs) {
      try {
        sharedWs.close()
      } catch {}
    }
    proc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
  }

  console.log('\n===== PoC results =====')
  console.log(JSON.stringify(results, null, 2))
  console.log('=======================')

  const blocking = ['item1', 'item2', 'item3', 'item5', 'item6']
  const fatalFail = results.item1 && results.item1.pass !== true
  const anyBlockingFail = blocking.some(
    (k) => results[k] && results[k].pass !== true
  )
  if (fatalFail) {
    console.error('\nFATAL: item1 (bt-seed-unverified) failed — BLOCK.')
    exitCode = 2
  } else if (anyBlockingFail) {
    console.warn('\nWARN: one or more non-fatal blocking items failed.')
  } else {
    console.log('\nAll blocking items passed.')
  }

  process.exit(exitCode)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
