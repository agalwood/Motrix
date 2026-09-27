import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  identityDigests,
  queryInstalledState,
  readInstalledFile,
  runBoundedProbeProcess,
  validateInstalledProbeReply,
  validateInstalledProbeState,
} from './test-windows-store-native-messaging-alias.mjs'
import { verifyWindowsStoreLayout } from './verify-windows-store-layout.mjs'
import {
  loadPreparedWindowsStoreDiagnostic,
  requireConsoleExecutable,
} from './windows-store-diagnostics.mjs'
import { renderWindowsStoreManifest } from './windows-store-manifest.mjs'
import {
  WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC as DIAGNOSTIC,
  validateWindowsStoreMetadata,
} from './windows-store-metadata.mjs'

const REPO = fileURLToPath(new URL('../', import.meta.url))
const HOST = 'app.motrix.bridge.store.p0'
const RELAY_SOURCE =
  'tests/fixtures/windows-store-native-messaging/firefox-alias-relay.cs'
const RELAY_EXECUTABLE = 'motrix-store-p0-firefox-relay.exe'
const FIREFOX_ID = 'motrix-store-p0@motrix.invalid'
const FIREFOX_UUID = '9efccb48-20d1-4b4d-89cb-1e617591976a'
const BRANDS = Object.freeze({
  chrome: { product: 'Google Chrome', signer: 'Google LLC' },
  edge: { product: 'Microsoft Edge', signer: 'Microsoft Corporation' },
  firefox: { product: 'Firefox', signer: 'Mozilla Corporation' },
})
const CASES = ['unregistered-before', 'registered', 'unregistered-after']
const OBSERVATION_STATUSES = new Set([
  'reply',
  'disconnected',
  'timeout',
  'multiple-messages',
  'invalid-reply',
  'connect-failed',
])
const OBSERVATION_ERROR_KINDS = new Set([
  'none',
  'native-host-not-found',
  'native-host-not-executable',
  'other',
])
const CODES = new Set([
  'invalid-arguments',
  'windows-required',
  'unsafe-path',
  'output-exists',
  'invalid-inputs',
  'layout-verification-failed',
  'prepared-content-changed',
  'installed-state-failed',
  'installed-content-mismatch',
  'installed-state-changed',
  'browser-inventory-failed',
  'browser-brand-mismatch',
  'browser-start-failed',
  'browser-loader-unsupported',
  'browser-protocol-failed',
  'browser-timeout',
  'browser-output-limit',
  'browser-probe-click-failed',
  'browser-probe-click-timeout',
  'browser-probe-wait-failed',
  'browser-probe-wait-timeout',
  'browser-probe-read-failed',
  'browser-probe-read-timeout',
  'browser-cleanup-failed',
  'invalid-extension-id',
  'invalid-browser-result',
  'unexpected-native-connection',
  'invalid-browser-reply',
  'registration-failed',
  'registration-report-invalid',
  'registration-cleanup-failed',
  'experiment-timeout',
  'fixture-invalid',
  'relay-build-invalid',
  'relay-content-changed',
  'report-write-failed',
  'internal-error',
])
class BrowserCheckError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'internal-error'
    super(safe)
    this.code = safe
  }
}
const fail = (code) => {
  throw new BrowserCheckError(code)
}
const codeOf = (error) =>
  error instanceof BrowserCheckError ? error.code : 'internal-error'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const versionPattern = /^\d+(?:\.\d+){1,3}$/
const hashPattern = /^[0-9a-f]{64}$/
const windowsPath = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z]:\\/.test(value) &&
  !/[\p{Cc}<>"|?*]/u.test(value) &&
  !value.slice(2).includes(':') &&
  !value.split('\\').some((part) => part === '.' || part === '..')

async function timed(operation, milliseconds, code = 'browser-timeout') {
  let timer
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserCheckError(code)),
          milliseconds
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function safeDirectory(directory) {
  const root = path.parse(directory).root
  let current = root
  for (const part of directory
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe-path')
  }
}

/** Only the new experiment directory may be created or subsequently removed. */
export async function createBrowserOutputDirectory({
  preparedDirectory,
  outputDirectory,
}) {
  if (!path.isAbsolute(preparedDirectory) || !path.isAbsolute(outputDirectory))
    fail('invalid-arguments')
  const relative = path.relative(
    path.resolve(preparedDirectory),
    path.resolve(outputDirectory)
  )
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
    fail('invalid-arguments')
  await safeDirectory(path.dirname(outputDirectory))
  try {
    await mkdir(outputDirectory)
  } catch (error) {
    if (error.code === 'EEXIST') fail('output-exists')
    fail('unsafe-path')
  }
}

/** Whitelisted failure evidence only; never serialize arbitrary browser data. */
export function safeBrowserProbeObservation(result) {
  const read = (key) => {
    if (!result || typeof result !== 'object') return undefined
    try {
      return Object.getOwnPropertyDescriptor(result, key)?.value
    } catch {
      return undefined
    }
  }
  const status = read('status')
  const messageCount = read('messageCount')
  const errorPresent = read('errorPresent')
  const errorKind = read('errorKind')
  return {
    status: OBSERVATION_STATUSES.has(status) ? status : null,
    messageCount:
      Number.isInteger(messageCount) && messageCount >= 0 && messageCount <= 2
        ? messageCount
        : null,
    errorPresent: typeof errorPresent === 'boolean' ? errorPresent : null,
    errorKind: OBSERVATION_ERROR_KINDS.has(errorKind) ? errorKind : null,
  }
}

/** Parsed browser observations do not expose native exit codes or wire frames. */
export function validateBrowserProbeResult({
  result,
  browser,
  registered,
  installedState,
  expectedPackageVersion,
}) {
  if (
    !Object.hasOwn(BRANDS, browser) ||
    typeof registered !== 'boolean' ||
    !exactKeys(result, [
      'schemaVersion',
      'status',
      'messageCount',
      'errorPresent',
      'errorKind',
      'reply',
    ]) ||
    result.schemaVersion !== 1 ||
    typeof result.errorPresent !== 'boolean' ||
    !OBSERVATION_ERROR_KINDS.has(result.errorKind) ||
    (result.errorKind === 'none') !== !result.errorPresent ||
    !Number.isInteger(result.messageCount) ||
    result.messageCount < 0 ||
    result.messageCount > 2
  )
    fail('invalid-browser-result')
  if (!registered) {
    if (
      result.status !== 'disconnected' ||
      result.messageCount !== 0 ||
      result.reply !== null ||
      result.errorPresent !== true
    )
      fail('unexpected-native-connection')
  } else {
    if (result.status !== 'reply' || result.messageCount !== 1)
      fail('invalid-browser-result')
    try {
      validateInstalledProbeReply({
        reply: result.reply,
        installedState,
        expectedPackageVersion,
        caller: browser === 'firefox' ? 'firefox' : 'chromium',
      })
    } catch {
      fail('invalid-browser-reply')
    }
  }
  return {
    status: result.status,
    messageCount: result.messageCount,
    errorPresent: result.errorPresent,
    errorKind: result.errorKind,
  }
}

export function validateBrowserInventory({
  browser,
  inventory,
  runtimeVersion,
}) {
  const brand = BRANDS[browser]
  if (
    !brand ||
    !exactKeys(inventory, [
      'product',
      'fileVersion',
      'executable',
      'executableSha256',
      'signatureStatus',
      'signer',
    ]) ||
    inventory.product !== brand.product ||
    typeof inventory.fileVersion !== 'string' ||
    !versionPattern.test(inventory.fileVersion) ||
    !windowsPath(inventory.executable) ||
    !hashPattern.test(inventory.executableSha256) ||
    inventory.signatureStatus !== 'Valid' ||
    inventory.signer !== brand.signer
  )
    fail('browser-brand-mismatch')
  if (
    runtimeVersion !== undefined &&
    (typeof runtimeVersion !== 'string' ||
      !versionPattern.test(runtimeVersion) ||
      runtimeVersion.split('.')[0] !== inventory.fileVersion.split('.')[0])
  )
    fail('browser-brand-mismatch')
  return {
    product: brand.product,
    fileVersion: inventory.fileVersion,
    executableSha256: inventory.executableSha256,
    ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
  }
}

function powershell() {
  if (process.platform !== 'win32' || !windowsPath(process.env.SystemRoot))
    fail('windows-required')
  return path.win32.join(
    process.env.SystemRoot,
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  )
}

async function encodedQuery(script) {
  const result = await runBoundedProbeProcess({
    executable: powershell(),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    maxStdoutBytes: 32768,
    maxStderrBytes: 1024,
  })
  if (result.exitCode !== 0 || result.stderr.length !== 0)
    fail('browser-inventory-failed')
  try {
    return JSON.parse(utf8(result.stdout))
  } catch {
    fail('browser-inventory-failed')
  }
}

async function browserInventory(browser) {
  // Browser names are a closed enum; no user-supplied PowerShell is interpolated.
  const relative = {
    chrome: 'Google\\Chrome\\Application\\chrome.exe',
    edge: 'Microsoft\\Edge\\Application\\msedge.exe',
    firefox: 'Mozilla Firefox\\firefox.exe',
  }[browser]
  if (!relative) fail('invalid-arguments')
  return encodedQuery(String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $roots = @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) | Select-Object -Unique
  $files = @($roots | ForEach-Object { $candidate = Join-Path $_ '${relative}'; if (Test-Path -LiteralPath $candidate -PathType Leaf) { Get-Item -LiteralPath $candidate } })
  if ($files.Count -ne 1 -or ($files[0].Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
  $file = $files[0]
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $version = [regex]::Match($file.VersionInfo.ProductVersion, '^\d+(?:\.\d+){1,3}').Value
  [ordered]@{ product = $file.VersionInfo.ProductName; fileVersion = $version; executable = $file.FullName; executableSha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); signatureStatus = $signature.Status.ToString(); signer = $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } | ConvertTo-Json -Compress
} catch { exit 1 }
`)
}

/** The report associates checked-in source and actual PE bytes; it is not a signature. */
export function validateFirefoxRelayBuild({
  buildReportBytes,
  executableBytes,
  sourceBytes,
}) {
  try {
    requireConsoleExecutable(executableBytes)
    if (
      !Buffer.isBuffer(buildReportBytes) ||
      buildReportBytes.length > 16384 ||
      !Buffer.isBuffer(sourceBytes) ||
      sourceBytes.length === 0 ||
      sourceBytes.length > 65536
    )
      fail('relay-build-invalid')
    const expected = {
      schemaVersion: 1,
      scope: 'windows-native-messaging-firefox-alias-relay-build',
      ok: true,
      compiled: true,
      compiler: 'Windows .NET Framework64 csc',
      source: { path: RELAY_SOURCE, sha256: hash(sourceBytes) },
      executable: {
        path: RELAY_EXECUTABLE,
        bytes: executableBytes.length,
        sha256: hash(executableBytes),
        peMachine: '0x8664',
        peMachineVerified: true,
        peOptionalHeaderMagic: '0x020b',
        peSubsystem: '0x0003',
        consoleSubsystemVerified: true,
      },
      directStdioVerified: false,
      packagedActivationVerified: false,
      browserNativeMessagingVerified: false,
      mbp1Verified: false,
    }
    if (!isDeepStrictEqual(JSON.parse(utf8(buildReportBytes)), expected))
      fail('relay-build-invalid')
    return {
      sourceSha256: expected.source.sha256,
      executableSha256: expected.executable.sha256,
      bytes: executableBytes.length,
      buildReportSha256: hash(buildReportBytes),
    }
  } catch {
    fail('relay-build-invalid')
  }
}

async function loadFirefoxRelayBuild(directory) {
  if (!windowsPath(directory) || path.win32.normalize(directory) !== directory)
    fail('invalid-arguments')
  try {
    const executablePath = path.win32.join(directory, RELAY_EXECUTABLE)
    const evidence = validateFirefoxRelayBuild({
      buildReportBytes: await readInstalledFile(
        path.win32.join(directory, 'build-report.json'),
        16384
      ),
      executableBytes: await readInstalledFile(executablePath, 1048576),
      sourceBytes: await readInstalledFile(
        path.join(REPO, RELAY_SOURCE),
        65536
      ),
    })
    return { executablePath, ...evidence }
  } catch {
    fail('relay-build-invalid')
  }
}

/** Fixed script plus JSON data: never evaluate a caller-provided command. */
export function buildBrowserRegistrationArguments(input) {
  if (
    !['Inspect', 'Register', 'Remove'].includes(input.action) ||
    !Object.hasOwn(BRANDS, input.browser)
  )
    fail('invalid-arguments')
  const parameters = {
    Action: input.action,
    Browser: input.browser,
    RunDirectory: input.runDirectory,
  }
  if (input.receiptSha256) parameters.ReceiptSha256 = input.receiptSha256
  if (input.relayPath || input.relaySha256) {
    if (
      input.browser !== 'firefox' ||
      !windowsPath(input.relayPath) ||
      !hashPattern.test(input.relaySha256)
    )
      fail('invalid-arguments')
    parameters.RelayPath = input.relayPath
    parameters.RelaySha256 = input.relaySha256
  }
  if (input.action === 'Register')
    Object.assign(parameters, {
      ExtensionId: input.extensionId,
      AliasPath: input.aliasPath,
      ExpectedPackageVersion: input.packageVersion,
      ProbeSha256: input.probeSha256,
      SourceCommit: input.sourceCommit,
      AllowTemporaryRegistration: true,
    })
  const data = Buffer.from(JSON.stringify(parameters), 'utf8').toString(
    'base64'
  )
  const scriptPath = path
    .join(REPO, 'scripts/windows-store-browser-registration.ps1')
    .replaceAll("'", "''")
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json; $parameters = @{}; foreach ($property in $data.PSObject.Properties) { $parameters[$property.Name] = $property.Value }; & '${scriptPath}' @parameters; exit $LASTEXITCODE`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  if (encoded.length > 8192) fail('invalid-arguments')
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encoded,
  ]
}

async function registration(input) {
  const result = await runBoundedProbeProcess({
    executable: powershell(),
    args: buildBrowserRegistrationArguments(input),
    maxStdoutBytes: 32768,
    maxStderrBytes: 1024,
  })
  let parsed
  try {
    parsed = JSON.parse(utf8(result.stdout))
  } catch {
    fail('registration-report-invalid')
  }
  return {
    report: parsed,
    exitCode: result.exitCode,
    stderrBytes: result.stderr.length,
  }
}

function checkRegistration(
  value,
  { action, browser, registered, relaySha256 }
) {
  const report = value?.report
  if (
    value?.exitCode !== 0 ||
    value?.stderrBytes !== 0 ||
    report?.ok !== true ||
    report.schemaVersion !== 1 ||
    report.registryView !== 'Registry32' ||
    report.registryPathRole !== browser ||
    report.action !== action ||
    report.browser !== browser ||
    report.hostName !== HOST ||
    report.registered !== registered ||
    report.hostLaunchMode !==
      (relaySha256 ? 'firefox-alias-relay' : 'execution-alias') ||
    (relaySha256
      ? report.relaySha256 !== relaySha256
      : Object.hasOwn(report, 'relaySha256')) ||
    (action === 'Remove' && report.cleanupVerified !== true)
  )
    fail('registration-failed')
  if (
    action === 'Register' &&
    (!hashPattern.test(report.receiptSha256) ||
      !hashPattern.test(report.manifestSha256))
  )
    fail('registration-report-invalid')
}

async function fixture(browser) {
  const directory = path.join(
    REPO,
    'tests/fixtures/windows-store-native-messaging/browser',
    browser === 'firefox' ? 'firefox' : 'chromium'
  )
  const digest = createHash('sha256')
  for (const name of ['manifest.json', 'probe.html', 'probe.js']) {
    const bytes = await readInstalledFile(path.join(directory, name), 32768)
    digest.update(name).update('\0').update(bytes).update('\0')
  }
  return { directory, sha256: digest.digest('hex') }
}

export function browserTerminationOptions(pid, systemRoot) {
  if (!Number.isInteger(pid) || pid <= 0 || !windowsPath(systemRoot))
    fail('browser-cleanup-failed')
  return {
    executable: path.win32.join(systemRoot, 'System32/taskkill.exe'),
    args: ['/PID', String(pid), '/T', '/F'],
    timeoutMs: 5000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 1024,
  }
}

async function killOwnedProcess(pid) {
  try {
    const result = await runBoundedProbeProcess(
      browserTerminationOptions(pid, process.env.SystemRoot)
    )
    if (result.exitCode !== 0) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
      }
      fail('browser-cleanup-failed')
    }
  } catch {
    fail('browser-cleanup-failed')
  }
}

/** Keep automation failures actionable without retaining URLs, paths or logs. */
export async function runChromiumProbeCase(page) {
  async function operation(name, execute) {
    try {
      return await execute()
    } catch (error) {
      fail(
        `browser-probe-${name}-${error?.name === 'TimeoutError' ? 'timeout' : 'failed'}`
      )
    }
  }
  await operation('click', () =>
    page.locator('#probe').click({ timeout: 5000 })
  )
  await operation('wait', () =>
    page.waitForFunction(
      () => {
        const text = document.getElementById('result')?.textContent
        return typeof text === 'string' && text !== 'null'
      },
      null,
      { timeout: 14000 }
    )
  )
  const text = await operation('read', () =>
    page.locator('#result').textContent({ timeout: 1000 })
  )
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8192)
    fail('invalid-browser-result')
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid-browser-result')
  }
}

async function openChromium({
  browser,
  inventory,
  fixture: source,
  profileDirectory,
}) {
  const { chromium } = await import('playwright')
  let context
  let ownedPid
  let closed = false
  async function close() {
    if (!context || closed) return
    try {
      await timed(context.close(), 10000, 'browser-cleanup-failed')
    } catch {
      if (ownedPid) await killOwnedProcess(ownedPid)
      else fail('browser-cleanup-failed')
    }
    closed = true
  }
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: inventory.executable,
      channel: browser === 'chrome' ? 'chrome' : 'msedge',
      headless: false,
      timeout: 30000,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    })
    const cdp = await timed(context.browser().newBrowserCDPSession(), 5000)
    const processes = await timed(cdp.send('SystemInfo.getProcessInfo'), 10000)
    const roots = processes.processInfo.filter(
      (entry) => entry.type === 'browser'
    )
    if (roots.length !== 1 || !Number.isInteger(roots[0].id))
      fail('browser-start-failed')
    ownedPid = roots[0].id
    const runtime = await timed(cdp.send('Browser.getVersion'), 10000)
    const version = runtime.product.replace(/^[^/]+\//, '')
    validateBrowserInventory({ browser, inventory, runtimeVersion: version })
    let loaded
    try {
      loaded = await timed(
        cdp.send('Extensions.loadUnpacked', { path: source.directory }),
        10000
      )
    } catch {
      fail('browser-loader-unsupported')
    }
    if (!/^[a-p]{32}$/.test(loaded.id)) fail('invalid-extension-id')
    const page = await timed(context.newPage(), 5000)
    await page.goto(`chrome-extension://${loaded.id}/probe.html`, {
      timeout: 10000,
    })
    if (
      (await timed(
        page.evaluate(() => globalThis.chrome.runtime.id),
        5000
      )) !== loaded.id
    )
      fail('invalid-extension-id')
    return {
      extensionId: loaded.id,
      version,
      close,
      async runCase() {
        return runChromiumProbeCase(page)
      },
    }
  } catch (error) {
    await close()
    if (error instanceof BrowserCheckError) throw error
    fail('browser-start-failed')
  }
}

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

// The branded Firefox Remote Agent uses BiDi, not Playwright's patched Firefox.
async function openFirefox({ inventory, fixture: source, profileDirectory }) {
  const { default: WebSocket } = await import('ws')
  const port = await unusedPort()
  await writeFile(
    path.join(profileDirectory, 'user.js'),
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }))});\nuser_pref("browser.startup.homepage", "about:blank");\n`,
    { flag: 'wx' }
  )
  const child = spawn(
    inventory.executable,
    [
      '--headless',
      '--no-remote',
      '--profile',
      profileDirectory,
      '--remote-debugging-port',
      String(port),
      '--remote-allow-system-access',
    ],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let failure
  let socket
  let sequence = 0
  const pending = new Map()
  let outputBytes = 0
  child.on('error', () => {
    failure = 'browser-start-failed'
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 65536) {
        failure = 'browser-output-limit'
        // Keep the owned root alive until close() can terminate its whole tree.
        for (const waiter of pending.values()) waiter.reject()
        pending.clear()
        socket?.terminate()
      }
    })
  function command(method, params, timeout = 10000) {
    if (failure || !socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new BrowserCheckError(failure ?? 'browser-protocol-failed')
      )
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new BrowserCheckError('browser-timeout'))
      }, timeout)
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: () => {
          clearTimeout(timer)
          reject(new BrowserCheckError(failure ?? 'browser-protocol-failed'))
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function close() {
    if (socket?.readyState === WebSocket.OPEN)
      await command('session.end', {}, 2000).catch(() => {})
    socket?.terminate()
    for (const waiter of pending.values()) waiter.reject()
    pending.clear()
    if (
      Number.isInteger(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await killOwnedProcess(child.pid)
      await timed(
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve()
          else child.once('close', resolve)
        }),
        3000,
        'browser-cleanup-failed'
      )
    }
  }
  try {
    const deadline = Date.now() + 20000
    while (!socket && Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null)
        fail(failure ?? 'browser-start-failed')
      try {
        socket = await new Promise((resolve, reject) => {
          const candidate = new WebSocket(`ws://127.0.0.1:${port}/session`, {
            maxPayload: 65536,
            handshakeTimeout: 1000,
          })
          candidate.once('open', () => resolve(candidate))
          candidate.once('error', () => {
            candidate.terminate()
            reject(new BrowserCheckError('browser-protocol-failed'))
          })
        })
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    if (!socket) fail('browser-timeout')
    socket.on('error', () => {
      failure = 'browser-protocol-failed'
    })
    socket.on('close', () => {
      for (const waiter of pending.values()) waiter.reject()
      pending.clear()
    })
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(utf8(data))
        const waiter = pending.get(message.id)
        if (!waiter) return
        pending.delete(message.id)
        if (message.type === 'success') waiter.resolve(message.result)
        else waiter.reject()
      } catch {
        failure = 'browser-protocol-failed'
        socket.terminate()
      }
    })
    const session = await command('session.new', {
      capabilities: { alwaysMatch: { browserName: 'firefox' } },
    })
    const version = session.capabilities.browserVersion
    if (session.capabilities.browserName !== 'firefox')
      fail('browser-brand-mismatch')
    validateBrowserInventory({
      browser: 'firefox',
      inventory,
      runtimeVersion: version,
    })
    let loaded
    try {
      loaded = await command('webExtension.install', {
        extensionData: { type: 'path', path: source.directory },
      })
    } catch {
      fail('browser-loader-unsupported')
    }
    if (loaded.extension !== FIREFOX_ID) fail('invalid-extension-id')
    const { context } = await command('browsingContext.create', { type: 'tab' })
    await command('browsingContext.navigate', {
      context,
      url: `moz-extension://${FIREFOX_UUID}/probe.html`,
      wait: 'complete',
    })
    async function evaluate(expression) {
      const response = await command(
        'script.evaluate',
        {
          expression,
          target: { context },
          awaitPromise: true,
          resultOwnership: 'none',
        },
        15000
      )
      if (response.type !== 'success' || response.result.type !== 'string')
        fail('browser-protocol-failed')
      return response.result.value
    }
    if ((await evaluate('browser.runtime.id')) !== FIREFOX_ID)
      fail('invalid-extension-id')
    return {
      extensionId: FIREFOX_ID,
      version,
      close,
      async runCase() {
        const text = await evaluate(
          `new Promise((resolve) => { document.getElementById('probe').click(); const end = Date.now() + 14000; const check = () => { const text = document.getElementById('result').textContent; if (text !== 'null') resolve(text); else if (Date.now() >= end) resolve('null'); else setTimeout(check, 50); }; check(); })`
        )
        if (typeof text !== 'string' || Buffer.byteLength(text) > 8192)
          fail('invalid-browser-result')
        return JSON.parse(text)
      },
    }
  } catch (error) {
    await close()
    if (error instanceof BrowserCheckError) throw error
    fail('browser-start-failed')
  }
}

function emptyReport() {
  return {
    schemaVersion: 1,
    scope: 'windows-native-messaging-branded-browsers',
    ok: false,
    checks: [],
    browsers: [],
    testCount: 0,
    context: null,
    cleanupVerified: false,
    browserNativeMessagingVerified: false,
    diagnosticProbeOnly: true,
    mbp1Verified: false,
    windows11AcceptanceVerified: false,
    motrixMainRuntimeVerified: false,
    browserUpgradeVerified: false,
    signatureVerified: false,
    packageInstallationPerformed: false,
  }
}

/** Injectable boundaries support local tests without browsers, registry writes, or installation. */
export async function runBrowserNativeMessagingChecks(
  {
    metadata: raw,
    diagnostic,
    manifestBytes,
    expectedPackageVersion,
    outputDirectory,
    firefoxRelayBuildDirectory,
  },
  dependencies = {}
) {
  const query = dependencies.queryInstalledState ?? queryInstalledState
  const read = dependencies.readInstalledFile ?? readInstalledFile
  const inventory = dependencies.browserInventory ?? browserInventory
  const fixtureSource = dependencies.fixture ?? fixture
  const register = dependencies.registration ?? registration
  const loadRelay = dependencies.loadFirefoxRelayBuild ?? loadFirefoxRelayBuild
  const launch =
    dependencies.openBrowser ??
    ((input) =>
      input.browser === 'firefox' ? openFirefox(input) : openChromium(input))
  const report = emptyReport()
  const deadline = Date.now() + 270000
  const within = (operation, maximum = 20000) => {
    const remaining = deadline - Date.now()
    if (remaining < maximum) {
      fail('experiment-timeout')
    }
    return timed(operation(), maximum, 'experiment-timeout')
  }
  let metadata
  let before
  let relay
  let step = 'inputs'
  try {
    metadata = validateWindowsStoreMetadata(raw).metadata
    if (
      metadata.profile !== 'test' ||
      metadata.testDiagnostics !== DIAGNOSTIC.mode ||
      metadata.packageVersion !== expectedPackageVersion ||
      diagnostic?.executable?.path !== DIAGNOSTIC.executable ||
      !Number.isSafeInteger(diagnostic.executable.bytes) ||
      diagnostic.executable.bytes < 1 ||
      diagnostic.executable.bytes > 1048576 ||
      !hashPattern.test(diagnostic.executable.sha256) ||
      !Buffer.isBuffer(manifestBytes) ||
      !manifestBytes.equals(Buffer.from(renderWindowsStoreManifest(metadata)))
    )
      fail('invalid-inputs')
    report.sourceCommit = metadata.source.commit
    report.packageVersion = metadata.packageVersion
    report.executableSha256 = diagnostic.executable.sha256
    if (firefoxRelayBuildDirectory !== undefined) {
      relay = await within(() => loadRelay(firefoxRelayBuildDirectory))
      if (
        !windowsPath(relay.executablePath) ||
        path.win32.basename(relay.executablePath) !== RELAY_EXECUTABLE ||
        !hashPattern.test(relay.sourceSha256) ||
        !hashPattern.test(relay.executableSha256) ||
        !hashPattern.test(relay.buildReportSha256) ||
        !Number.isSafeInteger(relay.bytes) ||
        relay.bytes < 256 ||
        relay.bytes > 1048576
      )
        fail('relay-build-invalid')
      const { executablePath: _path, ...safeRelay } = relay
      report.firefoxRelay = safeRelay
    }
    async function snapshot() {
      let value
      try {
        value = validateInstalledProbeState({
          state: await within(() => query()),
          metadata,
          expectedPackageVersion,
        })
      } catch {
        fail('installed-state-failed')
      }
      const root = value.package.installLocation
      const manifest = await within(() =>
        read(path.win32.join(root, 'AppxManifest.xml'), 65536)
      )
      const probe = await within(() =>
        read(path.win32.join(root, DIAGNOSTIC.executable), 1048576)
      )
      if (
        !Buffer.isBuffer(manifest) ||
        !manifest.equals(manifestBytes) ||
        !Buffer.isBuffer(probe) ||
        probe.length !== diagnostic.executable.bytes ||
        hash(probe) !== diagnostic.executable.sha256
      )
        fail('installed-content-mismatch')
      if (
        relay &&
        !isDeepStrictEqual(
          await within(() => loadRelay(firefoxRelayBuildDirectory)),
          relay
        )
      )
        fail('relay-content-changed')
      if (before && !isDeepStrictEqual(value, before))
        fail('installed-state-changed')
      return value
    }
    step = 'installed-before'
    before = await snapshot()
    report.context = before.context
    report.identity = identityDigests(before)
    report.checks.push({ name: step, ok: true })
    for (const browser of Object.keys(BRANDS)) {
      const browserReport = {
        browser,
        hostLaunchMode:
          browser === 'firefox' && relay
            ? 'firefox-alias-relay'
            : 'execution-alias',
        automationMode:
          browser === 'firefox'
            ? 'firefox-headless-bidi'
            : 'chromium-headed-cdp',
        ok: false,
        checks: [],
        cleanup: [],
        cleanupVerified: false,
        brandedBinaryVerified: false,
      }
      report.browsers.push(browserReport)
      const browserDirectory = path.join(outputDirectory, browser)
      const profileDirectory = path.join(browserDirectory, 'profile')
      const runDirectory = path.join(browserDirectory, 'registration')
      let session
      let receiptSha256
      let registrationAttempted = false
      let profileCreated = false
      let browserStep = 'inventory'
      let browserOperation
      let observation
      const registerInput = {
        browser,
        runDirectory,
        aliasPath: path.win32.join(
          before.localApplicationData,
          'Microsoft/WindowsApps',
          DIAGNOSTIC.alias
        ),
        packageVersion: expectedPackageVersion,
        probeSha256: diagnostic.executable.sha256,
        sourceCommit: metadata.source.commit,
        ...(browser === 'firefox' && relay
          ? {
              relayPath: relay.executablePath,
              relaySha256: relay.executableSha256,
            }
          : {}),
      }
      const registrationExpectation = {
        browser,
        relaySha256: registerInput.relaySha256,
      }
      try {
        const details = await within(() => inventory(browser))
        Object.assign(
          browserReport,
          validateBrowserInventory({ browser, inventory: details })
        )
        const source = await within(() => fixtureSource(browser))
        if (!hashPattern.test(source.sha256)) fail('fixture-invalid')
        browserReport.fixtureSha256 = source.sha256
        await mkdir(browserDirectory)
        await mkdir(profileDirectory)
        profileCreated = true
        browserStep = 'load-extension'
        // Both concrete launchers own their bounded startup and close on error.
        // Do not race a launcher: losing its returned session would orphan it.
        if (deadline - Date.now() < 100000) fail('experiment-timeout')
        session = await launch({
          browser,
          inventory: details,
          fixture: source,
          profileDirectory,
        })
        Object.assign(
          browserReport,
          validateBrowserInventory({
            browser,
            inventory: details,
            runtimeVersion: session.version,
          })
        )
        if (
          browser === 'firefox'
            ? session.extensionId !== FIREFOX_ID
            : !/^[a-p]{32}$/.test(session.extensionId)
        )
          fail('invalid-extension-id')
        browserReport.extensionId = session.extensionId
        browserReport.brandedBinaryVerified = true
        for (const name of CASES) {
          browserStep = name
          observation = undefined
          browserOperation = 'verify-installed-before'
          await snapshot()
          if (name === 'registered') {
            browserOperation = 'register-host'
            registrationAttempted = true
            const created = await within(() =>
              register({
                ...registerInput,
                action: 'Register',
                extensionId: session.extensionId,
              })
            )
            if (
              created?.report?.schemaVersion === 1 &&
              created.report.action === 'Register' &&
              created.report.browser === browser &&
              created.report.hostName === HOST
            ) {
              if (hashPattern.test(created.report.receiptSha256))
                receiptSha256 = created.report.receiptSha256
              if (
                created.report.ok === false &&
                created.report.cleanupVerified === true
              ) {
                registrationAttempted = false
                receiptSha256 = undefined
                browserReport.cleanup.push({
                  name: 'registration-rollback',
                  ok: true,
                })
              }
            }
            checkRegistration(created, {
              ...registrationExpectation,
              action: 'Register',
              registered: true,
            })
            browserReport.registration = {
              manifestSha256: created.report.manifestSha256,
              registryView: created.report.registryView,
              registryPathRole: created.report.registryPathRole,
            }
            browserOperation = 'inspect-registration'
            checkRegistration(
              await within(() =>
                register({ ...registerInput, action: 'Inspect', receiptSha256 })
              ),
              {
                ...registrationExpectation,
                action: 'Inspect',
                registered: true,
              }
            )
          } else {
            if (receiptSha256) {
              browserOperation = 'remove-registration'
              checkRegistration(
                await within(() =>
                  register({
                    ...registerInput,
                    action: 'Remove',
                    receiptSha256,
                  })
                ),
                {
                  ...registrationExpectation,
                  action: 'Remove',
                  registered: false,
                }
              )
              receiptSha256 = undefined
              registrationAttempted = false
            }
            browserOperation = 'inspect-registration'
            checkRegistration(
              await within(() =>
                register({ ...registerInput, action: 'Inspect' })
              ),
              {
                ...registrationExpectation,
                action: 'Inspect',
                registered: false,
              }
            )
          }
          browserOperation = 'native-probe'
          const observed = await within(
            () => session.runCase(),
            browser === 'firefox' ? 16000 : 21000
          )
          observation = safeBrowserProbeObservation(observed)
          const safe = validateBrowserProbeResult({
            result: observed,
            browser,
            registered: name === 'registered',
            installedState: before,
            expectedPackageVersion,
          })
          browserReport.checks.push({ name, ok: true, ...safe })
          report.testCount += 1
          observation = undefined
          browserOperation = 'verify-installed-after'
          await snapshot()
        }
        if (
          (await within(() => fixtureSource(browser))).sha256 !== source.sha256
        )
          fail('fixture-invalid')
        if (!isDeepStrictEqual(await within(() => inventory(browser)), details))
          fail('browser-brand-mismatch')
        browserReport.ok = true
      } catch (error) {
        if (codeOf(error) === 'browser-cleanup-failed')
          browserReport.cleanup.push({
            name: 'close-browser',
            ok: false,
            code: 'browser-cleanup-failed',
          })
        browserReport.checks.push({
          name: browserStep,
          ok: false,
          code: codeOf(error),
          ...(CASES.includes(browserStep)
            ? { operation: browserOperation }
            : {}),
          ...observation,
        })
      } finally {
        async function clean(name, action) {
          try {
            await timed(action(), 15000, 'browser-cleanup-failed')
            browserReport.cleanup.push({ name, ok: true })
          } catch (error) {
            browserReport.cleanup.push({ name, ok: false, code: codeOf(error) })
          }
        }
        if (session) await clean('close-browser', () => session.close())
        if (receiptSha256)
          await clean('remove-registration', async () => {
            checkRegistration(
              await register({
                ...registerInput,
                action: 'Remove',
                receiptSha256,
              }),
              {
                ...registrationExpectation,
                action: 'Remove',
                registered: false,
              }
            )
            registrationAttempted = false
          })
        if (registrationAttempted)
          browserReport.cleanup.push({
            name: 'registration-ownership',
            ok: false,
            code: 'registration-cleanup-failed',
          })
        if (profileCreated)
          await clean('remove-profile', async () => {
            if (
              browserReport.cleanup.some(
                (item) => item.name === 'close-browser' && !item.ok
              )
            )
              fail('browser-cleanup-failed')
            await safeDirectory(profileDirectory)
            await rm(profileDirectory, { recursive: true, force: false })
          })
        browserReport.cleanupVerified =
          browserReport.cleanup.every((item) => item.ok) &&
          !registrationAttempted
        browserReport.ok &&= browserReport.cleanupVerified
      }
      if (!browserReport.ok) break
    }
    step = 'installed-after'
    await snapshot()
    report.checks.push({ name: step, ok: true })
    report.cleanupVerified = report.browsers.every(
      (value) => value.cleanupVerified
    )
    report.ok =
      report.browsers.length === 3 &&
      report.browsers.every((value) => value.ok) &&
      report.testCount === 9 &&
      report.cleanupVerified
    report.browserNativeMessagingVerified = report.ok
  } catch (error) {
    report.checks.push({ name: step, ok: false, code: codeOf(error) })
  }
  return report
}

async function main(args) {
  let report = emptyReport()
  let outputDirectory
  try {
    const options = {}
    for (let index = 0; index < args.length; index += 2) {
      if (
        ![
          '--prepared',
          '--expected-package-version',
          '--output-directory',
          '--firefox-relay-build-dir',
        ].includes(args[index]) ||
        Object.hasOwn(options, args[index]) ||
        !args[index + 1] ||
        args[index + 1].startsWith('--')
      )
        fail('invalid-arguments')
      options[args[index]] = args[index + 1]
    }
    if (
      ![3, 4].includes(Object.keys(options).length) ||
      !options['--prepared'] ||
      !options['--output-directory'] ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(options['--expected-package-version'])
    )
      fail('invalid-arguments')
    await createBrowserOutputDirectory({
      preparedDirectory: options['--prepared'],
      outputDirectory: options['--output-directory'],
    })
    outputDirectory = options['--output-directory']
    if (process.platform !== 'win32') fail('windows-required')
    const preparedDirectory = options['--prepared']
    const layout = await verifyWindowsStoreLayout({
      preparedDirectory,
      phase: 'indexed',
    })
    if (!layout.ok) fail('layout-verification-failed')
    const metadata = validateWindowsStoreMetadata(
      JSON.parse(
        utf8(
          await readInstalledFile(
            path.join(preparedDirectory, 'release-metadata.json'),
            65536
          )
        )
      )
    ).metadata
    const diagnostic = await loadPreparedWindowsStoreDiagnostic({
      preparedDirectory,
      layoutDirectory: path.join(preparedDirectory, 'layout'),
      metadata,
    })
    report = await runBrowserNativeMessagingChecks({
      metadata,
      diagnostic,
      manifestBytes: Buffer.from(renderWindowsStoreManifest(metadata)),
      expectedPackageVersion: options['--expected-package-version'],
      outputDirectory,
      firefoxRelayBuildDirectory: options['--firefox-relay-build-dir'],
    })
    const after = await verifyWindowsStoreLayout({
      preparedDirectory,
      phase: 'indexed',
    })
    if (!after.ok || !isDeepStrictEqual(after, layout))
      fail('prepared-content-changed')
  } catch (error) {
    report.ok = false
    report.browserNativeMessagingVerified = false
    report.checks.push({
      name: 'input-or-prepared-layout',
      ok: false,
      code: codeOf(error),
    })
  }
  if (outputDirectory) {
    try {
      await safeDirectory(outputDirectory)
      const handle = await open(
        path.join(outputDirectory, 'browser-report.json'),
        'wx',
        0o600
      )
      try {
        await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`)
      } finally {
        await handle.close()
      }
    } catch {
      report.ok = false
      report.browserNativeMessagingVerified = false
      report.checks.push({
        name: 'report-output',
        ok: false,
        code: 'report-write-failed',
      })
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2))
