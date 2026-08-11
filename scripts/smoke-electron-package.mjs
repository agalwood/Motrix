#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { chromium } from 'playwright'
import { parseTarget, stringifySortedJson } from './electron-package-utils.mjs'

const execFileAsync = promisify(execFile)
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const RUNTIME_HELPER = path.join(
  REPOSITORY_ROOT,
  'scripts/electron-package-runtime-helper.cjs'
)
const RUNTIME_ERROR_PATTERNS = {
  moduleResolution:
    /MODULE_NOT_FOUND|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND/i,
  nativeAbi:
    /NODE_MODULE_VERSION|different Node\.js version|dlopen|wrong architecture|incompatible architecture/i,
}

export function parseSmokeArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  const options = { adHocSign: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--ad-hoc-sign') {
      options.adHocSign = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected argument: ${argument}`)
    }
    const key = argument.slice(2)
    if (!['app-dir', 'arch', 'platform', 'report'].includes(key)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    options[
      {
        'app-dir': 'appDir',
        arch: 'arch',
        platform: 'platform',
        report: 'report',
      }[key]
    ] = value
    index += 1
  }
  if (!options.appDir) throw new Error('--app-dir is required')
  const target = parseTarget({
    platform: options.platform,
    arch: options.arch,
    strict: true,
  })
  return { ...options, ...target }
}

export function resolvePackagedLayout(appDir, platform) {
  const absoluteAppDir = path.resolve(appDir)
  if (platform === 'darwin') {
    return {
      appDir: absoluteAppDir,
      executable: path.join(absoluteAppDir, 'Contents/MacOS/Motrix'),
      resources: path.join(absoluteAppDir, 'Contents/Resources'),
    }
  }
  if (platform === 'win32') {
    return {
      appDir: absoluteAppDir,
      executable: path.join(absoluteAppDir, 'Motrix.exe'),
      resources: path.join(absoluteAppDir, 'resources'),
    }
  }
  return {
    appDir: absoluteAppDir,
    executable: path.join(absoluteAppDir, 'motrix'),
    resources: path.join(absoluteAppDir, 'resources'),
  }
}

export function scanRuntimeLog(log) {
  return {
    moduleResolutionError: RUNTIME_ERROR_PATTERNS.moduleResolution.test(log),
    nativeAbiError: RUNTIME_ERROR_PATTERNS.nativeAbi.test(log),
  }
}

async function getFreePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  if (!port) throw new Error('failed to allocate package smoke RPC port')
  return port
}

async function runElectronNodeHelper(mode, args) {
  const child = spawn(electronPath, [RUNTIME_HELPER, mode, ...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${mode} helper exited on ${signal}`))
      else resolve(code)
    })
  })
  if (exitCode !== 0) {
    throw new Error(`${mode} helper failed: ${stderr.trim() || stdout.trim()}`)
  }
  return JSON.parse(stdout)
}

async function stopPackagedApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('packaged app did not stop after SIGTERM')),
        15_000
      )
    ),
  ])
}

async function connectToRenderer(debugPort, child, readStderr) {
  const endpoint = `http://127.0.0.1:${debugPort}`
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `packaged app exited before renderer debugging was ready: ${readStderr()}`
      )
    }
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 1000 })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error(
    `packaged renderer debugging did not open within 30000ms: ${lastError?.message ?? 'unknown error'}`
  )
}

async function findMainPage(browser) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().includes('w=main'))
    if (page) return page
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('packaged main renderer did not open within 30000ms')
}

async function runPackagedApplication(layout, tempDir) {
  const rpcPort = await getFreePort()
  const debugPort = await getFreePort()
  const progressPath = path.join(tempDir, 'runtime-smoke-step.txt')
  const markProgress = (step) => writeFile(progressPath, `${step}\n`)
  await writeFile(
    path.join(tempDir, 'settings.json'),
    JSON.stringify({
      version: 8,
      onboarding: { disclaimerAccepted: true },
      app: {
        browserBridgeEnabled: false,
        checkForUpdatesOnLaunch: false,
        traySpeedometer: true,
        warnBeforeQuit: false,
      },
    })
  )

  const rendererErrors = []
  let browser
  let stderr = ''
  const child = spawn(
    layout.executable,
    [
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${debugPort}`,
    ],
    {
      cwd: tempDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        MOTRIX_DEFAULT_SAVE_DIR: path.join(tempDir, 'downloads'),
        MOTRIX_RPC_PORT: String(rpcPort),
        MOTRIX_USER_DATA: tempDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  try {
    await markProgress('launching')
    browser = await connectToRenderer(debugPort, child, () => stderr.trim())
    await markProgress('launched')
    const page = await findMainPage(browser)
    await markProgress('first-window')
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    await page.waitForLoadState('domcontentloaded')
    await markProgress('dom-content-loaded')
    await page.waitForFunction(
      () => document.documentElement.classList.contains('window-main'),
      undefined,
      { timeout: 20_000 }
    )
    await markProgress('main-window-ready')
    await page
      .locator('[data-sidebar="sidebar"]')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
    await markProgress('sidebar-visible')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return {
      rendererErrors,
      title: await page.title(),
      urlHasMainWindow: page.url().includes('w=main'),
      windowReady: true,
    }
  } finally {
    await markProgress('stopping')
    await stopPackagedApp(child)
    await browser?.close().catch(() => {})
    await markProgress('stopped')
  }
}

async function assertLayout(layout) {
  for (const required of [
    layout.executable,
    path.join(layout.resources, 'app.asar'),
    path.join(layout.resources, 'app.asar.unpacked'),
  ]) {
    await access(required)
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseSmokeArguments(argv)
  if (options.platform !== process.platform || options.arch !== process.arch) {
    throw new Error(
      `runtime smoke requires a host-native package; host is ${process.platform}-${process.arch}, target is ${options.key}`
    )
  }

  const layout = resolvePackagedLayout(options.appDir, options.platform)
  await assertLayout(layout)
  if (options.adHocSign) {
    if (options.platform !== 'darwin') {
      throw new Error(
        '--ad-hoc-sign is supported only for macOS directory output'
      )
    }
    await execFileAsync('codesign', [
      '--force',
      '--deep',
      '--sign',
      '-',
      layout.appDir,
    ])
    await execFileAsync('codesign', [
      '--verify',
      '--deep',
      '--strict',
      layout.appDir,
    ])
  }

  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), `motrix-package-${options.key}-`)
  )
  try {
    const application = await runPackagedApplication(layout, tempDir)
    const log = await readFile(path.join(tempDir, 'logs/motrix.log'), 'utf8')
    const logScan = scanRuntimeLog(log)
    if (
      !application.urlHasMainWindow ||
      application.rendererErrors.length > 0
    ) {
      throw new Error(
        `packaged renderer failed: ${application.rendererErrors.join('; ')}`
      )
    }
    if (logScan.moduleResolutionError || logScan.nativeAbiError) {
      throw new Error(
        'packaged startup log contains a module resolution or ABI error'
      )
    }

    const appAsar = path.join(layout.resources, 'app.asar')
    const databasePath = path.join(tempDir, 'motrix.db')
    const database = await runElectronNodeHelper('database', [
      path.join(appAsar, 'node_modules/better-sqlite3'),
      databasePath,
    ])
    const quickjs = await runElectronNodeHelper('quickjs', [
      path.join(appAsar, 'dist/core/plugin/host/quick-js-worker.cjs'),
    ])
    const tray =
      options.platform === 'darwin'
        ? await runElectronNodeHelper('tray', [
            path.join(appAsar, 'node_modules/@resvg/resvg-wasm'),
            path.join(layout.resources, 'extra/tray'),
            path.join(tempDir, 'tray-speedometer.png'),
          ])
        : { skipped: true }

    const databaseStat = await stat(databasePath)
    const report = {
      schemaVersion: 1,
      target: options.key,
      electronVersion: database.electronVersion,
      application: {
        ...application,
        databaseBytes: databaseStat.size,
        logLines: log.trim().split('\n').length,
        ...logScan,
      },
      database,
      quickjs,
      tray,
    }
    const reportPath = path.resolve(
      options.report ??
        path.join(
          REPOSITORY_ROOT,
          `release/size-reports/${options.key}-runtime.json`
        )
    )
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, stringifySortedJson(report))
    process.stdout.write(`${stringifySortedJson(report)}`)
    process.stdout.write(`Runtime smoke report: ${reportPath}\n`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
