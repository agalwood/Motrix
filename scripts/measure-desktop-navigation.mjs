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
import { parseArgs } from 'node:util'
import { _electron as electron } from 'playwright'
import { CURRENT_SETTINGS_VERSION } from '../src/core/settings/migrations.ts'
import { Queries } from '../src/shared/protocol/queries.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: {
    variant: { type: 'string', multiple: true },
    samples: { type: 'string', default: '5' },
    'cpu-rates': { type: 'string', default: '1,4' },
    nodes: { type: 'string', default: '48' },
    out: {
      type: 'string',
      default: 'output/playwright/manual/desktop-navigation/results.json',
    },
  },
})
const samples = Number(values.samples)
const nodeCount = Number(values.nodes)
const cpuRates = values['cpu-rates'].split(',').map(Number)
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 100 ||
  !Number.isInteger(nodeCount) ||
  nodeCount < 2 ||
  nodeCount > 200 ||
  cpuRates.some((rate) => !Number.isFinite(rate) || rate < 1 || rate > 20)
) {
  throw new Error('Invalid sample count, node count, or CPU rate')
}
const variants = (values.variant ?? ['current=.']).map((value) => {
  const separator = value.indexOf('=')
  if (separator < 1) throw new Error('Use --variant label=app-directory')
  const label = value.slice(0, separator)
  if (!/^[a-z0-9-]+$/.test(label))
    throw new Error('Use a portable variant label')
  return { label, directory: path.resolve(value.slice(separator + 1)) }
})

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

async function seed(userData) {
  await writeFile(
    path.join(userData, 'settings.json'),
    JSON.stringify({
      version: CURRENT_SETTINGS_VERSION,
      app: { language: 'en-US', theme: 'light', warnBeforeQuit: false },
      tracker: { autoSync: false },
      onboarding: { disclaimerAccepted: true },
    })
  )
  const audit = path.join(userData, 'plugins', '_audit')
  await mkdir(audit, { recursive: true })
  const now = Date.now()
  const records = []
  for (let index = 0; index < nodeCount - 1; index += 1) {
    for (const offset of [1, 5]) {
      if (index + offset >= nodeCount) continue
      records.push({
        ts: now - 1000,
        type: 'command.invoke',
        caller: `benchmark.plugin-${index}`,
        callee: `benchmark.plugin-${index + offset}`,
        commandId: `benchmark.plugin-${index + offset}.run`,
        argsSize: 24,
        resultSize: 48,
        durMs: 6,
        depth: 1,
        ok: true,
      })
    }
  }
  await writeFile(
    path.join(audit, 'command-invokes.ndjson'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
  )
}

// These probes run only in the measurement page, never in shipped application code.
async function installProbe(page) {
  await page.evaluate(() => {
    window.__navigationProbe = {
      start(readySelector, durationMs = 0) {
        const start = performance.now()
        const longTasks = []
        let previousFrame = start
        let maxFrameGapMs = 0
        let readyAt = null
        let framesAfterReady = 0
        const observer = new PerformanceObserver((list) => {
          longTasks.push(...list.getEntries().map((entry) => entry.duration))
        })
        observer.observe({ type: 'longtask' })
        this.result = null
        const tick = (timestamp) => {
          maxFrameGapMs = Math.max(maxFrameGapMs, timestamp - previousFrame)
          previousFrame = timestamp
          const element = durationMs
            ? null
            : document.querySelector(readySelector.selector ?? readySelector)
          const ready = durationMs
            ? timestamp - start >= durationMs
            : Boolean(
                element &&
                  (!readySelector.text ||
                    element.textContent === readySelector.text) &&
                  element.getBoundingClientRect().height > 0 &&
                  getComputedStyle(element).visibility !== 'hidden'
              )
          if (ready && readyAt === null) readyAt = timestamp
          if (readyAt !== null && ++framesAfterReady >= 2) {
            setTimeout(() => {
              longTasks.push(
                ...observer.takeRecords().map((entry) => entry.duration)
              )
              observer.disconnect()
              this.result = {
                readyMs: timestamp - start,
                maxFrameGapMs,
                longTaskCount: longTasks.length,
                maxLongTaskMs: Math.max(0, ...longTasks),
                blockingMs: longTasks.reduce(
                  (total, duration) => total + Math.max(0, duration - 50),
                  0
                ),
              }
            }, 0)
          } else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      },
    }
  })
}

async function finishProbe(page) {
  await page.waitForFunction(
    () => window.__navigationProbe.result !== null,
    null,
    { timeout: 30_000 }
  )
  return page.evaluate(() => window.__navigationProbe.result)
}

async function navigate(page, href, readySelector) {
  const link = page.locator(`a[href="${href}"]`).first()
  await link.waitFor({ state: 'visible' })
  // DOM activation intentionally excludes pointer-hover lead time and automation
  // round trips from the cold-click interval. Intent warming is measured separately.
  await link.evaluate((element, selector) => {
    window.__navigationProbe.start(selector)
    element.click()
  }, readySelector)
  return finishProbe(page)
}

async function sample(variant, cpuRate, mode) {
  const userData = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-navigation-'))
  )
  let app
  try {
    await seed(userData)
    const rpcPort = await freePort()
    const launchedAt = performance.now()
    app = await electron.launch({
      args: [variant.directory],
      cwd: userData,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MOTRIX_USER_DATA: userData,
        MOTRIX_RPC_PORT: String(rpcPort),
        MOTRIX_DEFAULT_SAVE_DIR: path.join(userData, 'downloads'),
      },
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(30_000)
    await page.getByRole('link', { name: 'Plugins', exact: true }).waitFor()
    const launchToShellMs = performance.now() - launchedAt
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes('w=main')
      )
      main?.show()
      main?.focus()
    })
    await page.waitForFunction(async (channel) => {
      try {
        await window.motrix.invoke(channel)
        return true
      } catch {
        return false
      }
    }, Queries.GetEngineStatus)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
    await installProbe(page)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const settings = await navigate(page, '#/settings', {
      selector: '[data-slot="panel-shell-header"] h1',
      text: 'Settings',
    })
    const downloads = await navigate(
      page,
      '#/downloads',
      '[data-slot="downloads-speed-limit"]'
    )
    const plugins = await navigate(
      page,
      '#/plugins',
      '[data-testid="plugins-tool-row"]'
    )
    let intent = null
    if (mode !== 'direct') {
      await page.evaluate(
        (duration) => window.__navigationProbe.start(null, duration),
        mode === 'intent' ? 300 : 500
      )
      if (mode === 'intent') {
        await page
          .getByRole('link', { name: 'Diagnostics', exact: true })
          .hover()
      }
      intent = await finishProbe(page)
    }
    const firstGraph = await navigate(
      page,
      '#/plugins/diagnostics',
      '.react-flow__node'
    )
    await navigate(page, '#/plugins', '[data-testid="plugins-tool-row"]')
    const repeatGraph = await navigate(
      page,
      '#/plugins/diagnostics',
      '.react-flow__node'
    )
    if (errors.length) throw new Error(errors.join('; '))
    return {
      variant: variant.label,
      cpuRate,
      mode,
      launchToShellMs,
      settings,
      downloads,
      plugins,
      intent,
      firstGraph,
      repeatGraph,
    }
  } finally {
    await app?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }
}

const report = {
  schemaVersion: 1,
  environment: {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
    node: process.versions.node,
  },
  methodology: {
    samples,
    cpuRates,
    nodeCount,
    startup:
      'Fresh Electron process and user data; OS file cache is not flushed. CPU throttle begins after shell readiness.',
    navigation:
      'Programmatic link activation to visible DOM readiness followed by a paint opportunity; 300 ms pointer-intent and 500 ms plugin-page idle scenarios reported separately.',
    throttle:
      'CDP renderer CPU throttle is a stress condition, not a low-end hardware emulation.',
    blocking:
      'Sum of renderer long-task duration above 50 ms; frame gap is requestAnimationFrame spacing, not measured input latency.',
  },
  variants: await Promise.all(
    variants.map(async (variant) => ({
      label: variant.label,
      mainSha256: createHash('sha256')
        .update(
          await readFile(path.join(variant.directory, 'dist/main/index.cjs'))
        )
        .digest('hex'),
      rendererHtmlSha256: createHash('sha256')
        .update(
          await readFile(
            path.join(variant.directory, 'dist/renderer/index.html')
          )
        )
        .digest('hex'),
    }))
  ),
  runs: [],
}
const destination = path.resolve(values.out)
await mkdir(path.dirname(destination), { recursive: true })
// Alternate variants in each round so cache/temperature drift does not always
// favor the candidate. Preserve every sample; never discard slow observations.
for (const cpuRate of cpuRates) {
  for (const mode of ['direct', 'intent', 'idle']) {
    for (let index = 0; index < samples; index += 1) {
      const order = index % 2 ? [...variants].reverse() : variants
      for (const variant of order) {
        const result = await sample(variant, cpuRate, mode)
        report.runs.push({ sample: index + 1, ...result })
        await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`)
        process.stdout.write(
          `${variant.label} ${cpuRate}x ${mode} ${index + 1}/${samples}: graph ${result.firstGraph.readyMs.toFixed(1)} ms, blocking ${result.firstGraph.blockingMs.toFixed(1)} ms\n`
        )
      }
    }
  }
}
process.stdout.write(`Report: ${path.relative(ROOT, destination)}\n`)
