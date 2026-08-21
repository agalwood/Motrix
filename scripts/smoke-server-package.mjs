import { spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_LOG_BYTES = 256 * 1024

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  if (port === 0) throw new Error('failed to allocate a Server smoke port')
  return port
}

async function assertDirectRootsResolve(stageRoot, dependencies) {
  const canonicalStageRoot = await realpath(stageRoot)
  const script = [
    "import path from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    `const root = ${JSON.stringify(canonicalStageRoot)}`,
    `const dependencies = ${JSON.stringify(dependencies)}`,
    'for (const dependency of dependencies) {',
    '  const resolved = fileURLToPath(import.meta.resolve(dependency))',
    '  const relative = path.relative(root, resolved)',
    "  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {",
    "    throw new Error(dependency + ' resolved outside staged Server app')",
    '  }',
    '}',
  ].join('\n')
  await withTimeout(
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          cwd: stageRoot,
          env: { ...process.env, NODE_PATH: undefined },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_LOG_BYTES)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else
          reject(new Error(`direct-root resolution failed: ${stderr.trim()}`))
      })
    }),
    10_000,
    'direct-root resolution'
  )
}

async function assertOperatorCli(stageRoot, timeoutMs) {
  const executable = path.join(stageRoot, 'dist/server/motrix-admin.mjs')
  await withTimeout(
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [executable, '--help'], {
        cwd: stageRoot,
        env: { ...process.env, NODE_PATH: undefined },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-MAX_LOG_BYTES)
      })
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_LOG_BYTES)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0 && stdout.includes('motrix-admin pairing pending')) {
          resolve()
          return
        }
        reject(
          new Error(
            `operator CLI help failed: code=${code} stderr=${stderr.trim()}`
          )
        )
      })
    }),
    timeoutMs,
    'operator CLI help'
  )
}

function assertSqlite(stageRoot, scratchRoot) {
  const require = createRequire(path.join(stageRoot, 'package.json'))
  const Database = require('better-sqlite3')
  const memory = new Database(':memory:')
  memory.exec('CREATE TABLE smoke (value TEXT NOT NULL)')
  memory.prepare('INSERT INTO smoke (value) VALUES (?)').run('memory-ok')
  const memoryValue = memory.prepare('SELECT value FROM smoke').get()?.value
  memory.close()
  if (memoryValue !== 'memory-ok') {
    throw new Error('in-memory better-sqlite3 read/write failed')
  }

  const databasePath = path.join(scratchRoot, 'sqlite-smoke.db')
  const disk = new Database(databasePath)
  disk.exec('CREATE TABLE smoke (value TEXT NOT NULL)')
  disk.prepare('INSERT INTO smoke (value) VALUES (?)').run('disk-ok')
  disk.close()
  const reopened = new Database(databasePath)
  const diskValue = reopened.prepare('SELECT value FROM smoke').get()?.value
  reopened.close()
  if (diskValue !== 'disk-ok') {
    throw new Error('on-disk better-sqlite3 reopen failed')
  }
}

async function assertQuickJsWorker(stageRoot, timeoutMs) {
  const workerPath = path.join(
    stageRoot,
    'dist/core/plugin/host/quick-js-worker.cjs'
  )
  const worker = new Worker(workerPath, {
    resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 1 },
  })
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        worker.on('message', (message) => {
          if (message?.type === 'ready') resolve()
          else if (message?.type === 'fatal') {
            reject(
              new Error(
                `QuickJS worker failed: ${message.code}: ${message.message}`
              )
            )
          }
        })
        worker.once('error', reject)
        worker.postMessage({
          type: 'init',
          pluginId: 'motrix.runtime-smoke',
          manifest: {
            manifestVersion: 1,
            id: 'motrix.runtime-smoke',
            name: 'Runtime smoke',
            version: '1.0.0',
            description: 'Staged Server runtime smoke',
            categories: ['other'],
            engines: { motrix: '>=2.0.0 <3.0.0' },
            main: 'smoke.mjs',
            requestedHeapMB: 32,
            permissions: [],
            hostPermissions: [],
            activationEvents: [],
            contributes: {},
          },
          bundleSource: 'export const ready = true',
          app: {
            version: '2.0.0',
            platform: process.platform,
            runtime: 'server',
            locale: 'en-US',
            arch: process.arch,
          },
          i18n: {
            language: 'en-US',
            dir: 'ltr',
            currentDict: {},
            fallbackDict: {},
          },
          limits: { heapMB: 32, stackKB: 256 },
        })
      }),
      timeoutMs,
      'QuickJS worker startup'
    )
    const exit = new Promise((resolve, reject) => {
      worker.once('error', reject)
      worker.once('exit', resolve)
    })
    worker.postMessage({ type: 'event', event: 'shutdown' })
    const code = await withTimeout(exit, timeoutMs, 'QuickJS worker shutdown')
    if (code !== 0) throw new Error(`QuickJS worker exited with code ${code}`)
  } finally {
    await worker.terminate().catch(() => undefined)
  }
}

async function waitForHealth(url, childState, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (childState.exit) {
      throw new Error(
        `staged Server exited before health check: ${childState.exit}; logs:\n${childState.logs}`
      )
    }
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok && (await response.json()).ok === true) return
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `staged Server did not become healthy within ${timeoutMs}ms; logs:\n${childState.logs}`
  )
}

async function assertOperatorAuth(url, token) {
  const unauthenticated = await fetch(`${url}/rpc/query/runtime-smoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: [] }),
  })
  if (unauthenticated.status !== 401) {
    throw new Error(
      `unauthenticated operator request returned ${unauthenticated.status}, expected 401`
    )
  }
  const status = await fetch(`${url}/rpc/auth/status`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!status.ok || (await status.json()).authed !== true) {
    throw new Error('Bearer operator authentication failed')
  }
  const authenticated = await fetch(`${url}/rpc/query/runtime-smoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ args: [] }),
  })
  if (authenticated.status !== 404) {
    throw new Error(
      `authenticated operator request returned ${authenticated.status}, expected route-level 404`
    )
  }
}

async function stopServer(child, childState, timeoutMs) {
  if (childState.exit) return childState.exit
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  try {
    return await withTimeout(
      exited,
      timeoutMs,
      'staged Server SIGTERM shutdown'
    )
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (!['app-dir', 'aria2-bin', 'timeout-ms'].includes(key)) {
      throw new Error(`unknown option: --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    index += 1
  }
  if (!options['app-dir']) throw new Error('--app-dir is required')
  return options
}

export async function smokeServerPackage(options) {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor !== 24) {
    throw new Error(
      `Server runtime smoke requires Node 24, found ${process.versions.node}`
    )
  }
  const stageRoot = path.resolve(options.appDir)
  const bundledAria2 = path.join(
    stageRoot,
    'bin',
    process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  )
  const aria2Source = path.resolve(
    options.aria2Bin ?? process.env.MOTRIX_ARIA2_BIN ?? bundledAria2
  )
  if (!(await stat(stageRoot)).isDirectory()) {
    throw new Error('staged Server app is not a directory')
  }
  if (!(await stat(aria2Source).catch(() => null))?.isFile()) {
    throw new Error('aria2 binary is not a file')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(
      'Server smoke timeout must be an integer of at least 1000ms'
    )
  }
  const manifest = JSON.parse(
    await readFile(path.join(stageRoot, 'package.json'), 'utf8')
  )
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort()
  const scratchRoot = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-server-smoke-')
  )
  const startedAt = Date.now()
  let child
  const childState = { exit: null, logs: '' }
  try {
    await assertDirectRootsResolve(stageRoot, dependencies)
    assertSqlite(stageRoot, scratchRoot)
    await assertQuickJsWorker(stageRoot, timeoutMs)
    await assertOperatorCli(stageRoot, timeoutMs)

    const port = await availablePort()
    const systemRoot = path.join(scratchRoot, 'system')
    const aria2Bin = path.join(systemRoot, 'aria2c')
    const dataDir = path.join(scratchRoot, 'data')
    const homeDir = path.join(scratchRoot, 'home')
    await Promise.all([
      mkdir(systemRoot, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
      mkdir(path.join(homeDir, 'Downloads'), { recursive: true }),
    ])
    await copyFile(aria2Source, aria2Bin)
    await chmod(aria2Bin, 0o755)
    const operatorToken = 'motrix-runtime-smoke-operator-token'
    child = spawn(process.execPath, [manifest.main], {
      cwd: stageRoot,
      env: {
        ...process.env,
        HOME: homeDir,
        LOG_LEVEL: 'info',
        MOTRIX_ARIA2_BIN: aria2Bin,
        MOTRIX_BUILTIN_PLUGIN_DIR: path.join(stageRoot, 'builtin-plugins'),
        MOTRIX_DATA_DIR: dataDir,
        MOTRIX_EXTRA_DIR: path.join(stageRoot, 'extra'),
        MOTRIX_MDXP_PORT: '0',
        MOTRIX_OPERATOR_TOKEN: operatorToken,
        MOTRIX_PLUGIN_DIR: path.join(dataDir, 'plugins'),
        MOTRIX_RENDERER_DIR: path.join(stageRoot, 'dist/renderer-web'),
        NODE_ENV: 'production',
        NODE_PATH: undefined,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const collectLogs = (chunk) => {
      childState.logs = `${childState.logs}${chunk}`.slice(-MAX_LOG_BYTES)
    }
    child.stdout.on('data', collectLogs)
    child.stderr.on('data', collectLogs)
    child.once('error', (error) => {
      childState.exit = `spawn error: ${error.message}`
    })
    child.once('exit', (code, signal) => {
      childState.exit = `code=${code} signal=${signal}`
    })

    const url = `http://127.0.0.1:${port}`
    await waitForHealth(url, childState, timeoutMs)
    await assertOperatorAuth(url, operatorToken)
    const database = await stat(path.join(dataDir, 'motrix.db'))
    if (!database.isFile() || database.size === 0) {
      throw new Error('Server did not create its isolated Motrix database')
    }
    const exit = await stopServer(child, childState, timeoutMs)
    if (exit !== 0) {
      throw new Error(`staged Server shutdown exited with code ${exit}`)
    }
    child = undefined
    return {
      node: process.versions.node,
      directRoots: dependencies.length,
      sqlite: true,
      quickJsWorker: true,
      health: true,
      operatorAuth: true,
      operatorCli: true,
      databaseBytes: database.size,
      shutdown: 'SIGTERM',
      durationMs: Date.now() - startedAt,
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGKILL')
      await exited.catch(() => undefined)
    }
    await rm(scratchRoot, { recursive: true }).catch(() => undefined)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = parseArguments(process.argv.slice(2))
  const timeoutMs = raw['timeout-ms']
    ? Number.parseInt(raw['timeout-ms'], 10)
    : undefined
  smokeServerPackage({
    appDir: raw['app-dir'],
    aria2Bin: raw['aria2-bin'],
    timeoutMs,
  })
    .then((result) => {
      console.log(`Server runtime smoke passed: ${JSON.stringify(result)}`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
