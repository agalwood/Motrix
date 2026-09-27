import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { ftruncateSync, writeSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  productionBrowserOrder,
  runStoreExtensionRuntime,
} from './test-windows-store-extension-runtime.mjs'
import { runFirefoxStoreExtension } from './test-windows-store-firefox-extension.mjs'
import {
  queryInstalledState,
  readInstalledFile,
  runBoundedProbeProcess,
  validateInstalledProbeState,
} from './test-windows-store-native-messaging-alias.mjs'
import { verifyWindowsStoreLayout } from './verify-windows-store-layout.mjs'
import { renderWindowsStoreManifest } from './windows-store-manifest.mjs'
import {
  WINDOWS_STORE_NATIVE_HOST_PROFILE_DIAGNOSTIC as HOST,
  WINDOWS_STORE_MAIN_DIAGNOSTIC as MAIN,
} from './windows-store-metadata.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const clearedEnvironment = {
  MOTRIX_USER_DATA: null,
  MOTRIX_BRIDGE_DATA_DIR: null,
}
const fail = (code) => {
  throw new Error(code)
}

// Fatal loader errors and unhandled rejections can bypass main's finally.
// Retain only fixed classifications; never serialize Error.message/stack or
// protocol state. Observing uncaughtExceptionMonitor preserves Node's failure.
export function installRuntimeFailureRecorder(fd, currentStage) {
  let fatal
  const writeFailure = () => {
    const bytes = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scope: 'windows-installed-main-bridge-startup',
          ok: false,
          failureStage: currentStage(),
          failureCode: fatal
            ? 'uncaught-runtime-error'
            : 'incomplete-runtime-check',
          ...(fatal ? { fatal } : {}),
          mainBridgeEndpointVerified: false,
          coldLaunchVerified: false,
          packageUriLaunchVerified: false,
          installedMbp1TransportVerified: false,
          installedBootstrapTicketProofVerified: false,
          mbp1ClientCleanupVerified: false,
          syntheticMbp1Client: true,
          mbp1Verified: false,
          windows11AcceptanceVerified: false,
          storeReady: false,
        },
        null,
        2
      )}\n`
    )
    writeSync(fd, bytes, 0, bytes.length, 0)
    ftruncateSync(fd, bytes.length)
  }
  const observe = (error, origin) => {
    const names = [
      'Error',
      'TypeError',
      'ReferenceError',
      'SyntaxError',
      'RangeError',
    ]
    const codes = [
      'ENOENT',
      'EACCES',
      'EPERM',
      'EPIPE',
      'ECONNRESET',
      'ETIMEDOUT',
      'ERR_MODULE_NOT_FOUND',
      'ERR_UNKNOWN_FILE_EXTENSION',
      'ERR_UNSUPPORTED_ESM_URL_SCHEME',
      'ERR_REQUIRE_ASYNC_MODULE',
      'ERR_INVALID_URL',
      'ERR_INVALID_ARG_TYPE',
      'ERR_INVALID_ARG_VALUE',
    ]
    // Match only known code locations in stack frames after the message.
    // Discard all paths, function names and unknown frames.
    const modules = [
      ['mbp1-client', /[/\\]mbp1-client\.ts:(\d+):(\d+)/],
      ['installed-client', /[/\\]windows-store-mbp1-client\.ts:(\d+):(\d+)/],
      ['ws-receiver', /[/\\]ws[/\\]lib[/\\]receiver\.js:(\d+):(\d+)/],
      ['ws-websocket', /[/\\]ws[/\\]lib[/\\]websocket\.js:(\d+):(\d+)/],
      [
        'jsonrpc-connection',
        /[/\\]vscode-jsonrpc[/\\]lib[/\\]common[/\\]connection\.js:(\d+):(\d+)/,
      ],
      [
        'jsonrpc-events',
        /[/\\]vscode-jsonrpc[/\\]lib[/\\]common[/\\]events\.js:(\d+):(\d+)/,
      ],
      ['node-events', /node:events:(\d+):(\d+)/],
      [
        'node-task-queues',
        /node:internal[/\\]process[/\\]task_queues:(\d+):(\d+)/,
      ],
    ]
    const frames = []
    if (typeof error?.stack === 'string') {
      for (const frame of error.stack.split('\n').slice(1, 21)) {
        if (!/^\s+at /.test(frame)) continue
        for (const [module, pattern] of modules) {
          const match = pattern.exec(frame)
          if (match) {
            frames.push({
              module,
              line: Number(match[1]),
              column: Number(match[2]),
            })
            break
          }
        }
      }
    }
    fatal = {
      name: names.includes(error?.name) ? error.name : 'other',
      code: codes.includes(error?.code) ? error.code : 'other',
      origin: origin === 'unhandledRejection' ? origin : 'uncaughtException',
      frames,
    }
  }
  writeFailure()
  process.on('uncaughtExceptionMonitor', observe)
  process.on('exit', writeFailure)
  return () => {
    process.off('uncaughtExceptionMonitor', observe)
    process.off('exit', writeFailure)
    ftruncateSync(fd, 0)
  }
}

export function validateMainProcess(
  value,
  { pid, installed, startTicks, requireListener = true }
) {
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    !value ||
    value.pid !== pid ||
    value.sameSession !== true ||
    !Number.isInteger(value.sessionId) ||
    typeof value.startTicks !== 'string' ||
    !/^\d{15,20}$/.test(value.startTicks) ||
    (startTicks !== undefined && value.startTicks !== startTicks) ||
    typeof value.executable !== 'string' ||
    path.win32.normalize(value.executable).toLowerCase() !==
      path.win32
        .join(installed.installLocation, MAIN.executable)
        .toLowerCase() ||
    value.packageFullName !== installed.packageFullName ||
    value.applicationUserModelId !==
      `${installed.packageFamilyName}!${MAIN.applicationId}` ||
    !Array.isArray(value.listeners) ||
    (requireListener && value.listeners.length === 0) ||
    value.listeners.some(
      (entry) =>
        entry.pid !== pid || !['127.0.0.1', '::1'].includes(entry.address)
    )
  )
    fail('main-process-identity-mismatch')
  return value.startTicks
}

function decodeMainHostReply(result, { ticketRequired = false } = {}) {
  if (
    result?.exitCode !== 0 ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.length !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length < 5 ||
    result.stdout.length > 4100 ||
    result.stdout.readUInt32LE(0) !== result.stdout.length - 4
  )
    fail('invalid-host-frame')
  let value
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        result.stdout.subarray(4)
      )
    )
  } catch {
    fail('invalid-host-json')
  }
  if (isDeepStrictEqual(value, { error: 'motrix-not-running' })) return null
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      (ticketRequired
        ? 'action,nmTicket,nonce,port,protocolVersion'
        : 'action,nonce,port,protocolVersion') ||
    (ticketRequired &&
      (!value.nmTicket ||
        typeof value.nmTicket !== 'object' ||
        Array.isArray(value.nmTicket))) ||
    value.action !== 'requestPair' ||
    value.protocolVersion !== 1 ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(value.nonce)
  )
    fail('unexpected-host-reply')
  return value
}

export function validateMainHostReply(result, options) {
  const value = decodeMainHostReply(result, options)
  if (!value) return null
  // Public evidence remains redacted; only the in-memory pairing controller
  // below consumes the nonce from the private decoder.
  return { port: value.port, stdoutBytes: result.stdout.length }
}

export function isMainRendererUrl(raw, installLocation, route) {
  try {
    const url = new URL(raw)
    const expected = path.win32.join(
      installLocation,
      'app/resources/app.asar/dist/renderer/index.html'
    )
    const pathname = decodeURIComponent(url.pathname)
      .replace(/^\//, '')
      .replaceAll('/', '\\')
    return (
      url.protocol === 'file:' &&
      url.hostname === '' &&
      url.hash === '' &&
      pathname.toLowerCase() === expected.toLowerCase() &&
      url.searchParams.get('w') === route
    )
  } catch {
    return false
  }
}

async function queryProcess(pid = 0, port = 0) {
  const result = await runBoundedProbeProcess({
    executable: path.win32.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      fileURLToPath(
        new URL('./query-windows-store-main-process.ps1', import.meta.url)
      ),
      '-TargetPid',
      String(pid),
      '-Port',
      String(port),
    ],
    maxStdoutBytes: 16384,
  })
  if (result.exitCode !== 0 || result.stderr.length !== 0)
    fail('process-query-failed')
  try {
    return JSON.parse(result.stdout.toString('utf8'))
  } catch {
    fail('process-query-failed')
  }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function waitForPage(browser, installLocation, route) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pages = browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => isMainRendererUrl(page.url(), installLocation, route))
    if (pages.length > 1) fail('ambiguous-main-renderer')
    if (pages.length === 1) return pages[0]
    await delay(200)
  }
  fail('renderer-timeout')
}

async function readPairingCode(page) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const codes = await page
      .locator('span.font-mono')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => node.textContent?.trim() ?? '')
          .filter((text) =>
            /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u.test(text)
          )
      )
    if (codes.length > 1) fail('ambiguous-pairing-ui')
    if (codes.length === 1) return codes[0]
    await delay(200)
  }
  fail('pairing-ui-timeout')
}

async function runMainCase(installed, pairing, progress) {
  const report = {
    ok: false,
    mainApplicationLaunched: false,
    processIdentityVerified: false,
    disclaimerUiVerified: false,
    mainUiVerified: false,
    mainBridgeEndpointVerified: false,
    mbp1TransportPairingVerified: false,
    noCallerTicketlessVerified: false,
    bootstrapTicketProofVerified: false,
    cleanupVerified: false,
    mbp1Verified: false,
    profilePathEqualityVerified: false,
  }
  let stage = 'process-preflight'
  progress(stage)
  let child
  let exited = false
  let browser
  let startTicks
  let originalClosed = false
  try {
    const protocolBrowser = process.env.MOTRIX_STORE_PROTOCOL_BROWSER || 'edge'
    const browserOrder = productionBrowserOrder(protocolBrowser)
    const preflight = await queryProcess()
    if (preflight.processCount !== 0 || preflight.packageProcessCount !== 0)
      fail('existing-motrix-process')
    const port = await unusedPort()
    const aliasRoot = path.win32.join(
      installed.localApplicationData,
      'Microsoft/WindowsApps'
    )
    stage = 'alias-launch'
    progress(stage)
    child = spawn(
      path.win32.join(aliasRoot, MAIN.alias),
      [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
      ],
      {
        shell: false,
        windowsHide: false,
        stdio: 'ignore',
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !Object.hasOwn(clearedEnvironment, key.toUpperCase())
          )
        ),
      }
    )
    const closed = new Promise((resolve) => {
      child.once('error', () => {
        exited = true
        resolve()
      })
      child.once('close', () => {
        exited = true
        resolve()
      })
    })
    report.mainApplicationLaunched = Number.isInteger(child.pid)
    stage = 'process-identity'
    progress(stage)
    for (let attempt = 0; attempt < 8; attempt++) {
      if (exited || !child.pid) fail('main-process-exited')
      const state = await queryProcess(child.pid, port)
      startTicks = validateMainProcess(state, {
        pid: child.pid,
        installed: installed.package,
        startTicks,
        requireListener: false,
      })
      if (state.listeners.length > 0) {
        report.processIdentityVerified = true
        break
      }
      await delay(250)
    }
    if (!report.processIdentityVerified) fail('cdp-listener-timeout')
    stage = 'renderer-connect'
    progress(stage)
    const { chromium } = await import('playwright')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 10000,
    })
    stage = 'first-run-disclaimer'
    progress(stage)
    const disclaimer = await waitForPage(
      browser,
      installed.package.installLocation,
      'onboarding'
    )
    await disclaimer
      .getByTestId('disclaimer-panel')
      .waitFor({ state: 'visible', timeout: 10000 })
    // Only the fresh disposable CI package follows its normal first-run UI.
    // Do not seed settings, query general IPC, or accept a user's existing profile.
    await disclaimer.getByTestId('disclaimer-agree').click({ timeout: 5000 })
    report.disclaimerUiVerified = true
    stage = 'main-renderer'
    progress(stage)
    const main = await waitForPage(
      browser,
      installed.package.installLocation,
      'main'
    )
    await main.waitForLoadState('domcontentloaded', { timeout: 10000 })
    report.mainUiVerified = true
    stage = 'actual-host-endpoint'
    progress(stage)
    const body = Buffer.from('{"allowLaunch":false}')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await runBoundedProbeProcess({
        executable: path.win32.join(aliasRoot, HOST.alias),
        input: Buffer.concat([header, body]),
        profileEnvironment: clearedEnvironment,
        timeoutMs: 5000,
      })
      const reply = validateMainHostReply(result)
      if (reply) {
        validateMainProcess(await queryProcess(child.pid, reply.port), {
          pid: child.pid,
          installed: installed.package,
          startTicks,
        })
        report.mainBridgeEndpointVerified = true
        report.hostStdoutBytes = reply.stdoutBytes
        stage = 'actual-host-bootstrap'
        progress(stage)
        const bootstrap = pairing.bootstrap()
        const bootstrapBody = Buffer.from(JSON.stringify(bootstrap.request))
        const bootstrapHeader = Buffer.alloc(4)
        bootstrapHeader.writeUInt32LE(bootstrapBody.length)
        const bootstrapInput = Buffer.concat([bootstrapHeader, bootstrapBody])
        const requestBootstrap = (args) =>
          runBoundedProbeProcess({
            executable: path.win32.join(aliasRoot, HOST.alias),
            args,
            input: bootstrapInput,
            profileEnvironment: clearedEnvironment,
            timeoutMs: 5000,
          })
        // A public binding key alone cannot attribute a caller. Keep the
        // negative control ticketless, then use fixed synthetic browser argv.
        const anonymous = await requestBootstrap([])
        const anonymousReply = validateMainHostReply(anonymous)
        if (!anonymousReply || anonymousReply.port !== reply.port)
          fail('unexpected-bootstrap-endpoint')
        report.noCallerTicketlessVerified = true
        report.anonymousBootstrapStdoutBytes = anonymousReply.stdoutBytes
        const attested = await requestBootstrap(bootstrap.callerArguments)
        const publicReply = validateMainHostReply(attested, {
          ticketRequired: true,
        })
        if (!publicReply || publicReply.port !== reply.port)
          fail('unexpected-bootstrap-endpoint')
        validateMainProcess(await queryProcess(child.pid, publicReply.port), {
          pid: child.pid,
          installed: installed.package,
          startTicks,
        })
        report.bootstrapStdoutBytes = publicReply.stdoutBytes
        // Only the in-memory controller receives the nonce and ticket. Neither
        // the endpoint's localToken nor a test-minted ticket is used here.
        const privateReply = decodeMainHostReply(attested, {
          ticketRequired: true,
        })
        stage = 'installed-mbp1-pairing'
        progress(stage)
        await pairing.pair(
          privateReply.port,
          privateReply.nonce,
          () => readPairingCode(main),
          privateReply.nmTicket
        )
        report.mbp1TransportPairingVerified = true
        report.bootstrapTicketProofVerified = true
        if (process.env.MOTRIX_STORE_FIREFOX_EXTENSION_DIRECTORY) {
          stage = 'production-extension-firefox'
          progress(stage)
          report.firefoxExtensionRuntime = await runFirefoxStoreExtension({
            extensionDirectory:
              process.env.MOTRIX_STORE_FIREFOX_EXTENSION_DIRECTORY,
            sourceCommit: process.env.MOTRIX_STORE_EXTENSION_COMMIT,
            profileDirectory: path.join(
              process.env.RUNNER_TEMP,
              'motrix-store-production-firefox-extension-profile'
            ),
            appPort: reply.port,
            readPairingCode: () => readPairingCode(main),
          })
          if (
            !report.firefoxExtensionRuntime.ok ||
            !report.firefoxExtensionRuntime.cleanupVerified
          )
            fail('extension-runtime-failed')
          validateMainProcess(await queryProcess(child.pid, reply.port), {
            pid: child.pid,
            installed: installed.package,
            startTicks,
          })
        }
        if (process.env.MOTRIX_STORE_EXTENSION_DIRECTORY) {
          report.extensionRuntimes = {}
          report.protocolBrowser = protocolBrowser
          for (const browserName of browserOrder) {
            stage = `production-extension-${browserName}`
            progress(stage)
            const extension = await runStoreExtensionRuntime({
              browserName,
              extensionDirectory: process.env.MOTRIX_STORE_EXTENSION_DIRECTORY,
              sourceCommit: process.env.MOTRIX_STORE_EXTENSION_COMMIT,
              profileDirectory: path.join(
                process.env.RUNNER_TEMP,
                `motrix-store-production-${browserName}-extension-profile`
              ),
              appPort: reply.port,
              readPairingCode: () => readPairingCode(main),
              ...(browserName === protocolBrowser
                ? {
                    coldLaunch: createExtensionColdLaunchController(
                      installed,
                      async () => {
                        validateMainProcess(
                          await queryProcess(child.pid, reply.port),
                          {
                            pid: child.pid,
                            installed: installed.package,
                            startTicks,
                          }
                        )
                        const cdp = await browser.newBrowserCDPSession()
                        await Promise.race([
                          cdp.send('Browser.close').catch(() => {}),
                          delay(3000),
                        ])
                        await Promise.race([closed, delay(5000)])
                        if (!exited) fail('main-process-remains')
                        originalClosed = true
                      }
                    ),
                  }
                : {}),
            })
            report.extensionRuntimes[browserName] = extension
            if (!extension.ok || !extension.cleanupVerified)
              fail('extension-runtime-failed')
            if (!originalClosed)
              validateMainProcess(await queryProcess(child.pid, reply.port), {
                pid: child.pid,
                installed: installed.package,
                startTicks,
              })
          }
        }
        break
      }
      await delay(500)
    }
    if (!report.mainBridgeEndpointVerified) fail('actual-endpoint-unavailable')
    report.ok = true
    // Browser.close is attempted only after both OS and renderer ownership checks.
    stage = 'normal-close'
    progress(stage)
    if (!originalClosed) {
      const cdp = await browser.newBrowserCDPSession()
      await Promise.race([
        cdp.send('Browser.close').catch(() => {}),
        delay(3000),
      ])
      await Promise.race([closed, delay(5000)])
    }
  } catch (error) {
    report.failureCode = [
      'existing-motrix-process',
      'main-process-exited',
      'process-query-failed',
      'main-process-identity-mismatch',
      'cdp-listener-timeout',
      'ambiguous-main-renderer',
      'renderer-timeout',
      'invalid-host-frame',
      'invalid-host-json',
      'unexpected-host-reply',
      'actual-endpoint-unavailable',
      'unexpected-bootstrap-endpoint',
      'mbp1-pair-failed',
      'extension-runtime-failed',
    ].includes(error?.message)
      ? error.message
      : 'operation-failed'
    report.failureStage = stage
    report.ok = false
  } finally {
    // No raw Electron output, renderer text, profile files or pairing material
    // is saved. A force-stop is restricted to our still-live child process tree.
    try {
      if (child?.pid && !exited) {
        await runBoundedProbeProcess({
          executable: path.win32.join(
            process.env.SystemRoot,
            'System32/taskkill.exe'
          ),
          args: ['/PID', String(child.pid), '/T', '/F'],
        })
        await delay(500)
      }
      if (browser)
        await Promise.race([browser.close().catch(() => {}), delay(2000)])
      const remaining = await queryProcess()
      if (remaining.processCount !== 0 || remaining.packageProcessCount !== 0)
        fail('main-process-remains')
      report.cleanupVerified = true
    } catch {
      report.ok = false
    }
  }
  return report
}

export function validateColdMainProcess(value, installed, startedAfter) {
  validateMainProcess(value, {
    pid: value?.pid,
    installed,
    requireListener: false,
  })
  if (
    typeof startedAfter !== 'string' ||
    !/^\d{15,20}$/.test(startedAfter) ||
    BigInt(value.startTicks) < BigInt(startedAfter)
  )
    fail('cold-main-process-predates-launch')
}

/** Browser owns launch intent; this controller can only observe and clean up. */
export function createExtensionColdLaunchController(
  installed,
  closeMain,
  dependencies = {}
) {
  const query = dependencies.queryProcess ?? queryProcess
  const observe = dependencies.nativeRequest ?? nativeRequest
  const run = dependencies.runBoundedProbeProcess ?? runBoundedProbeProcess
  const pause = dependencies.delay ?? delay
  const report = {
    noLaunchBeforeVerified: false,
    noLaunchAfterCancelVerified: false,
    processIdentityVerified: false,
    mainBridgeEndpointVerified: false,
    noLaunchAfterVerified: false,
    cleanupVerified: false,
  }
  let startedAfter
  let rootState
  async function absent() {
    const value = await query()
    if (
      value.processCount !== 0 ||
      value.packageProcessCount !== 0 ||
      !Array.isArray(value.mainRoots) ||
      value.mainRoots.length !== 0
    )
      fail('main-process-remains')
    return value
  }
  async function noEndpoint() {
    if ((await observe(installed, false)).reply !== null)
      fail('unexpected-running-endpoint')
    await absent()
  }
  return {
    report,
    async stop() {
      await closeMain()
      startedAfter = (await absent()).queriedAtTicks
      if (typeof startedAfter !== 'string' || !/^\d{15,20}$/.test(startedAfter))
        fail('invalid-launch-time')
      await noEndpoint()
      await pause(1000)
      await noEndpoint()
      report.noLaunchBeforeVerified = true
    },
    async verifyCancelled() {
      if (!report.noLaunchBeforeVerified || rootState)
        fail('cold-launch-not-prepared')
      await noEndpoint()
      await pause(1000)
      await noEndpoint()
      report.noLaunchAfterCancelVerified = true
    },
    async observe() {
      if (!report.noLaunchBeforeVerified) fail('cold-launch-not-prepared')
      const deadline = performance.now() + 20000
      while (performance.now() < deadline) {
        // allowLaunch:false is mandatory: observing cannot rescue a failed UI action.
        const value = await observe(installed, false)
        if (value.reply !== null) {
          const current = await query(0, value.reply.port)
          validateColdMainProcess(current, installed.package, startedAfter)
          validateMainProcess(current, {
            pid: current.pid,
            installed: installed.package,
          })
          rootState = current
          report.processIdentityVerified = true
          report.mainBridgeEndpointVerified = true
          return
        }
        await pause(250)
      }
      fail('cold-endpoint-unavailable')
    },
    async cleanup() {
      if (startedAfter) {
        const value = await query()
        if (value.processCount !== 0 || value.packageProcessCount !== 0) {
          if (!Array.isArray(value.mainRoots) || value.mainRoots.length !== 1)
            fail('ambiguous-cold-main')
          const current = await query(value.mainRoots[0])
          validateColdMainProcess(current, installed.package, startedAfter)
          if (
            rootState &&
            (current.pid !== rootState.pid ||
              current.startTicks !== rootState.startTicks)
          )
            fail('cold-main-process-changed')
          await run({
            executable: path.win32.join(
              process.env.SystemRoot ?? 'C:\\Windows',
              'System32/taskkill.exe'
            ),
            args: ['/PID', String(current.pid), '/T', '/F'],
          })
          await pause(500)
        }
        await noEndpoint()
        report.noLaunchAfterVerified = true
      }
      report.cleanupVerified = true
    },
  }
}

async function nativeRequest(installed, allowLaunch) {
  const body = Buffer.from(JSON.stringify({ allowLaunch }))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  const result = await runBoundedProbeProcess({
    executable: path.win32.join(
      installed.localApplicationData,
      'Microsoft/WindowsApps',
      HOST.alias
    ),
    input: Buffer.concat([header, body]),
    profileEnvironment: clearedEnvironment,
    // The product helper has a five-second limit, then endpoint polling has
    // its existing fifteen-second limit. Leave transport/cleanup headroom.
    timeoutMs: allowLaunch ? 25000 : 5000,
  })
  return {
    reply: validateMainHostReply(result),
    stdoutBytes: result.stdout.length,
  }
}

async function requestPackageUriLaunch(installed) {
  // Exercise the installed OS association, not the diagnostic GUI alias or
  // native host's launch helper. The fixed URI contains no pairing material.
  const result = await runBoundedProbeProcess({
    executable: path.win32.join(
      process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'motrix-store://open'",
    ],
    timeoutMs: 10000,
  })
  if (result.exitCode !== 0 || result.stdout.length || result.stderr.length)
    fail('package-uri-launch-failed')
  const deadline = performance.now() + 20000
  while (performance.now() < deadline) {
    // Discovery can only observe. It must never rescue a failed URI launch.
    const observed = await nativeRequest(installed, false)
    if (observed.reply !== null) return observed
    await delay(250)
  }
  fail('cold-endpoint-unavailable')
}

async function runColdLaunchCase(
  installed,
  pairing,
  progress,
  launchMethod = 'native-host'
) {
  const report = {
    launchMethod,
    ok: false,
    noLaunchBeforeVerified: false,
    coldLaunchVerified: false,
    processIdentityVerified: false,
    mainBridgeEndpointVerified: false,
    mbp1TransportReconnectVerified: false,
    noLaunchAfterVerified: false,
    cleanupVerified: false,
    mbp1Verified: false,
    browserActivationVerified: false,
    productionDiscoveryVerified: false,
  }
  let stage = 'cold-preflight'
  progress(stage)
  let startedAfter
  let attempted = false
  let rootState
  async function requireAbsent() {
    const state = await queryProcess()
    if (
      state.processCount !== 0 ||
      state.packageProcessCount !== 0 ||
      !Array.isArray(state.mainRoots) ||
      state.mainRoots.length !== 0
    )
      fail('main-process-remains')
    return state
  }
  async function stopCreatedMain() {
    const state = await queryProcess()
    if (state.processCount === 0 && state.packageProcessCount === 0) return
    if (!Array.isArray(state.mainRoots) || state.mainRoots.length !== 1)
      fail('ambiguous-cold-main')
    const current = await queryProcess(state.mainRoots[0])
    validateColdMainProcess(current, installed.package, startedAfter)
    if (
      rootState &&
      (current.pid !== rootState.pid ||
        current.startTicks !== rootState.startTicks)
    )
      fail('cold-main-process-changed')
    await runBoundedProbeProcess({
      executable: path.win32.join(
        process.env.SystemRoot,
        'System32/taskkill.exe'
      ),
      args: ['/PID', String(current.pid), '/T', '/F'],
    })
    await delay(500)
    await requireAbsent()
  }
  try {
    startedAfter = (await requireAbsent()).queriedAtTicks
    stage = 'no-launch-before'
    progress(stage)
    const before = await nativeRequest(installed, false)
    if (before.reply !== null) fail('unexpected-running-endpoint')
    await requireAbsent()
    report.noLaunchBeforeVerified = true
    report.noLaunchBeforeStdoutBytes = before.stdoutBytes
    stage = `${launchMethod}-cold-launch`
    progress(stage)
    attempted = true
    const launched =
      launchMethod === 'package-uri'
        ? await requestPackageUriLaunch(installed)
        : await nativeRequest(installed, true)
    if (launched.reply === null) fail('cold-endpoint-unavailable')
    stage = 'cold-process-identity'
    progress(stage)
    rootState = await queryProcess(0, launched.reply.port)
    validateColdMainProcess(rootState, installed.package, startedAfter)
    validateMainProcess(rootState, {
      pid: rootState.pid,
      installed: installed.package,
    })
    report.processIdentityVerified = true
    report.mainBridgeEndpointVerified = true
    report.hostStdoutBytes = launched.stdoutBytes
    stage = 'installed-mbp1-reconnect'
    progress(stage)
    await pairing.reconnect(launched.reply.port)
    report.mbp1TransportReconnectVerified = true
    stage = 'cold-process-close'
    progress(stage)
    await stopCreatedMain()
    stage = 'no-launch-after'
    progress(stage)
    const after = await nativeRequest(installed, false)
    if (after.reply !== null) fail('unexpected-running-endpoint')
    await requireAbsent()
    report.noLaunchAfterVerified = true
    report.noLaunchAfterStdoutBytes = after.stdoutBytes
    report.ok = true
    report.coldLaunchVerified = true
  } catch (error) {
    report.failureStage = stage
    report.failureCode = [
      'main-process-remains',
      'ambiguous-cold-main',
      'cold-main-process-changed',
      'cold-main-process-predates-launch',
      'main-process-identity-mismatch',
      'cold-endpoint-unavailable',
      'package-uri-launch-failed',
      'unexpected-running-endpoint',
      'unexpected-host-reply',
      'invalid-host-frame',
      'invalid-host-json',
      'process-query-failed',
      'process-timeout',
      'mbp1-reconnect-failed',
    ].includes(error?.message)
      ? error.message
      : 'operation-failed'
  } finally {
    try {
      if (attempted) await stopCreatedMain()
      await requireAbsent()
      report.cleanupVerified = true
    } catch {
      report.ok = false
    }
    report.coldLaunchVerified = report.ok && report.cleanupVerified
  }
  return report
}

async function main(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--prepared', '--expected-package-version', '--report'].includes(
        args[i]
      ) ||
      options[args[i]] ||
      !args[i + 1]
    )
      fail('invalid-arguments')
    options[args[i]] = args[i + 1]
  }
  const prepared = options['--prepared']
  const destination = options['--report']
  if (
    Object.keys(options).length !== 3 ||
    !path.isAbsolute(prepared) ||
    !path.isAbsolute(destination) ||
    process.platform !== 'win32' ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    destination.toLowerCase() !==
      path.win32
        .join(
          process.env.RUNNER_TEMP,
          'motrix-store-alias-runtime/main-runtime-report.json'
        )
        .toLowerCase()
  )
    fail('invalid-environment')
  const output = await open(destination, 'wx', 0o600)
  const report = {
    schemaVersion: 1,
    scope: 'windows-installed-main-bridge-startup',
    ok: false,
    mainBridgeEndpointVerified: false,
    coldLaunchVerified: false,
    packageUriLaunchVerified: false,
    installedMbp1TransportVerified: false,
    installedBootstrapTicketProofVerified: false,
    mbp1ClientCleanupVerified: false,
    syntheticMbp1Client: true,
    mbp1Verified: false,
    windows11AcceptanceVerified: false,
    storeReady: false,
  }
  let stage = 'prepared-inputs'
  let pairing
  const finishFailureRecorder = installRuntimeFailureRecorder(
    output.fd,
    () => stage
  )
  try {
    const initialLayout = await verifyWindowsStoreLayout({
      preparedDirectory: prepared,
      phase: 'indexed',
    })
    if (!initialLayout.ok) fail('invalid-layout')
    const metadata = JSON.parse(
      (
        await readInstalledFile(
          path.join(prepared, 'release-metadata.json'),
          65536
        )
      ).toString('utf8')
    )
    if (metadata.source.commit !== process.env.GITHUB_SHA)
      fail('source-mismatch')
    const before = validateInstalledProbeState({
      state: await queryInstalledState(),
      metadata,
      expectedPackageVersion: options['--expected-package-version'],
    })
    report.sourceCommit = metadata.source.commit
    report.packageVersion = metadata.packageVersion
    report.context = before.context
    const expected = new Map()
    for (const [name, maximum] of [
      [MAIN.executable, 512 * 1024 * 1024],
      [HOST.executable, 32 * 1024 * 1024],
      ['app/resources/bin/motrix-windows-platform.exe', 32 * 1024 * 1024],
      ['app/resources/app.asar', 512 * 1024 * 1024],
    ])
      expected.set(name, {
        maximum,
        digest: hash(
          await readInstalledFile(path.join(prepared, 'layout', name), maximum)
        ),
      })
    report.appArchiveSha256 = expected.get('app/resources/app.asar').digest
    report.mainExecutableSha256 = expected.get(MAIN.executable).digest
    report.nativeHostSha256 = expected.get(HOST.executable).digest
    report.windowsPlatformSha256 = expected.get(
      'app/resources/bin/motrix-windows-platform.exe'
    ).digest
    async function checkContent() {
      const manifest = await readInstalledFile(
        path.win32.join(before.package.installLocation, 'AppxManifest.xml'),
        65536
      )
      if (!manifest.equals(Buffer.from(renderWindowsStoreManifest(metadata))))
        fail('manifest-mismatch')
      for (const [name, { maximum, digest }] of expected)
        if (
          hash(
            await readInstalledFile(
              path.win32.join(before.package.installLocation, name),
              maximum
            )
          ) !== digest
        )
          fail('installed-file-mismatch')
    }
    stage = 'installed-content-before'
    await checkContent()
    stage = 'load-mbp1-test-client'
    const { tsImport } = await import('tsx/esm/api')
    const { createInstalledMbp1Client } = await tsImport(
      '../src/core/bridge/__tests__/windows-store-mbp1-client.ts',
      import.meta.url
    )
    pairing = createInstalledMbp1Client({
      onProgress: (value) => {
        stage = `mbp1:${value}`
      },
    })
    stage = 'main-runtime'
    report.runtime = await runMainCase(before, pairing, (value) => {
      stage = `main-runtime:${value}`
    })
    if (!report.runtime.ok || !report.runtime.cleanupVerified)
      fail('main-runtime-failed')
    stage = 'cold-launch'
    report.coldLaunch = await runColdLaunchCase(before, pairing, (value) => {
      stage = `cold-launch:${value}`
    })
    if (!report.coldLaunch.ok || !report.coldLaunch.cleanupVerified)
      fail('cold-launch-failed')
    stage = 'package-uri-launch'
    report.packageUriLaunch = await runColdLaunchCase(
      before,
      pairing,
      (value) => {
        stage = `package-uri-launch:${value}`
      },
      'package-uri'
    )
    stage = 'installed-content-after'
    await checkContent()
    const after = validateInstalledProbeState({
      state: await queryInstalledState(),
      metadata,
      expectedPackageVersion: options['--expected-package-version'],
    })
    const finalLayout = await verifyWindowsStoreLayout({
      preparedDirectory: prepared,
      phase: 'indexed',
    })
    if (
      !isDeepStrictEqual(before, after) ||
      !isDeepStrictEqual(initialLayout, finalLayout)
    )
      fail('inputs-changed')
    report.ok =
      report.runtime.ok &&
      report.runtime.cleanupVerified &&
      report.coldLaunch.ok &&
      report.coldLaunch.cleanupVerified &&
      report.packageUriLaunch.ok &&
      report.packageUriLaunch.cleanupVerified
    report.packageUriLaunchVerified =
      report.ok && report.packageUriLaunch.coldLaunchVerified
    report.coldLaunchVerified =
      report.ok && report.coldLaunch.coldLaunchVerified
    report.mainBridgeEndpointVerified =
      report.ok && report.runtime.mainBridgeEndpointVerified
  } catch {
    report.failureStage = stage
  } finally {
    try {
      await pairing?.dispose()
      report.mbp1ClientCleanupVerified = true
    } catch {
      report.ok = false
    }
    report.installedMbp1TransportVerified =
      report.ok &&
      report.mbp1ClientCleanupVerified &&
      report.runtime.mbp1TransportPairingVerified &&
      report.coldLaunch.mbp1TransportReconnectVerified &&
      report.packageUriLaunch.mbp1TransportReconnectVerified
    report.installedBootstrapTicketProofVerified =
      report.installedMbp1TransportVerified &&
      report.runtime.noCallerTicketlessVerified &&
      report.runtime.bootstrapTicketProofVerified
    report.coldLaunchVerified &&= report.ok
    report.packageUriLaunchVerified &&= report.ok
    report.mainBridgeEndpointVerified &&= report.ok
    try {
      finishFailureRecorder()
      await output.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    } finally {
      await output.close()
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ok: report.ok, scope: report.scope })}\n`
  )
  if (!report.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Installed main runtime check failed\n')
    process.exitCode = 1
  })
