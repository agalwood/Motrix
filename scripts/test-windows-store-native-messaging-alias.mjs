import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { verifyWindowsStoreLayout } from './verify-windows-store-layout.mjs'
import { loadPreparedWindowsStoreDiagnostic } from './windows-store-diagnostics.mjs'
import { renderWindowsStoreManifest } from './windows-store-manifest.mjs'
import {
  WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC as DIAGNOSTIC,
  validateWindowsStoreMetadata,
} from './windows-store-metadata.mjs'

const CODES = new Set([
  'invalid-arguments',
  'windows-required',
  'invalid-metadata',
  'diagnostic-mode-required',
  'invalid-installed-state',
  'installed-package-count',
  'installed-package-mismatch',
  'invalid-os-context',
  'invalid-diagnostic-record',
  'installed-manifest-mismatch',
  'installed-executable-mismatch',
  'installed-state-changed',
  'invalid-process-options',
  'process-start-failed',
  'process-io-failed',
  'process-timeout',
  'process-stdout-limit',
  'process-stderr-limit',
  'process-signaled',
  'process-cleanup-failed',
  'os-query-failed',
  'invalid-reply-process',
  'invalid-reply-frame',
  'invalid-reply-json',
  'invalid-reply-fields',
  'invalid-reply-identity',
  'invalid-reply-caller',
  'invalid-caller-case',
  'unsafe-file',
  'file-changed',
  'layout-verification-failed',
  'prepared-content-changed',
  'report-write-failed',
  'report-already-exists',
  'internal-error',
])

class ProbeCheckError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'internal-error'
    super(safe)
    this.code = safe
  }
}
const fail = (code) => {
  throw new ProbeCheckError(code)
}
const errorCode = (error) =>
  error instanceof ProbeCheckError ? error.code : 'internal-error'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const windowsDirectory = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z]:\\/.test(value) &&
  !/[\p{Cc}<>"|?*]/u.test(value) &&
  !value.slice(2).includes(':') &&
  !value.split('\\').some((segment) => segment === '.' || segment === '..')

function diagnosticMetadata(raw, expectedPackageVersion) {
  let metadata
  try {
    metadata = validateWindowsStoreMetadata(raw).metadata
  } catch {
    fail('invalid-metadata')
  }
  if (metadata.testDiagnostics !== DIAGNOSTIC.mode)
    fail('diagnostic-mode-required')
  if (metadata.packageVersion !== expectedPackageVersion)
    fail('installed-package-mismatch')
  return metadata
}

/** Validate OS observations, not an assertion of signature or caller authenticity. */
export function validateInstalledProbeState({
  state,
  metadata: raw,
  expectedPackageVersion,
}) {
  const metadata = diagnosticMetadata(raw, expectedPackageVersion)
  if (
    !exactKeys(state, ['packages', 'localApplicationData', 'context']) ||
    !Array.isArray(state.packages) ||
    !windowsDirectory(state.localApplicationData)
  )
    fail('invalid-installed-state')
  if (state.packages.length !== 1) fail('installed-package-count')
  const installed = state.packages[0]
  if (
    !exactKeys(installed, [
      'name',
      'publisher',
      'version',
      'architecture',
      'packageFullName',
      'packageFamilyName',
      'installLocation',
      'isFramework',
      'isResourcePackage',
      'status',
    ]) ||
    installed.name !== metadata.identity.name ||
    installed.publisher !== metadata.identity.publisher ||
    installed.version !== expectedPackageVersion ||
    installed.architecture !== 'x64' ||
    installed.isFramework !== false ||
    installed.isResourcePackage !== false ||
    installed.status !== 'Ok' ||
    !windowsDirectory(installed.installLocation) ||
    typeof installed.packageFamilyName !== 'string'
  )
    fail('installed-package-mismatch')
  const familyPrefix = `${metadata.identity.name}_`
  const publisherId = installed.packageFamilyName.slice(familyPrefix.length)
  if (
    !installed.packageFamilyName.startsWith(familyPrefix) ||
    !/^[a-z0-9]{13}$/.test(publisherId) ||
    installed.packageFullName !==
      `${metadata.identity.name}_${expectedPackageVersion}_x64__${publisherId}`
  )
    fail('installed-package-mismatch')
  if (
    !exactKeys(state.context, ['osVersion', 'installationType', 'elevated']) ||
    typeof state.context.osVersion !== 'string' ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(state.context.osVersion) ||
    !['Client', 'Server', 'Server Core'].includes(
      state.context.installationType
    ) ||
    typeof state.context.elevated !== 'boolean'
  )
    fail('invalid-os-context')
  return {
    package: { ...installed },
    localApplicationData: state.localApplicationData,
    context: { ...state.context },
  }
}

const CALLERS = Object.freeze({
  none: [],
  syntheticChromium: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
  syntheticFirefox: [
    'unused-manifest-argument',
    'motrix-store-p0@motrix.invalid',
  ],
})

export function identityDigests(installedState) {
  return {
    packageFullNameSha256: hash(
      Buffer.from(installedState.package.packageFullName, 'utf8')
    ),
    applicationUserModelIdSha256: hash(
      Buffer.from(
        `${installedState.package.packageFamilyName}!${DIAGNOSTIC.applicationId}`,
        'utf8'
      )
    ),
  }
}

/** Check one complete frame. Identity hashes compare observations, not authentication. */
export function validateAliasProbeReply({
  stdout,
  stderr,
  exitCode,
  installedState,
  expectedPackageVersion,
  caller,
}) {
  if (!Object.hasOwn(CALLERS, caller)) fail('invalid-caller-case')
  if (
    typeof installedState?.package?.packageFullName !== 'string' ||
    typeof installedState?.package?.packageFamilyName !== 'string' ||
    installedState.package.version !== expectedPackageVersion
  )
    fail('invalid-installed-state')
  if (
    exitCode !== 0 ||
    !Buffer.isBuffer(stderr) ||
    stderr.length !== 0 ||
    !Buffer.isBuffer(stdout)
  )
    fail('invalid-reply-process')
  if (stdout.length < 5 || stdout.length > 4100) fail('invalid-reply-frame')
  const length = stdout.readUInt32LE(0)
  if (length < 1 || length > 4096 || stdout.length !== length + 4)
    fail('invalid-reply-frame')
  let text
  let reply
  try {
    text = utf8(stdout.subarray(4))
    reply = JSON.parse(text)
  } catch {
    fail('invalid-reply-json')
  }
  // Duplicate JSON members are observable only in the raw direct frame. The
  // browser API delivers parsed objects and cannot provide that wire evidence.
  if ((text.match(/:/g) ?? []).length !== 11) fail('invalid-reply-fields')
  return validateInstalledProbeReply({
    reply,
    installedState,
    expectedPackageVersion,
    caller:
      caller === 'syntheticChromium'
        ? 'chromium'
        : caller === 'syntheticFirefox'
          ? 'firefox'
          : 'none',
  })
}

/** Validate a parsed observation; this does not assert raw framing or authentication. */
export function validateInstalledProbeReply({
  reply,
  installedState,
  expectedPackageVersion,
  caller,
}) {
  if (!['none', 'chromium', 'firefox'].includes(caller))
    fail('invalid-caller-case')
  if (
    typeof installedState?.package?.packageFullName !== 'string' ||
    typeof installedState?.package?.packageFamilyName !== 'string' ||
    installedState.package.version !== expectedPackageVersion
  )
    fail('invalid-installed-state')
  const fields = [
    'schemaVersion',
    'probe',
    'packageIdentityPresent',
    'packageFullNameSha256',
    'expectedPackageName',
    'packageVersion',
    'applicationIdentityPresent',
    'applicationUserModelIdSha256',
    'expectedHelperApplication',
    'chromiumCallerShape',
    'firefoxTestCallerShape',
  ]
  if (!exactKeys(reply, fields)) fail('invalid-reply-fields')
  const expectedIdentity = identityDigests(installedState)
  if (
    reply.schemaVersion !== 1 ||
    reply.probe !== 'motrix-store-p0' ||
    reply.packageVersion !== expectedPackageVersion ||
    reply.packageIdentityPresent !== true ||
    reply.expectedPackageName !== true ||
    reply.applicationIdentityPresent !== true ||
    reply.expectedHelperApplication !== true ||
    reply.packageFullNameSha256 !== expectedIdentity.packageFullNameSha256 ||
    reply.applicationUserModelIdSha256 !==
      expectedIdentity.applicationUserModelIdSha256
  )
    fail('invalid-reply-identity')
  if (
    reply.chromiumCallerShape !== (caller === 'chromium') ||
    reply.firefoxTestCallerShape !== (caller === 'firefox')
  )
    fail('invalid-reply-caller')
  return { ok: true }
}

/** Internal testable runner; CLI callers cannot override its fixed limits. */
export function runBoundedProbeProcess({
  executable,
  args = [],
  input = Buffer.alloc(0),
  timeoutMs = 15000,
  maxStdoutBytes = 4100,
  maxStderrBytes = 1024,
}) {
  if (
    typeof executable !== 'string' ||
    !path.isAbsolute(executable) ||
    !Array.isArray(args) ||
    args.length > 16 ||
    args.some(
      (argument) => typeof argument !== 'string' || argument.length > 8192
    ) ||
    !Buffer.isBuffer(input) ||
    input.length > 1024 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 15000 ||
    !Number.isInteger(maxStdoutBytes) ||
    maxStdoutBytes < 1 ||
    maxStdoutBytes > 32768 ||
    !Number.isInteger(maxStderrBytes) ||
    maxStderrBytes < 1 ||
    maxStderrBytes > 1024
  )
    return Promise.reject(new ProbeCheckError('invalid-process-options'))
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      reject(new ProbeCheckError('process-start-failed'))
      return
    }
    let settled = false
    let failure
    let cleanupTimer
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    function finish(code, signal) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(cleanupTimer)
      if (failure) reject(new ProbeCheckError(failure))
      else if (signal !== null || !Number.isInteger(code))
        reject(new ProbeCheckError('process-signaled'))
      else
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code,
        })
    }
    function stop(code) {
      if (settled || failure) return
      failure = code
      try {
        child.kill('SIGKILL')
      } catch {
        failure = 'process-cleanup-failed'
      }
      child.stdin.destroy()
      // Normally close follows the kill and reaps our process. Bound cleanup
      // too, including a pipe held open by an unexpected descendant.
      cleanupTimer = setTimeout(() => {
        failure = 'process-cleanup-failed'
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(null, null)
      }, 2000)
    }
    const timer = setTimeout(() => stop('process-timeout'), timeoutMs)
    child.on('error', () => stop('process-start-failed'))
    child.stdin.on('error', () => stop('process-io-failed'))
    child.stdout.on('error', () => stop('process-io-failed'))
    child.stderr.on('error', () => stop('process-io-failed'))
    child.stdout.on('data', (chunk) => {
      if (failure) return
      stdoutBytes += chunk.length
      if (stdoutBytes > maxStdoutBytes) stop('process-stdout-limit')
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (failure) return
      stderrBytes += chunk.length
      if (stderrBytes > maxStderrBytes) stop('process-stderr-limit')
      else stderr.push(chunk)
    })
    child.on('close', finish)
    try {
      child.stdin.end(input)
    } catch {
      stop('process-io-failed')
    }
  })
}

async function safeDirectory(absolute) {
  const root = path.parse(absolute).root
  let current = root
  for (const segment of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe-file')
  }
}

export async function readInstalledFile(absolute, maximum) {
  await safeDirectory(path.dirname(absolute))
  const before = await lstat(absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size === 0 ||
    before.size > maximum
  )
    fail('unsafe-file')
  const file = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  )
  try {
    const actual = await file.stat()
    if (
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      !actual.isFile()
    )
      fail('file-changed')
    const bytes = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        count,
        bytes.length - count,
        count
      )
      if (bytesRead === 0) break
      count += bytesRead
    }
    const after = await file.stat()
    if (
      count !== before.size ||
      after.size !== before.size ||
      actual.mtimeMs !== after.mtimeMs
    )
      fail('file-changed')
    return bytes.subarray(0, count)
  } finally {
    await file.close()
  }
}

const OS_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { exit 1 }
  $packages = @(Get-AppxPackage -Name 'Motrix.Store.Test' -ErrorAction Stop | ForEach-Object {
    [ordered]@{ name = $_.Name; publisher = $_.Publisher; version = $_.Version.ToString(); architecture = $_.Architecture.ToString().ToLowerInvariant(); packageFullName = $_.PackageFullName; packageFamilyName = $_.PackageFamilyName; installLocation = $_.InstallLocation; isFramework = $_.IsFramework; isResourcePackage = $_.IsResourcePackage; status = $_.Status.ToString() }
  })
  $os = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name CurrentMajorVersionNumber,CurrentMinorVersionNumber,CurrentBuildNumber,UBR,InstallationType -ErrorAction Stop
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  [ordered]@{
    packages = $packages
    localApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    context = [ordered]@{ osVersion = ([Version]"$($os.CurrentMajorVersionNumber).$($os.CurrentMinorVersionNumber).$($os.CurrentBuildNumber).$($os.UBR)").ToString(); installationType = $os.InstallationType; elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  } | ConvertTo-Json -Compress -Depth 8
} catch { exit 1 }
`

export async function queryInstalledState() {
  if (process.platform !== 'win32') fail('windows-required')
  const systemRoot = process.env.SystemRoot
  if (!windowsDirectory(systemRoot)) fail('os-query-failed')
  const result = await runBoundedProbeProcess({
    executable: path.win32.join(
      systemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe'
    ),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(OS_QUERY, 'utf16le').toString('base64'),
    ],
    maxStdoutBytes: 32768,
  })
  if (result.exitCode !== 0 || result.stderr.length !== 0)
    fail('os-query-failed')
  try {
    return JSON.parse(utf8(result.stdout))
  } catch {
    fail('os-query-failed')
  }
}

function emptyReport() {
  return {
    schemaVersion: 1,
    scope: 'windows-native-messaging-installed-alias',
    ok: false,
    checks: [],
    testCount: 0,
    context: null,
    aliasActivationVerified: false,
    packageIdentityVerified: false,
    browserNativeMessagingVerified: false,
    mbp1Verified: false,
    windows11AcceptanceVerified: false,
    signatureVerified: false,
    packageInstallationPerformed: false,
  }
}

/** Core OS interactions are injectable for local tests; the CLI uses only defaults. */
export async function runInstalledAliasChecks(
  { metadata: raw, diagnostic, manifestBytes, expectedPackageVersion },
  dependencies = {}
) {
  const query = dependencies.queryInstalledState ?? queryInstalledState
  const read = dependencies.readInstalledFile ?? readInstalledFile
  const run = dependencies.runProcess ?? runBoundedProbeProcess
  const report = emptyReport()
  let step = 'diagnostic-inputs'
  try {
    const metadata = diagnosticMetadata(raw, expectedPackageVersion)
    if (
      diagnostic?.executable?.path !== DIAGNOSTIC.executable ||
      !Number.isSafeInteger(diagnostic.executable.bytes) ||
      diagnostic.executable.bytes < 1 ||
      diagnostic.executable.bytes > 1024 * 1024 ||
      typeof diagnostic.executable.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(diagnostic.executable.sha256) ||
      !Buffer.isBuffer(manifestBytes) ||
      manifestBytes.length === 0 ||
      manifestBytes.length > 65536
    )
      fail('invalid-diagnostic-record')
    report.packageVersion = metadata.packageVersion
    report.sourceCommit = metadata.source.commit
    report.executableSha256 = diagnostic.executable.sha256
    async function checkInstalledContent(state) {
      const root = state.package.installLocation
      const manifest = await read(
        path.win32.join(root, 'AppxManifest.xml'),
        65536
      )
      if (!Buffer.isBuffer(manifest) || !manifest.equals(manifestBytes))
        fail('installed-manifest-mismatch')
      const executable = await read(
        path.win32.join(root, DIAGNOSTIC.executable),
        1024 * 1024
      )
      if (
        !Buffer.isBuffer(executable) ||
        executable.length !== diagnostic.executable.bytes ||
        hash(executable) !== diagnostic.executable.sha256
      )
        fail('installed-executable-mismatch')
    }
    step = 'installed-state-before'
    const before = validateInstalledProbeState({
      state: await query(),
      metadata,
      expectedPackageVersion,
    })
    report.context = before.context
    report.checks.push({ name: step, ok: true })
    step = 'installed-content-before'
    await checkInstalledContent(before)
    report.checks.push({ name: step, ok: true })
    const alias = path.win32.join(
      before.localApplicationData,
      'Microsoft/WindowsApps',
      DIAGNOSTIC.alias
    )
    const body = Buffer.from('{"probe":"motrix-store-p0"}', 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(body.length)
    for (const [caller, args] of Object.entries(CALLERS)) {
      step = `alias-${caller}`
      // The alias is an OS reparse point. Do not reject it as a regular-file
      // symlink, resolve PATH, or fall back to launching the probe directly.
      const result = await run({
        executable: alias,
        args,
        input: Buffer.concat([header, body]),
        timeoutMs: 15000,
        maxStdoutBytes: 4100,
        maxStderrBytes: 1024,
      })
      const check = {
        name: step,
        ok: false,
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
        stdoutBytes: Buffer.isBuffer(result?.stdout)
          ? result.stdout.length
          : null,
        stderrBytes: Buffer.isBuffer(result?.stderr)
          ? result.stderr.length
          : null,
        callerEvidence: caller === 'none' ? 'none' : 'simulated-argv-only',
      }
      report.checks.push(check)
      validateAliasProbeReply({
        ...result,
        installedState: before,
        expectedPackageVersion,
        caller,
      })
      check.ok = true
      check.frameCount = 1
      report.identity ??= identityDigests(before)
      report.testCount += 1
    }
    step = 'installed-state-after'
    const after = validateInstalledProbeState({
      state: await query(),
      metadata,
      expectedPackageVersion,
    })
    if (!isDeepStrictEqual(after, before)) fail('installed-state-changed')
    report.checks.push({ name: step, ok: true })
    step = 'installed-content-after'
    await checkInstalledContent(after)
    report.checks.push({ name: step, ok: true })
    report.ok = true
    report.aliasActivationVerified = true
    report.packageIdentityVerified = true
  } catch (error) {
    const last = report.checks.at(-1)
    if (last?.name === step && last.ok === false) last.code = errorCode(error)
    else report.checks.push({ name: step, ok: false, code: errorCode(error) })
  }
  return report
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    if (
      !['--prepared', '--expected-package-version', '--report'].includes(key) ||
      Object.hasOwn(options, key) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      fail('invalid-arguments')
    options[key] = args[index + 1]
  }
  if (
    Object.keys(options).length !== 3 ||
    !path.isAbsolute(options['--prepared']) ||
    !path.isAbsolute(options['--report']) ||
    path.extname(options['--report']).toLowerCase() !== '.json'
  )
    fail('invalid-arguments')
  return options
}

async function writeReport(file, report) {
  await safeDirectory(path.dirname(file))
  const handle = await open(
    file,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600
  )
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

async function main(args) {
  let report = emptyReport()
  let options
  let reportPath
  try {
    options = parseArgs(args)
    const relative = path.relative(
      path.resolve(options['--prepared']),
      path.resolve(options['--report'])
    )
    if (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative))
    )
      fail('invalid-arguments')
    try {
      await lstat(options['--report'])
      fail('report-already-exists')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    reportPath = options['--report']
    if (process.platform !== 'win32') fail('windows-required')
    const preparedDirectory = options['--prepared']
    const layout = await verifyWindowsStoreLayout({
      preparedDirectory,
      phase: 'indexed',
    })
    if (!layout.ok) fail('layout-verification-failed')
    const metadata = diagnosticMetadata(
      JSON.parse(
        utf8(
          await readInstalledFile(
            path.join(preparedDirectory, 'release-metadata.json'),
            65536
          )
        )
      ),
      options['--expected-package-version']
    )
    const diagnostic = await loadPreparedWindowsStoreDiagnostic({
      preparedDirectory,
      layoutDirectory: path.join(preparedDirectory, 'layout'),
      metadata,
    })
    const manifestBytes = Buffer.from(
      renderWindowsStoreManifest(metadata),
      'utf8'
    )
    report = await runInstalledAliasChecks({
      metadata,
      diagnostic,
      manifestBytes,
      expectedPackageVersion: options['--expected-package-version'],
    })
    if (report.ok) {
      const finalLayout = await verifyWindowsStoreLayout({
        preparedDirectory,
        phase: 'indexed',
      })
      if (!finalLayout.ok || !isDeepStrictEqual(finalLayout, layout))
        fail('prepared-content-changed')
    }
  } catch (error) {
    report.ok = false
    report.aliasActivationVerified = false
    report.packageIdentityVerified = false
    report.checks.push({
      name: 'input-or-prepared-layout',
      ok: false,
      code: errorCode(error),
    })
  }
  if (reportPath) {
    try {
      await writeReport(reportPath, report)
    } catch {
      report.ok = false
      report.aliasActivationVerified = false
      report.packageIdentityVerified = false
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
