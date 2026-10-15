import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin')
  throw new Error('This link check requires macOS')
const root = fileURLToPath(new URL('../', import.meta.url))
const source = process.env.MOTRIX_NATIVE_HOST_SOURCE
if (!source)
  throw new Error('Set MOTRIX_NATIVE_HOST_SOURCE to the native-host package')
const output = join(root, '.cache/safari-native/bootstrap')
const archive = join(output, 'rust/release/libmotrix_native_host.a')
if (!existsSync(archive))
  throw new Error('Build the signed bootstrap service before checking its link')
mkdirSync(output, { recursive: true })
const environment = {
  ...process.env,
  DEVELOPER_DIR:
    process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer',
}
const executable = join(output, 'BootstrapLinkVerification')
const ipc = join(root, 'native/safari/Sources/SafariNativeIPC')
const compiled = spawnSync(
  '/usr/bin/xcrun',
  [
    'swiftc',
    '-swift-version',
    '6',
    '-parse-as-library',
    '-module-cache-path',
    join(output, 'swift-module-cache'),
    '-import-objc-header',
    resolve(source, 'include/motrix_safari_bootstrap.h'),
    ...readdirSync(ipc)
      .filter((name) => name.endsWith('.swift'))
      .sort()
      .map((name) => join(ipc, name)),
    join(root, 'native/safari/Verification/BootstrapLinkMain.swift'),
    archive,
    '-framework',
    'Security',
    '-o',
    executable,
  ],
  { env: environment, stdio: 'inherit' }
)
if (compiled.error) throw compiled.error
if (compiled.status !== 0) throw new Error('Swift/Rust link failed')

const directory = mkdtempSync(join(tmpdir(), 'motrix-safari-link-'))
const endpoint = join(directory, 'endpoint.json')
const calls = []
const nonce = randomBytes(24).toString('base64url')
const localToken = randomBytes(32).toString('base64url')
const key = randomBytes(32)
const request = {
  action: 'bootstrap',
  protocolVersion: 1,
  bindingPub: key.toString('base64url'),
  allowLaunch: false,
}
const server = createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`)
  const body = JSON.stringify(
    req.url === '/discovery'
      ? {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 'safari-link-fixture',
          appVersion: '0.0.0',
        }
      : { nonce }
  )
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
})

async function invoke(message = request) {
  const child = spawn(executable, [], {
    env: { ...environment, MOTRIX_BRIDGE_DATA_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stderr.resume()
  const timeout = setTimeout(() => child.kill(), 5000)
  try {
    child.stdin.end(JSON.stringify(message))
    const [code] = await once(child, 'close')
    const raw = Buffer.concat(chunks).toString('utf8')
    assert(
      !raw.includes(localToken),
      'The endpoint token must never enter a response'
    )
    return { code, value: raw ? JSON.parse(raw) : null }
  } finally {
    clearTimeout(timeout)
  }
}
function writeEndpoint(value, mode = 0o600) {
  writeFileSync(endpoint, JSON.stringify(value), { mode: 0o600 })
  chmodSync(endpoint, mode)
}
function enc(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(data.length))
  return Buffer.concat([length, data])
}
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  writeEndpoint({ port, localToken, generation: 'safari-link-generation' })
  const before = Math.floor(Date.now() / 1000)
  const signed = await invoke()
  assert.equal(signed.code, 0)
  assert.equal(signed.value.port, port)
  assert.equal(signed.value.nonce, nonce)
  const ticket = signed.value.nmTicket
  assert.equal(ticket.browser, 'safari')
  assert.equal(ticket.callerId, 'app.motrix.safari.extension')
  assert.equal(ticket.bindingPub, request.bindingPub)
  assert(
    ticket.exp >= before + 60 &&
      ticket.exp <= Math.floor(Date.now() / 1000) + 60
  )
  const version = Buffer.from([0, 0, 0, 1])
  const expiration = Buffer.alloc(8)
  expiration.writeBigUInt64BE(BigInt(ticket.exp))
  const canonical = Buffer.concat([
    enc('mbp1-attestation'),
    version,
    version,
    enc('safari-link-generation'),
    enc('safari'),
    enc('app.motrix.safari.extension'),
    expiration,
    enc(key),
  ])
  const macKey = hkdfSync('sha256', localToken, 'MBP1/nm-ticket/v1', 'mac', 32)
  assert.equal(
    ticket.mac,
    createHmac('sha256', macKey).update(canonical).digest('base64url')
  )
  assert.deepEqual(calls.splice(0), ['GET /discovery', 'POST /nonce'])

  writeEndpoint({ port })
  const ticketless = await invoke()
  assert.equal(ticketless.code, 0)
  assert.equal(ticketless.value.nmTicket, undefined)
  assert.deepEqual(calls.splice(0), ['GET /discovery', 'POST /nonce'])

  writeEndpoint(
    { port, localToken, generation: 'safari-link-generation' },
    0o644
  )
  const insecure = await invoke()
  assert.equal(insecure.code, 0)
  assert.equal(insecure.value.port, port)
  assert.equal(insecure.value.nmTicket, undefined)
  assert.deepEqual(calls.splice(0), ['GET /discovery', 'POST /nonce'])
  rmSync(endpoint)
  const missing = await invoke()
  assert.equal(missing.code, 0)
  assert.deepEqual(missing.value, {
    error: 'bootstrap-unavailable',
    protocolVersion: 1,
  })
  assert.deepEqual(calls, [])
  for (const invalid of [
    { ...request, callerId: 'spoofed' },
    { ...request, allowLaunch: true },
  ]) {
    const rejected = await invoke(invalid)
    assert.equal(rejected.code, 1)
    assert.equal(rejected.value, null)
    assert.deepEqual(calls, [])
  }
  console.log(
    'Swift/Rust link: signed response and independent MAC, ticketless fallback, endpoint permissions, missing endpoint, identity injection, and launch suppression passed.'
  )
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  rmSync(directory, { recursive: true, force: true })
}
