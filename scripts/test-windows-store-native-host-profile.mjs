import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  queryInstalledState,
  readInstalledFile,
  runBoundedProbeProcess,
  validateInstalledProbeState,
} from './test-windows-store-native-messaging-alias.mjs'
import { verifyWindowsStoreLayout } from './verify-windows-store-layout.mjs'
import { renderWindowsStoreManifest } from './windows-store-manifest.mjs'
import { WINDOWS_STORE_NATIVE_HOST_PROFILE_DIAGNOSTIC as PROFILE } from './windows-store-metadata.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const requestBody = Buffer.from('{"allowLaunch":false}')
const header = Buffer.alloc(4)
header.writeUInt32LE(requestBody.length)
const input = Buffer.concat([header, requestBody])
const clearedEnvironment = {
  MOTRIX_USER_DATA: null,
  MOTRIX_BRIDGE_DATA_DIR: null,
}
const FAILURE_CODES = new Set([
  'invalid-profile-host-frame',
  'invalid-profile-host-json',
  'unexpected-profile-host-reply',
  'unexpected-fixture-traffic',
  'process-start-failed',
  'process-io-failed',
  'process-timeout',
  'process-stdout-limit',
  'process-stderr-limit',
  'process-signaled',
  'process-cleanup-failed',
])

export function validateProfileHostReply(result, expected) {
  if (
    result.exitCode !== 0 ||
    !Buffer.isBuffer(result.stderr) ||
    result.stderr.length !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    result.stdout.length < 5 ||
    result.stdout.length > 4100 ||
    result.stdout.readUInt32LE(0) !== result.stdout.length - 4
  )
    throw new Error('invalid-profile-host-frame')
  let actual
  try {
    actual = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        result.stdout.subarray(4)
      )
    )
  } catch {
    throw new Error('invalid-profile-host-json')
  }
  if (!isDeepStrictEqual(actual, expected))
    throw new Error('unexpected-profile-host-reply')
}

/** A live synthetic bridge is the positive control, never an application endpoint.
 * A negative alias reply proves refusal of this override, not profile parity or
 * successful package/AUMID resolution. No bootstrap request or ticket is used.
 */
export async function runProfileIsolationCases(
  { directExecutable, aliasExecutable, temporaryParent },
  run = runBoundedProbeProcess
) {
  const report = {
    ok: false,
    checks: [],
    cleanupVerified: false,
    overrideConnectionRejected: false,
    profileParityVerified: false,
    mbp1Verified: false,
    mainApplicationLaunched: false,
  }
  let directory
  let server
  let listening = false
  let stage = 'fixture'
  let requests = 0
  let unexpectedRequest = false
  let observation
  try {
    directory = await mkdtemp(
      path.join(temporaryParent, 'native-host-profile-fixture-')
    )
    const nonce = randomBytes(24).toString('base64url')
    server = createServer((request, response) => {
      requests += 1
      let body
      if (request.method === 'GET' && request.url === '/discovery')
        body = {
          app: 'motrix-bridge',
          apiVersion: 1,
          instanceId: 'store-profile-fixture',
          appVersion: '2.0.0',
        }
      else if (
        request.method === 'POST' &&
        request.url === '/nonce' &&
        request.headers['x-motrix-bridge'] === '1'
      )
        body = { nonce }
      else {
        unexpectedRequest = true
        response.statusCode = 400
        body = {}
      }
      const text = JSON.stringify(body)
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Content-Length', Buffer.byteLength(text))
      response.setHeader('Connection', 'close')
      response.end(text)
    })
    server.requestTimeout = 3000
    server.headersTimeout = 3000
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    listening = true
    const port = server.address().port
    await writeFile(
      path.join(directory, 'endpoint.json'),
      JSON.stringify({ port }),
      { flag: 'wx', mode: 0o600 }
    )
    const override = {
      ...clearedEnvironment,
      MOTRIX_BRIDGE_DATA_DIR: directory,
    }
    for (const [
      name,
      executable,
      profileEnvironment,
      expectedRequests,
      expected,
    ] of [
      [
        'direct-control-before',
        directExecutable,
        override,
        2,
        { action: 'requestPair', protocolVersion: 1, port, nonce },
      ],
      [
        'alias-rejects-override',
        aliasExecutable,
        override,
        0,
        { error: 'motrix-not-running' },
      ],
      [
        'alias-without-endpoint',
        aliasExecutable,
        clearedEnvironment,
        0,
        { error: 'motrix-not-running' },
      ],
      [
        'direct-control-after',
        directExecutable,
        override,
        2,
        { action: 'requestPair', protocolVersion: 1, port, nonce },
      ],
    ]) {
      stage = name
      observation = undefined
      const before = requests
      const result = await run({
        executable,
        input,
        profileEnvironment,
        timeoutMs: 15000,
      })
      observation = {
        exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
        stdoutBytes: Buffer.isBuffer(result?.stdout)
          ? result.stdout.length
          : null,
        stderrBytes: Buffer.isBuffer(result?.stderr)
          ? result.stderr.length
          : null,
        fixtureRequests: requests - before,
      }
      validateProfileHostReply(result, expected)
      if (unexpectedRequest || requests - before !== expectedRequests)
        throw new Error('unexpected-fixture-traffic')
      report.checks.push({
        name,
        ok: true,
        fixtureRequests: requests - before,
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      })
    }
    report.ok = true
  } catch (error) {
    // Never persist raw process output, endpoint paths, ports or nonces.
    report.checks.push({
      name: stage,
      ok: false,
      ...observation,
      code: FAILURE_CODES.has(error?.message)
        ? error.message
        : 'profile-check-failed',
    })
  } finally {
    try {
      if (server && listening) {
        server.closeAllConnections()
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
      }
      if (directory) await rm(directory, { recursive: true, force: false })
      report.cleanupVerified = true
    } catch {
      report.ok = false
      report.checks.push({ name: 'fixture-cleanup', ok: false })
    }
  }
  report.overrideConnectionRejected = report.ok && report.cleanupVerified
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
      throw new Error('invalid-arguments')
    options[args[i]] = args[i + 1]
  }
  const prepared = options['--prepared']
  const destination = options['--report']
  if (
    Object.keys(options).length !== 3 ||
    !path.isAbsolute(prepared) ||
    !path.isAbsolute(destination) ||
    path.extname(destination) !== '.json'
  )
    throw new Error('invalid-arguments')
  const relative = path.relative(prepared, destination)
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
    throw new Error('invalid-arguments')
  // Claim the report before executing; never overwrite earlier evidence.
  const output = await open(destination, 'wx', 0o600)
  const report = {
    schemaVersion: 1,
    scope: 'windows-native-host-profile-isolation',
    ok: false,
    checks: [],
    profileParityVerified: false,
    mbp1Verified: false,
    windows11AcceptanceVerified: false,
    storeReady: false,
  }
  let stage = 'prepared-inputs'
  try {
    if (process.platform !== 'win32') throw new Error('windows-required')
    const initialLayout = await verifyWindowsStoreLayout({
      preparedDirectory: prepared,
      phase: 'indexed',
    })
    if (!initialLayout.ok) throw new Error('invalid-layout')
    const metadata = JSON.parse(
      (
        await readInstalledFile(
          path.join(prepared, 'release-metadata.json'),
          65536
        )
      ).toString('utf8')
    )
    const before = validateInstalledProbeState({
      state: await queryInstalledState(),
      metadata,
      expectedPackageVersion: options['--expected-package-version'],
    })
    report.sourceCommit = metadata.source.commit
    report.packageVersion = metadata.packageVersion
    report.context = before.context
    const executable = path.join(prepared, 'layout', PROFILE.executable)
    const expectedBytes = await readInstalledFile(executable, 32 * 1024 * 1024)
    report.nativeHostSha256 = hash(expectedBytes)
    async function installedContent() {
      const manifest = await readInstalledFile(
        path.win32.join(before.package.installLocation, 'AppxManifest.xml'),
        65536
      )
      if (!manifest.equals(Buffer.from(renderWindowsStoreManifest(metadata))))
        throw new Error('manifest-mismatch')
      const installed = await readInstalledFile(
        path.win32.join(before.package.installLocation, PROFILE.executable),
        32 * 1024 * 1024
      )
      if (!installed.equals(expectedBytes))
        throw new Error('executable-mismatch')
    }
    stage = 'installed-content-before'
    await installedContent()
    report.checks.push({ name: stage, ok: true })
    stage = 'profile-cases'
    const cases = await runProfileIsolationCases({
      directExecutable: executable,
      aliasExecutable: path.win32.join(
        before.localApplicationData,
        'Microsoft/WindowsApps',
        PROFILE.alias
      ),
      temporaryParent: path.dirname(destination),
    })
    report.cases = cases
    stage = 'installed-content-after'
    await installedContent()
    const after = validateInstalledProbeState({
      state: await queryInstalledState(),
      metadata,
      expectedPackageVersion: options['--expected-package-version'],
    })
    if (!isDeepStrictEqual(before, after))
      throw new Error('installed-state-changed')
    const finalLayout = await verifyWindowsStoreLayout({
      preparedDirectory: prepared,
      phase: 'indexed',
    })
    if (!finalLayout.ok || !isDeepStrictEqual(initialLayout, finalLayout))
      throw new Error('prepared-content-changed')
    report.checks.push({ name: stage, ok: true })
    report.ok = cases.ok && cases.cleanupVerified
  } catch {
    report.checks.push({ name: stage, ok: false })
  } finally {
    try {
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
    process.stderr.write('Native host profile check failed\n')
    process.exitCode = 1
  })
