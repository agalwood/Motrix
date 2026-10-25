import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations.ts'
import { Queries } from '../src/shared/protocol/queries.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    app: { type: 'string', default: ROOT },
    'settle-ms': { type: 'string', default: '50000' },
    'interval-ms': { type: 'string', default: '1000' },
    samples: { type: 'string', default: '5' },
    out: {
      type: 'string',
      default: 'output/playwright/manual/desktop-memory/results.json',
    },
  },
})
const settleMs = Number(values['settle-ms'])
const intervalMs = Number(values['interval-ms'])
const samples = Number(values.samples)
if (
  !Number.isInteger(settleMs) ||
  settleMs < 0 ||
  settleMs > 600_000 ||
  !Number.isInteger(intervalMs) ||
  intervalMs < 100 ||
  intervalMs > 60_000 ||
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 600
)
  throw new Error('Invalid settle time, interval, or sample count')
const execute = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

// Electron's metrics omit native children such as aria2 and the finalizer.
// On Linux, sample the whole descendant tree and report incomplete reads
// explicitly; never turn permission failures or exited processes into zero PSS.
async function linuxProcessMemory(mainPid) {
  if (process.platform !== 'linux') return null
  const { stdout } = await execute('ps', ['-e', '-o', 'pid=,ppid='])
  const tree = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number)
      return { pid, parent }
    })
  const pids = new Set([mainPid])
  for (let changed = true; changed; ) {
    changed = false
    for (const row of tree) {
      if (pids.has(row.parent) && !pids.has(row.pid)) {
        pids.add(row.pid)
        changed = true
      }
    }
  }
  const processes = await Promise.all(
    [...pids].map(async (pid) => {
      try {
        const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')
        const rss = /^Rss:\s+(\d+) kB$/m.exec(text)
        const pss = /^Pss:\s+(\d+) kB$/m.exec(text)
        if (!rss || !pss) throw new Error('Missing RSS/PSS fields')
        return { pid, rssKiB: Number(rss[1]), pssKiB: Number(pss[1]) }
      } catch (error) {
        return { pid, error: error.code ?? error.message }
      }
    })
  )
  const complete = processes.every((entry) => entry.pssKiB !== undefined)
  return {
    complete,
    rssKiB: complete
      ? processes.reduce((sum, entry) => sum + entry.rssKiB, 0)
      : null,
    pssKiB: complete
      ? processes.reduce((sum, entry) => sum + entry.pssKiB, 0)
      : null,
    processes,
  }
}

const destination = path.resolve(values.out)
const appDirectory = path.resolve(values.app)
const mainSha256 = createHash('sha256')
  .update(await readFile(path.join(appDirectory, 'dist/main/index.cjs')))
  .digest('hex')
await mkdir(path.dirname(destination), { recursive: true })
const userData = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'motrix-memory-'))
)
let application
try {
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      onboarding: { disclaimerAccepted: true },
      app: {
        language: 'en-US',
        autofillClipboardLinks: false,
        warnBeforeQuit: false,
        traySpeedometer: false,
        browserBridgeEnabled: false,
        lightweightMode: false,
      },
      tracker: { autoSync: false },
      nat: { enabled: false },
    })
  )
  const launchedAt = Date.now()
  application = await electron.launch({
    args: [appDirectory],
    cwd: userData,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MOTRIX_USER_DATA: userData,
      MOTRIX_RPC_PORT: String(await freePort()),
      MOTRIX_DEFAULT_SAVE_DIR: path.join(userData, 'downloads'),
    },
  })
  const page = await application.firstWindow()
  await page.waitForFunction(
    async (channel) => {
      try {
        return (await window.motrix.invoke(channel)).state === 'ready'
      } catch {
        return false
      }
    },
    Queries.GetEngineStatus,
    { timeout: 30_000 }
  )
  const engineReadyMs = Date.now() - launchedAt
  console.log(
    `Engine ready; settling for ${settleMs} ms before ${samples} samples`
  )
  await sleep(settleMs)
  const report = {
    schemaVersion: 1,
    mainSha256,
    capturedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
    },
    scenario: {
      profile:
        'Fresh temporary profile, no tasks, built-in plugins, both renderer windows retained',
      disabled: [
        'clipboard autofill',
        'tray speedometer',
        'browser bridge',
        'tracker auto-sync',
        'NAT',
      ],
      measurement:
        'No forced GC. Main-process Node memory and Electron working sets. Linux additionally includes descendant RSS/PSS from smaps_rollup.',
      limits:
        'RSS/working-set sums double-count shared pages. macOS/Windows results are not Linux PSS. This development executable loads production bundles; compare packaged release baselines separately.',
      engineReadyMs,
      settleMs,
      intervalMs,
      samples,
    },
    samples: [],
  }
  for (let index = 0; index < samples; index++) {
    if (index) await sleep(intervalMs)
    const snapshot = await application.evaluate(({ app, BrowserWindow }) => {
      const require = process
        .getBuiltinModule('module')
        .createRequire(`${process.cwd()}/memory-probe.cjs`)
      return {
        pid: process.pid,
        versions: {
          app: app.getVersion(),
          electron: process.versions.electron,
          chrome: process.versions.chrome,
        },
        main: process.memoryUsage(),
        electron: app
          .getAppMetrics()
          .map(({ pid, type, memory }) => ({ pid, type, memoryKiB: memory })),
        windows: BrowserWindow.getAllWindows().map((window) => ({
          route: new URL(window.webContents.getURL()).searchParams.get('w'),
          visible: window.isVisible(),
        })),
        // This covers CommonJS startup imports; it is not a complete ESM/worker inventory.
        commonJsWasmPackages: Object.keys(require.cache)
          .filter((file) =>
            /[\\/](libsodium(?:-wrappers)?|@resvg|@jitl)[\\/]/.test(file)
          )
          .map((file) =>
            file.replaceAll('\\', '/').split('node_modules/').at(-1)
          ),
      }
    })
    const linux = await linuxProcessMemory(snapshot.pid)
    report.samples.push({
      elapsedMs: Date.now() - launchedAt,
      ...snapshot,
      linux,
    })
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
    console.log(
      `Sample ${index + 1}/${samples}: main RSS ${(snapshot.main.rss / 1048576).toFixed(1)} MiB${linux?.complete ? `; process-tree PSS ${(linux.pssKiB / 1024).toFixed(1)} MiB` : ''}`
    )
  }
  console.log(`Report: ${destination}`)
} finally {
  await application?.close().catch(() => {})
  await rm(userData, { recursive: true, force: true })
}
