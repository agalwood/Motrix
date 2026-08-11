import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_LOG_BYTES = 256 * 1024

async function docker(args, options = {}) {
  const result = await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BYTES,
    ...options,
  })
  return result.stdout.trim()
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function containerPort(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const output = await docker(['port', name, '8080/tcp']).catch(() => '')
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(output)
    if (match) return Number(match[1])
    await delay(100)
  }
  throw new Error('Docker did not publish the Server HTTP port')
}

async function containerExited(name) {
  const state = await docker([
    'inspect',
    '--format',
    '{{json .State}}',
    name,
  ]).catch(() => '')
  if (!state) return undefined
  const parsed = JSON.parse(state)
  return parsed.Running ? undefined : parsed
}

async function waitForHealth(name, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exited = await containerExited(name)
    if (exited) {
      throw new Error(
        `Server image exited before health check: code=${exited.ExitCode}`
      )
    }
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok && (await response.json()).ok === true) return
    } catch {
      // Container startup is still in progress.
    }
    await delay(100)
  }
  throw new Error(`Server image did not become healthy within ${timeoutMs}ms`)
}

async function assertOperatorAuth(url, token) {
  const unauthenticated = await fetch(`${url}/rpc/query/image-smoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: [] }),
  })
  if (unauthenticated.status !== 401) {
    throw new Error(
      `unauthenticated image request returned ${unauthenticated.status}`
    )
  }
  const status = await fetch(`${url}/rpc/auth/status`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!status.ok || (await status.json()).authed !== true) {
    throw new Error('Docker image operator authentication failed')
  }
  const authenticated = await fetch(`${url}/rpc/query/image-smoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ args: [] }),
  })
  if (authenticated.status !== 404) {
    throw new Error(
      `authenticated image request returned ${authenticated.status}`
    )
  }
}

const RUNTIME_PROBE = [
  "import { createRequire } from 'node:module'",
  "const require = createRequire('/app/package.json')",
  "const manifest = require('/app/package.json')",
  'for (const name of Object.keys(manifest.dependencies).sort()) import.meta.resolve(name)',
  "const Database = require('better-sqlite3')",
  "const memory = new Database(':memory:')",
  "memory.exec('CREATE TABLE smoke(value TEXT)')",
  "memory.prepare('INSERT INTO smoke(value) VALUES (?)').run('memory-ok')",
  "if (memory.prepare('SELECT value FROM smoke').get().value !== 'memory-ok') process.exit(2)",
  'memory.close()',
  "const file = '/data/image-smoke.db'",
  'const disk = new Database(file)',
  "disk.exec('CREATE TABLE smoke(value TEXT)')",
  "disk.prepare('INSERT INTO smoke(value) VALUES (?)').run('disk-ok')",
  'disk.close()',
  'const reopened = new Database(file)',
  "if (reopened.prepare('SELECT value FROM smoke').get().value !== 'disk-ok') process.exit(3)",
  'reopened.close()',
].join(';')

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (!['image', 'timeout-ms'].includes(key)) {
      throw new Error(`unknown option: --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    index += 1
  }
  if (!options.image) throw new Error('--image is required')
  return options
}

export async function smokeServerImage(options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error('Server image smoke timeout must be at least 1000ms')
  }
  const image = options.image
  const name = `motrix-server-smoke-${process.pid}-${Date.now()}`
  const operatorToken = 'motrix-image-smoke-operator-token'
  const startedAt = Date.now()
  let created = false
  try {
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--env',
      `MOTRIX_OPERATOR_TOKEN=${operatorToken}`,
      '--env',
      'MOTRIX_MDXP_PORT=0',
      '--publish',
      '127.0.0.1::8080',
      image,
    ])
    created = true
    const port = await containerPort(name, timeoutMs)
    const url = `http://127.0.0.1:${port}`
    await waitForHealth(name, url, timeoutMs)
    await assertOperatorAuth(url, operatorToken)
    await docker([
      'exec',
      name,
      'sh',
      '-ec',
      'test -s /data/motrix.db; pidof aria2c',
    ])
    await docker([
      'exec',
      name,
      'node',
      '--input-type=module',
      '--eval',
      RUNTIME_PROBE,
    ])
    await docker(['stop', '--time', String(Math.ceil(timeoutMs / 1000)), name])
    const state = JSON.parse(
      await docker(['inspect', '--format', '{{json .State}}', name])
    )
    if (state.Running || state.ExitCode !== 0 || state.OOMKilled) {
      throw new Error(
        `Server image shutdown failed: running=${state.Running} code=${state.ExitCode} oom=${state.OOMKilled}`
      )
    }
    const metadata = JSON.parse(await docker(['image', 'inspect', image]))[0]
    return {
      imageId: metadata.Id,
      imageBytes: metadata.Size,
      architecture: metadata.Architecture,
      node: metadata.Config.Env.find((entry) =>
        entry.startsWith('NODE_VERSION=')
      )?.slice('NODE_VERSION='.length),
      health: true,
      operatorAuth: true,
      sqlite: true,
      systemAria2: true,
      shutdown: 'SIGTERM',
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const logs = created
      ? await docker(['logs', '--tail', '200', name]).catch(() => '')
      : ''
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      logs
        ? `${message}\nContainer logs:\n${logs.slice(-MAX_LOG_BYTES)}`
        : message,
      { cause: error }
    )
  } finally {
    if (created) await docker(['rm', '--force', name]).catch(() => undefined)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = parseArguments(process.argv.slice(2))
  smokeServerImage({
    image: raw.image,
    timeoutMs: raw['timeout-ms']
      ? Number.parseInt(raw['timeout-ms'], 10)
      : undefined,
  })
    .then((result) => {
      console.log(`Server image smoke passed: ${JSON.stringify(result)}`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
