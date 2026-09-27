// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runBoundedProbeProcess,
  runInstalledAliasChecks,
  validateAliasProbeReply,
  validateInstalledProbeState,
} from '../../scripts/test-windows-store-native-messaging-alias.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import { WINDOWS_STORE_PAYLOAD_METADATA } from '../helpers/windows-store-payload-fixture'

const VERSION = '4.5.6.0'
const PUBLISHER_ID = 'abcde12345678'
const FAMILY = `Motrix.Store.Test_${PUBLISHER_ID}`
const FULL_NAME = `Motrix.Store.Test_${VERSION}_x64__${PUBLISHER_ID}`
const AUMID = `${FAMILY}!MotrixNativeHostP0`
const PRIVATE_PATH = 'C:\\Private Sentinel\\Installed Motrix'
const PRIVATE_ARG = 'private-argument-must-not-be-reported'
const metadata = {
  ...WINDOWS_STORE_PAYLOAD_METADATA,
  profile: 'test',
  identity: WINDOWS_STORE_TEST_IDENTITY,
  testDiagnostics: 'native-messaging-probe-v1',
}
const roots: string[] = []
const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

function state() {
  return {
    packages: [
      {
        name: 'Motrix.Store.Test',
        publisher: 'CN=Motrix Store Test',
        version: VERSION,
        architecture: 'x64',
        packageFullName: FULL_NAME,
        packageFamilyName: FAMILY,
        installLocation: PRIVATE_PATH,
        isFramework: false,
        isResourcePackage: false,
        status: 'Ok',
      },
    ],
    localApplicationData: 'C:\\Users\\Private Sentinel\\AppData\\Local',
    context: {
      osVersion: '10.0.26100.0',
      installationType: 'Client',
      elevated: false,
    },
  }
}
function installed(input = state()) {
  return validateInstalledProbeState({
    state: input,
    metadata,
    expectedPackageVersion: VERSION,
  })
}
function reply() {
  return {
    schemaVersion: 1,
    probe: 'motrix-store-p0',
    packageIdentityPresent: true,
    packageFullNameSha256: sha256(FULL_NAME),
    expectedPackageName: true,
    packageVersion: VERSION,
    applicationIdentityPresent: true,
    applicationUserModelIdSha256: sha256(AUMID),
    expectedHelperApplication: true,
    chromiumCallerShape: false,
    firefoxTestCallerShape: false,
  }
}
function frame(body: Buffer | string | object) {
  const bytes = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(bytes.length)
  return Buffer.concat([prefix, bytes])
}
function checkReply(
  stdout = frame(reply()),
  overrides: Record<string, unknown> = {}
) {
  return validateAliasProbeReply({
    stdout,
    stderr: Buffer.alloc(0),
    exitCode: 0,
    installedState: installed(),
    expectedPackageVersion: VERSION,
    caller: 'none',
    ...overrides,
  })
}
function safeFailure(operation: () => unknown) {
  let failure: unknown
  try {
    operation()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  const error = failure as Error & { code: string }
  expect(error.code).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  expect(error.message).toBe(error.code)
  for (const secret of [PRIVATE_PATH, PRIVATE_ARG, FULL_NAME, AUMID]) {
    expect(error.message).not.toContain(secret)
  }
}
async function safeProcessFailure(options: Record<string, unknown>) {
  let failure: unknown
  try {
    await runBoundedProbeProcess(options)
  } catch (error) {
    failure = error
  }
  safeFailure(() => {
    throw failure
  })
}
function node(script: string, options: Record<string, unknown> = {}) {
  return {
    executable: process.execPath,
    args: ['-e', script],
    input: Buffer.alloc(0),
    timeoutMs: 2000,
    ...options,
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('installed diagnostic alias state contract', () => {
  it('accepts one exact installed test identity without treating synthetic state as Windows evidence', () => {
    const source = state()
    const checked = installed(source)
    expect(checked.package).toEqual(source.packages[0])
    expect(checked.context).toEqual(source.context)
  })

  it.each(['missing', 'ambiguous'])(
    'rejects an unavailable unique package: %s',
    (mode) => {
      const value = state()
      value.packages =
        mode === 'missing' ? [] : [...value.packages, ...value.packages]
      safeFailure(() => installed(value))
    }
  )

  it.each([
    ['name', 'Motrix.Store.Test.Other'],
    ['publisher', 'CN=Other Publisher'],
    ['version', '4.5.5.0'],
    ['architecture', 'arm64'],
    ['packageFamilyName', 'Motrix.Store.Test_zzzzz12345678'],
    ['packageFullName', 'Motrix.Store.Test_4.5.6.0_x64__zzzzz12345678'],
    ['installLocation', '\\\\server\\share\\probe'],
    ['status', 'Tampered'],
  ])('rejects mismatched installed %s', (key, value) => {
    const input = state()
    Object.assign(input.packages[0], { [key]: value })
    safeFailure(() => installed(input))
  })

  it('rejects a framework or resource package instead of treating it as the application', () => {
    for (const field of ['isFramework', 'isResourcePackage']) {
      const input = state()
      Object.assign(input.packages[0], { [field]: true })
      safeFailure(() => installed(input))
    }
  })

  it('requires the expected version to agree with release metadata', () => {
    safeFailure(() =>
      validateInstalledProbeState({
        state: state(),
        metadata,
        expectedPackageVersion: '4.5.7.0',
      })
    )
  })
})

describe('single framed diagnostic alias reply', () => {
  it('accepts complete identity hashes for the exact package and helper', () => {
    expect(checkReply()).toEqual({ ok: true })
  })

  it.each(['syntheticChromium', 'syntheticFirefox'])(
    'records only the requested synthetic caller shape: %s',
    (caller) => {
      const value = reply()
      value.chromiumCallerShape = caller === 'syntheticChromium'
      value.firefoxTestCallerShape = caller === 'syntheticFirefox'
      expect(checkReply(frame(value), { caller })).toEqual({ ok: true })
      safeFailure(() => checkReply(frame(value)))
    }
  )

  it.each([
    'other-publisher',
    'other-package-version',
    'other-helper',
    'family-only',
  ])(
    'rejects identity substitution even when all presence/name booleans are true: %s',
    (mode) => {
      const value = reply()
      if (mode === 'other-publisher')
        value.packageFullNameSha256 = sha256(
          FULL_NAME.replace(PUBLISHER_ID, 'zzzzz12345678')
        )
      if (mode === 'other-package-version')
        value.packageFullNameSha256 = sha256(
          FULL_NAME.replace(VERSION, '4.5.5.0')
        )
      if (mode === 'other-helper')
        value.applicationUserModelIdSha256 = sha256(`${FAMILY}!Motrix`)
      if (mode === 'family-only') value.packageFullNameSha256 = sha256(FAMILY)
      safeFailure(() => checkReply(frame(value)))
    }
  )

  it.each([
    'unknown-field',
    'missing-field',
    'string-boolean',
    'wrong-version',
    'wrong-probe',
  ])('rejects an invalid reply contract: %s', (mode) => {
    const value: Record<string, unknown> = reply()
    if (mode === 'unknown-field') value.rawIdentity = PRIVATE_PATH
    if (mode === 'missing-field') delete value.expectedHelperApplication
    if (mode === 'string-boolean') value.packageIdentityPresent = 'true'
    if (mode === 'wrong-version') value.packageVersion = '4.5.5.0'
    if (mode === 'wrong-probe') value.probe = PRIVATE_ARG
    safeFailure(() => checkReply(frame(value)))
  })

  it.each([
    'empty',
    'truncated-prefix',
    'truncated-body',
    'zero-length',
    'oversized',
    'invalid-utf8',
    'trailing-byte',
    'second-frame',
  ])('rejects ambiguous or malformed stdout: %s', (mode) => {
    const valid = frame(reply())
    let stdout: Buffer = valid
    if (mode === 'empty') stdout = Buffer.alloc(0)
    if (mode === 'truncated-prefix') stdout = valid.subarray(0, 3)
    if (mode === 'truncated-body') stdout = valid.subarray(0, valid.length - 1)
    if (mode === 'zero-length') stdout = Buffer.alloc(4)
    if (mode === 'oversized') {
      stdout = Buffer.alloc(4)
      stdout.writeUInt32LE(0xffffffff)
    }
    if (mode === 'invalid-utf8') stdout = frame(Buffer.from([0xc3, 0x28]))
    if (mode === 'trailing-byte')
      stdout = Buffer.concat([valid, Buffer.from([0])])
    if (mode === 'second-frame') stdout = Buffer.concat([valid, valid])
    safeFailure(() => checkReply(stdout))
  })

  it('rejects any stderr or an unsuccessful child exit without echoing child text', () => {
    safeFailure(() =>
      checkReply(frame(reply()), { stderr: Buffer.from(PRIVATE_ARG) })
    )
    safeFailure(() => checkReply(frame(reply()), { exitCode: 7 }))
  })
})

describe('bounded local child process transport (not a Windows alias)', () => {
  it('writes binary stdin and collects exact stdout at the configured boundary', async () => {
    const input = frame({ probe: 'motrix-store-p0' })
    const result = await runBoundedProbeProcess(
      node(
        'const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks)))',
        { input, maxStdoutBytes: input.length }
      )
    )
    expect(result).toEqual({
      stdout: input,
      stderr: Buffer.alloc(0),
      exitCode: 0,
    })
  })

  it.each(['stdout', 'stderr'])(
    'terminates a child that exceeds the %s byte limit',
    async (channel) => {
      await safeProcessFailure(
        node(
          `process.${channel}.write(Buffer.alloc(8192,65));setInterval(()=>{},1000)`,
          { maxStdoutBytes: 64, maxStderrBytes: 64 }
        )
      )
    }
  )

  it('reaps a child when the total timeout expires', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-alias-child-'))
    roots.push(root)
    const pidFile = path.join(root, 'pid')
    await safeProcessFailure(
      node(
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
        { timeoutMs: 1000 }
      )
    )
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('returns a nonzero child exit for the reply validator to reject', async () => {
    const result = await runBoundedProbeProcess(node('process.exitCode=7'))
    expect(result.exitCode).toBe(7)
    safeFailure(() => checkReply(frame(reply()), { exitCode: result.exitCode }))
  })

  it('sanitizes spawn errors without leaking the attempted executable or arguments', async () => {
    await safeProcessFailure({
      executable: path.join(os.tmpdir(), PRIVATE_ARG, 'missing.exe'),
      args: [PRIVATE_ARG],
      input: Buffer.alloc(0),
      timeoutMs: 1000,
    })
  })
})

function aliasChecksFixture() {
  const manifestBytes = Buffer.from('synthetic prepared manifest bytes')
  const executableBytes = Buffer.from('synthetic prepared helper bytes')
  const options = {
    metadata,
    diagnostic: {
      executable: {
        path: 'diagnostics/motrix-store-p0-probe.exe',
        bytes: executableBytes.length,
        sha256: createHash('sha256').update(executableBytes).digest('hex'),
      },
    },
    manifestBytes,
    expectedPackageVersion: VERSION,
  }
  const deps = {
    queryInstalledState: vi.fn(async () => state()),
    readInstalledFile: vi.fn(async (file: string) => {
      if (file.endsWith('AppxManifest.xml')) return manifestBytes
      if (file.endsWith('motrix-store-p0-probe.exe')) return executableBytes
      throw new Error(`${PRIVATE_PATH}: unexpected file request`)
    }),
    runProcess: vi.fn(async ({ args }: { args: string[] }) => {
      const value = reply()
      value.chromiumCallerShape = args.length === 1
      value.firefoxTestCallerShape = args.length === 2
      return { stdout: frame(value), stderr: Buffer.alloc(0), exitCode: 0 }
    }),
  }
  return { options, deps, manifestBytes, executableBytes }
}

function expectSanitizedReport(report: Record<string, any>) {
  const fields = new Set([
    'schemaVersion',
    'scope',
    'ok',
    'checks',
    'testCount',
    'context',
    'packageVersion',
    'sourceCommit',
    'executableSha256',
    'identity',
    'aliasActivationVerified',
    'packageIdentityVerified',
    'browserNativeMessagingVerified',
    'mbp1Verified',
    'windows11AcceptanceVerified',
    'signatureVerified',
    'packageInstallationPerformed',
  ])
  expect(Object.keys(report).every((key) => fields.has(key))).toBe(true)
  for (const check of report.checks) {
    expect(
      Object.keys(check).every((key) =>
        [
          'name',
          'ok',
          'code',
          'callerEvidence',
          'exitCode',
          'stdoutBytes',
          'stderrBytes',
          'frameCount',
        ].includes(key)
      )
    ).toBe(true)
    if (check.code !== undefined)
      expect(check.code).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    if (check.callerEvidence !== undefined)
      expect(['none', 'simulated-argv-only']).toContain(check.callerEvidence)
    for (const field of ['exitCode', 'stdoutBytes', 'stderrBytes']) {
      if (Object.hasOwn(check, field))
        expect(
          check[field] === null || Number.isSafeInteger(check[field])
        ).toBe(true)
    }
    if (check.frameCount !== undefined) expect(check.frameCount).toBe(1)
  }
  if (report.identity !== undefined) {
    expect(Object.keys(report.identity).sort()).toEqual([
      'applicationUserModelIdSha256',
      'packageFullNameSha256',
    ])
    for (const value of Object.values(report.identity))
      expect(value).toMatch(/^[0-9a-f]{64}$/)
  }
  const serialized = JSON.stringify(report)
  for (const privateValue of [
    PRIVATE_PATH,
    PRIVATE_ARG,
    FULL_NAME,
    FAMILY,
    AUMID,
  ]) {
    expect(serialized).not.toContain(privateValue)
    expect(serialized).not.toContain(JSON.stringify(privateValue).slice(1, -1))
  }
  expect(report).toMatchObject({
    browserNativeMessagingVerified: false,
    mbp1Verified: false,
    windows11AcceptanceVerified: false,
    signatureVerified: false,
    packageInstallationPerformed: false,
  })
}

describe('installed alias check report with synthetic dependencies', () => {
  it('reports bounded checks and OS context without retaining identities, paths, or argv', async () => {
    const input = aliasChecksFixture()
    const report = await runInstalledAliasChecks(input.options, input.deps)
    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: 'windows-native-messaging-installed-alias',
      ok: true,
      testCount: 3,
      context: state().context,
      packageVersion: VERSION,
      sourceCommit: metadata.source.commit,
      identity: {
        packageFullNameSha256: sha256(FULL_NAME),
        applicationUserModelIdSha256: sha256(AUMID),
      },
      aliasActivationVerified: true,
      packageIdentityVerified: true,
    })
    expect(input.deps.runProcess).toHaveBeenCalledTimes(3)
    const cases = report.checks.filter((check: { name: string }) =>
      check.name.startsWith('alias-')
    )
    expect(cases).toHaveLength(3)
    for (const [index, check] of cases.entries()) {
      const result = await input.deps.runProcess.mock.results[index].value
      expect(check).toMatchObject({
        ok: true,
        exitCode: 0,
        stdoutBytes: result.stdout.length,
        stderrBytes: 0,
        frameCount: 1,
      })
    }
    expect(
      input.deps.queryInstalledState.mock.calls.length
    ).toBeGreaterThanOrEqual(2)
    expectSanitizedReport(report)
  })

  it('does not launch a probe when the installed publisher is wrong', async () => {
    const input = aliasChecksFixture()
    const wrong = state()
    wrong.packages[0].publisher = 'CN=Different Publisher'
    input.deps.queryInstalledState.mockResolvedValue(wrong)
    const report = await runInstalledAliasChecks(input.options, input.deps)
    expect(report.ok).toBe(false)
    expect(input.deps.runProcess).not.toHaveBeenCalled()
    expectSanitizedReport(report)
  })

  it.each(['package-state', 'helper-bytes', 'manifest-bytes'])(
    'rejects inputs that change between the before and after checks: %s',
    async (change) => {
      const input = aliasChecksFixture()
      let queries = 0
      input.deps.queryInstalledState.mockImplementation(async () => {
        const value = state()
        if (++queries > 1 && change === 'package-state')
          value.packages[0].installLocation = 'C:\\Other Private Location'
        return value
      })
      const reads = new Map<string, number>()
      input.deps.readInstalledFile.mockImplementation(async (file) => {
        const count = (reads.get(file) ?? 0) + 1
        reads.set(file, count)
        const manifest = file.endsWith('AppxManifest.xml')
        if (
          count > 1 &&
          ((manifest && change === 'manifest-bytes') ||
            (!manifest && change === 'helper-bytes'))
        )
          return Buffer.from('changed installed bytes')
        return manifest ? input.manifestBytes : input.executableBytes
      })
      const report = await runInstalledAliasChecks(input.options, input.deps)
      expect(report.ok).toBe(false)
      expect(report.aliasActivationVerified).toBe(false)
      expectSanitizedReport(report)
    }
  )

  it('replaces untrusted infrastructure errors and error codes with a public failure token', async () => {
    const input = aliasChecksFixture()
    input.deps.runProcess.mockRejectedValue(
      Object.assign(new Error(`${PRIVATE_PATH} ${FULL_NAME} ${PRIVATE_ARG}`), {
        code: PRIVATE_ARG,
      })
    )
    const report = await runInstalledAliasChecks(input.options, input.deps)
    expect(report.ok).toBe(false)
    expectSanitizedReport(report)
  })

  it('does not retain a malformed reply containing an unexpected raw identity field', async () => {
    const input = aliasChecksFixture()
    const stdout = frame({
      ...reply(),
      rawIdentity: `${PRIVATE_PATH} ${PRIVATE_ARG}`,
    })
    input.deps.runProcess.mockResolvedValue({
      stdout,
      stderr: Buffer.alloc(0),
      exitCode: 0,
    })
    const report = await runInstalledAliasChecks(input.options, input.deps)
    expect(report.ok).toBe(false)
    expect(report.identity).toBeUndefined()
    const failedCase = report.checks.find((check: { name: string }) =>
      check.name.startsWith('alias-')
    )
    expect(failedCase).toMatchObject({
      ok: false,
      exitCode: 0,
      stdoutBytes: stdout.length,
      stderrBytes: 0,
      code: expect.stringMatching(/^[a-z][a-z0-9-]*$/),
    })
    expect(failedCase.frameCount).toBeUndefined()
    expectSanitizedReport(report)
  })

  it('keeps invalid child result measurements as null without retaining their raw values', async () => {
    const input = aliasChecksFixture()
    input.deps.runProcess.mockResolvedValue({
      stdout: PRIVATE_ARG,
      stderr: Buffer.alloc(0),
      exitCode: PRIVATE_ARG,
    } as any)
    const report = await runInstalledAliasChecks(input.options, input.deps)
    expect(report.ok).toBe(false)
    expect(report.identity).toBeUndefined()
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        ok: false,
        exitCode: null,
        stdoutBytes: null,
        stderrBytes: 0,
      })
    )
    expectSanitizedReport(report)
  })
})

describe('alias CLI report output boundaries', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'motrix-alias-cli-'))
    roots.push(root)
    const prepared = path.join(root, 'prepared')
    await mkdir(prepared)
    await writeFile(path.join(prepared, 'keep.txt'), 'prepared sentinel')
    return { root, prepared }
  }

  function invoke(prepared: string, report: string) {
    return spawnSync(
      process.execPath,
      [
        path.resolve('scripts/test-windows-store-native-messaging-alias.mjs'),
        '--prepared',
        prepared,
        '--expected-package-version',
        VERSION,
        '--report',
        report,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 }
    )
  }

  it('rejects a report inside prepared before any platform or package checks and creates no file', async () => {
    const input = await fixture()
    const reportPath = path.join(input.prepared, 'alias-report.json')
    const result = invoke(input.prepared, reportPath)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ ok: false, code: 'invalid-arguments' })
    )
    expectSanitizedReport(report)
    await expect(lstat(reportPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(input.prepared)).toEqual(['keep.txt'])
  })

  it('refuses an existing external report and preserves its bytes', async () => {
    const input = await fixture()
    const reportPath = path.join(input.root, 'existing-report.json')
    const original = Buffer.from('{"sentinel":"do not overwrite"}\n')
    await writeFile(reportPath, original)
    const result = invoke(input.prepared, reportPath)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ ok: false, code: 'report-already-exists' })
    )
    expectSanitizedReport(report)
    expect(await readFile(reportPath)).toEqual(original)
    expect(await readdir(input.prepared)).toEqual(['keep.txt'])
  })
})
