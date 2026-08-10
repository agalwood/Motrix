import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'

const COMPOSE_CWD = 'tests/docker'

export async function composeUp(): Promise<void> {
  await run('docker', ['compose', 'up', '-d'])
  await waitForMatrixReady(30_000)
}

export async function composeDown(): Promise<void> {
  // Containers are removed here, in afterAll — before any workflow-level
  // "logs on failure" step runs. Dump evidence first on CI or a failed run
  // leaves no trace of why a container died.
  if (process.env.CI === 'true') {
    await dumpMatrixEvidence()
  }
  await run('docker', ['compose', 'down', '--volumes', '-t', '2'])
}

// Poll until every compose service reports running. A fixed sleep is not
// enough: a container that crashes on start stays invisible until the first
// test times out against a dead endpoint.
async function waitForMatrixReady(timeoutMs: number): Promise<void> {
  const services = (
    await runOutput('docker', ['compose', 'config', '--services'])
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await composePs()
    const crashed = rows.filter(
      (r) => r.State === 'exited' || r.State === 'dead'
    )
    if (crashed.length > 0) {
      await dumpMatrixEvidence()
      const names = crashed.map((r) => r.Service ?? r.Name).join(', ')
      throw new Error(`NAT matrix container(s) exited on startup: ${names}`)
    }
    const running = rows.filter((r) => r.State === 'running').length
    if (running >= services.length) return
    if (Date.now() > deadline) {
      await dumpMatrixEvidence()
      throw new Error(
        `NAT matrix not ready after ${timeoutMs}ms ` +
          `(${running}/${services.length} services running)`
      )
    }
    await wait(500)
  }
}

interface ComposePsRow {
  Name?: string
  Service?: string
  State?: string
}

async function composePs(): Promise<ComposePsRow[]> {
  const out = await runOutput('docker', [
    'compose',
    'ps',
    '--all',
    '--format',
    'json',
  ])
  const trimmed = out.trim()
  if (!trimmed) return []
  // docker compose emits NDJSON (one object per line) on current versions
  // and a JSON array on some older ones — accept both.
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as ComposePsRow[]
  }
  return trimmed
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComposePsRow)
}

async function dumpMatrixEvidence(): Promise<void> {
  for (const args of [
    ['compose', 'ps', '--all'],
    ['compose', 'logs', '--no-color'],
  ]) {
    try {
      await run('docker', args)
    } catch {
      // best-effort diagnostics only
    }
  }
}

// Resolve a bridge-network service's container IP. Tests target this address
// directly: the NAT clients' SSRF guards reject loopback by design, so a
// 127.0.0.1:published-port route can never be exercised — the RFC1918 bridge
// address is the reachable-and-allowed path on the Linux CI runner.
export async function containerIp(service: string): Promise<string> {
  const id = (
    await runOutput('docker', ['compose', 'ps', '-q', service])
  ).trim()
  if (!id) throw new Error(`no container for compose service: ${service}`)
  const ip = (
    await runOutput('docker', [
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      id,
    ])
  ).trim()
  if (!ip) throw new Error(`no bridge IP for compose service: ${service}`)
  return ip
}

export async function isMatrixUp(): Promise<boolean> {
  try {
    const out = await runOutput('docker', ['compose', 'ps', '--format', 'json'])
    return out.includes('"State":"running"')
  } catch {
    return false
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: COMPOSE_CWD, stdio: 'inherit' })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))
    )
  })
}

function runOutput(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: COMPOSE_CWD })
    let stdout = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}`))
    )
  })
}

// Availability detection — tests call this in beforeAll and skip if false.
let cached: boolean | null = null
export async function dockerMatrixAvailable(): Promise<boolean> {
  if (cached !== null) return cached
  try {
    await runOutput('docker', ['version', '--format', '{{.Server.Version}}'])
    cached = true
  } catch {
    cached = false
  }
  return cached
}
