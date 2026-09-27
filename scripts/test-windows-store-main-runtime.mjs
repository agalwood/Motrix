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
          installedMbp1TransportVerified: false,
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
    fatal = {
      name: names.includes(error?.name) ? error.name : 'other',
      code: codes.includes(error?.code) ? error.code : 'other',
      origin: origin === 'unhandledRejection' ? origin : 'uncaughtException',
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

function decodeMainHostReply(result) {
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
      'action,nonce,port,protocolVersion' ||
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

export function validateMainHostReply(result) {
  const value = decodeMainHostReply(result)
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
  try {
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
        stage = 'installed-mbp1-pairing'
        progress(stage)
        await pairing.pair(reply.port, decodeMainHostReply(result).nonce, () =>
          readPairingCode(main)
        )
        report.mbp1TransportPairingVerified = true
        break
      }
      await delay(500)
    }
    if (!report.mainBridgeEndpointVerified) fail('actual-endpoint-unavailable')
    report.ok = true
    // Browser.close is attempted only after both OS and renderer ownership checks.
    stage = 'normal-close'
    progress(stage)
    const cdp = await browser.newBrowserCDPSession()
    await Promise.race([cdp.send('Browser.close').catch(() => {}), delay(3000)])
    await Promise.race([closed, delay(5000)])
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
      'mbp1-pair-failed',
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

async function runColdLaunchCase(installed, pairing, progress) {
  const report = {
    ok: false,
    noLaunchBeforeVerified: false,
    coldLaunchVerified: false,
    processIdentityVerified: false,
    mainBridgeEndpointVerified: false,
    mbp1TransportReconnectVerified: false,
    noLaunchAfterVerified: false,
    cleanupVerified: false,
    mbp1Verified: false,
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
    stage = 'native-host-cold-launch'
    progress(stage)
    attempted = true
    const launched = await nativeRequest(installed, true)
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
    installedMbp1TransportVerified: false,
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
    pairing = createInstalledMbp1Client()
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
      report.coldLaunch.cleanupVerified
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
      report.coldLaunch.mbp1TransportReconnectVerified
    report.coldLaunchVerified &&= report.ok
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
