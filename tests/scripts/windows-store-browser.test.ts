// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runBoundedProbeProcess,
  validateInstalledProbeState,
} from '../../scripts/test-windows-store-native-messaging-alias.mjs'
import {
  browserTerminationOptions,
  buildBrowserRegistrationArguments,
  createBrowserOutputDirectory,
  runBrowserNativeMessagingChecks,
  safeBrowserProbeObservation,
  validateBrowserInventory,
  validateBrowserProbeResult,
  validateFirefoxRelayBuild,
} from '../../scripts/test-windows-store-native-messaging-browser.mjs'
import { renderWindowsStoreManifest } from '../../scripts/windows-store-manifest.mjs'
import { WINDOWS_STORE_TEST_IDENTITY } from '../../scripts/windows-store-metadata.mjs'
import { WINDOWS_STORE_PAYLOAD_METADATA } from '../helpers/windows-store-payload-fixture'

const VERSION = '4.5.6.0'
const FAMILY = 'Motrix.Store.Test_abcde12345678'
const FULL_NAME = `Motrix.Store.Test_${VERSION}_x64__abcde12345678`
const PRIVATE_PATH = 'C:\\Users\\private-sentinel\\hidden'
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FF_ID = 'motrix-store-p0@motrix.invalid'
const HASH = 'a'.repeat(64)
const metadata = {
  ...WINDOWS_STORE_PAYLOAD_METADATA,
  identity: WINDOWS_STORE_TEST_IDENTITY,
  profile: 'test',
  testDiagnostics: 'native-messaging-probe-v1',
}
const sha = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const probe = Buffer.from('fixture-executable-not-actual-Windows-evidence')
const diagnostic = {
  executable: {
    path: 'diagnostics/motrix-store-p0-probe.exe',
    bytes: probe.length,
    sha256: sha(probe),
  },
}
const manifestBytes = Buffer.from(renderWindowsStoreManifest(metadata))
const roots: string[] = []
async function temp() {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), 'motrix-browser-unit-')
  )
  roots.push(root)
  return root
}
afterEach(async () => {
  vi.doUnmock('playwright')
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
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
    localApplicationData: PRIVATE_PATH,
    context: {
      osVersion: '10.0.26100.0',
      installationType: 'Server',
      elevated: true,
    },
  }
}
function installed() {
  return validateInstalledProbeState({
    state: state(),
    metadata,
    expectedPackageVersion: VERSION,
  })
}
function reply(browser = 'chrome') {
  return {
    schemaVersion: 1,
    probe: 'motrix-store-p0',
    packageIdentityPresent: true,
    packageFullNameSha256: sha(FULL_NAME),
    expectedPackageName: true,
    packageVersion: VERSION,
    applicationIdentityPresent: true,
    applicationUserModelIdSha256: sha(`${FAMILY}!MotrixNativeHostP0`),
    expectedHelperApplication: true,
    chromiumCallerShape: browser !== 'firefox',
    firefoxTestCallerShape: browser === 'firefox',
  }
}
function observed(browser = 'chrome', registered = true) {
  return {
    schemaVersion: 1,
    status: registered ? 'reply' : 'disconnected',
    messageCount: registered ? 1 : 0,
    errorPresent: true,
    errorKind: 'other',
    reply: registered ? reply(browser) : null,
  }
}
function inventory(browser = 'chrome') {
  const brands: Record<string, [string, string]> = {
    chrome: ['Google Chrome', 'Google LLC'],
    edge: ['Microsoft Edge', 'Microsoft Corporation'],
    firefox: ['Firefox', 'Mozilla Corporation'],
  }
  return {
    product: brands[browser][0],
    signer: brands[browser][1],
    fileVersion: '153.0.1.2',
    signatureStatus: 'Valid',
    executable: `${PRIVATE_PATH}\\${browser}.exe`,
    executableSha256: HASH,
  }
}
function validate(result: unknown, browser = 'chrome', registered = true) {
  return validateBrowserProbeResult({
    result,
    browser,
    registered,
    installedState: installed(),
    expectedPackageVersion: VERSION,
  })
}

describe('browser observations are parsed messages, never raw stdio evidence', () => {
  it.each(['chrome', 'edge', 'firefox'])(
    'accepts strict OS-bound %s reply even when EOF reports an error',
    (browser) => {
      expect(validate(observed(browser), browser)).toEqual({
        status: 'reply',
        messageCount: 1,
        errorPresent: true,
        errorKind: 'other',
      })
      expect(
        validate(
          { ...observed(browser), errorPresent: false, errorKind: 'none' },
          browser
        ).messageCount
      ).toBe(1)
    }
  )
  it('requires actual zero-message disconnect for negative cases', () => {
    expect(
      validate(observed('chrome', false), 'chrome', false).messageCount
    ).toBe(0)
    for (const result of [
      observed(),
      { ...observed('chrome', false), errorPresent: false },
      { ...observed('chrome', false), status: 'timeout' },
      { ...observed('chrome', false), status: 'connect-failed' },
    ]) {
      expect(() => validate(result, 'chrome', false)).toThrow()
    }
  })
  it.each([
    [
      'missing',
      (value: Record<string, unknown>) => {
        delete value.packageFullNameSha256
      },
    ],
    [
      'extra',
      (value: Record<string, unknown>) => {
        value.path = PRIVATE_PATH
      },
    ],
    [
      'foreign-package',
      (value: Record<string, unknown>) => {
        value.packageFullNameSha256 = sha('foreign')
      },
    ],
    [
      'foreign-helper',
      (value: Record<string, unknown>) => {
        value.applicationUserModelIdSha256 = sha(`${FAMILY}!Motrix`)
      },
    ],
    [
      'wrong-version',
      (value: Record<string, unknown>) => {
        value.packageVersion = '4.5.7.0'
      },
    ],
    [
      'false-identity',
      (value: Record<string, unknown>) => {
        value.expectedHelperApplication = false
      },
    ],
    [
      'wrong-caller',
      (value: Record<string, unknown>) => {
        value.firefoxTestCallerShape = true
      },
    ],
  ])('rejects %s response', (_, mutate) => {
    const value = observed()
    mutate(value.reply as Record<string, unknown>)
    expect(() => validate(value)).toThrow('invalid-browser-reply')
  })
  it.each([2, -1, 0.5, '1'])(
    'rejects invalid message count %s',
    (messageCount) => {
      expect(() => validate({ ...observed(), messageCount })).toThrow()
    }
  )
  it('rejects unknown envelope fields and unobserved framing assertions', () => {
    expect(() =>
      validate({ ...observed(), exitCode: 0, frameCount: 1 })
    ).toThrow('invalid-browser-result')
  })
  it.each([
    { errorPresent: false, errorKind: 'other' },
    { errorPresent: true, errorKind: 'none' },
    { errorPresent: true, errorKind: PRIVATE_PATH },
  ])('rejects inconsistent or arbitrary error classification: %j', (error) => {
    expect(() => validate({ ...observed(), ...error })).toThrow(
      'invalid-browser-result'
    )
  })
  it('retains only bounded failure observations, without reading getters', () => {
    const getter = vi.fn(() => PRIVATE_PATH)
    const value = Object.defineProperty(
      {
        status: PRIVATE_PATH,
        messageCount: 999,
        errorKind: PRIVATE_PATH,
        reply: { token: PRIVATE_PATH },
      },
      'errorPresent',
      { get: getter }
    )
    expect(safeBrowserProbeObservation(value)).toEqual({
      status: null,
      messageCount: null,
      errorPresent: null,
      errorKind: null,
    })
    expect(getter).not.toHaveBeenCalled()
    expect(safeBrowserProbeObservation(null)).toEqual({
      status: null,
      messageCount: null,
      errorPresent: null,
      errorKind: null,
    })
  })
})

describe('branded browser inventory', () => {
  it.each(['chrome', 'edge', 'firefox'])(
    'accepts official %s without exposing its private executable path',
    (browser) => {
      const result = validateBrowserInventory({
        browser,
        inventory: inventory(browser),
        runtimeVersion: '153.0.4.5',
      })
      expect(result).not.toHaveProperty('executable')
      expect(result.version).toBe('153.0.4.5')
    }
  )
  it.each([
    { product: 'Chromium' },
    { signer: 'untrusted' },
    { signatureStatus: 'NotSigned' },
    { executable: 'chrome.exe' },
    { fileVersion: 153.5 },
    { executableSha256: PRIVATE_PATH },
  ])('rejects substituted or invalid binary %j', (override) => {
    expect(() =>
      validateBrowserInventory({
        browser: 'chrome',
        inventory: { ...inventory(), ...override },
      })
    ).toThrow('browser-brand-mismatch')
  })
  it('rejects a different runtime major version', () => {
    expect(() =>
      validateBrowserInventory({
        browser: 'edge',
        inventory: inventory('edge'),
        runtimeVersion: '154.0',
      })
    ).toThrow('browser-brand-mismatch')
  })
})

async function fixtureHarness(browser: 'chromium' | 'firefox') {
  let clicked: () => void = () => {}
  let timeout: () => void = () => {}
  let onMessage: (value: unknown) => void = () => {}
  let onDisconnect: () => void = () => {}
  const element = { textContent: 'null' }
  const button = {
    disabled: false,
    addEventListener: (_: string, listener: () => void) => {
      clicked = listener
    },
  }
  const port = {
    disconnect: vi.fn(),
    postMessage: vi.fn(),
    error: undefined as unknown,
    onMessage: {
      addListener: (listener: typeof onMessage) => {
        onMessage = listener
      },
    },
    onDisconnect: {
      addListener: (listener: typeof onDisconnect) => {
        onDisconnect = listener
      },
    },
  }
  const runtime = {
    id: browser === 'firefox' ? FF_ID : ID,
    lastError: undefined as unknown,
    connectNative: vi.fn(() => port),
  }
  const source = await readFile(
    path.join(
      'tests/fixtures/windows-store-native-messaging/browser',
      browser,
      'probe.js'
    ),
    'utf8'
  )
  runInNewContext(source, {
    chrome: { runtime },
    ...(browser === 'firefox' ? { browser: { runtime } } : {}),
    document: {
      getElementById: (id: string) => (id === 'probe' ? button : element),
    },
    setTimeout: (callback: () => void) => {
      timeout = callback
      return 1
    },
    clearTimeout: vi.fn(),
  })
  return {
    runtime,
    port,
    button,
    click: () => clicked(),
    message: (value: unknown) => onMessage(value),
    disconnect: () => onDisconnect(),
    timeout: () => timeout(),
    result: () => JSON.parse(element.textContent),
  }
}

describe('actual fixture JavaScript in a mock extension runtime', () => {
  it.each(['chromium', 'firefox'] as const)(
    '%s sends only the challenge and waits for disconnect after one reply',
    async (browser) => {
      const fixture = await fixtureHarness(browser)
      fixture.click()
      expect(fixture.runtime.connectNative).toHaveBeenCalledExactlyOnceWith(
        'app.motrix.bridge.store.p0'
      )
      expect(fixture.port.postMessage).toHaveBeenCalledExactlyOnceWith({
        probe: 'motrix-store-p0',
      })
      fixture.message(reply(browser === 'firefox' ? 'firefox' : 'chrome'))
      expect(fixture.result()).toBeNull()
      fixture.runtime.lastError = { message: PRIVATE_PATH }
      fixture.disconnect()
      expect(fixture.result()).toMatchObject({
        status: 'reply',
        messageCount: 1,
        errorPresent: true,
      })
      expect(JSON.stringify(fixture.result())).not.toContain(PRIVATE_PATH)
      expect(fixture.button.disabled).toBe(false)
    }
  )
  it('records a clean negative, multiple messages, missing fields and a held-open timeout', async () => {
    const negative = await fixtureHarness('chromium')
    negative.click()
    negative.runtime.lastError = { message: 'missing' }
    negative.disconnect()
    expect(negative.result()).toEqual(observed('chrome', false))
    const multiple = await fixtureHarness('chromium')
    multiple.click()
    multiple.message(reply())
    multiple.message(reply())
    expect(multiple.result()).toMatchObject({
      status: 'multiple-messages',
      messageCount: 2,
    })
    const invalid = await fixtureHarness('chromium')
    invalid.click()
    invalid.message({ ...reply(), privatePath: PRIVATE_PATH })
    expect(invalid.result()).toMatchObject({
      status: 'invalid-reply',
      reply: null,
    })
    const timeout = await fixtureHarness('chromium')
    timeout.click()
    timeout.message(reply())
    timeout.timeout()
    expect(timeout.result().status).toBe('timeout')
  })
  it.each([
    [
      `File at path "${PRIVATE_PATH}" does not exist, or is not executable`,
      'native-host-not-executable',
    ],
    [
      `File at path "${PRIVATE_PATH}" does not exist, or is not a normal file`,
      'native-host-not-executable',
    ],
    [
      'No such native application app.motrix.bridge.store.p0',
      'native-host-not-found',
    ],
    [`unknown ${PRIVATE_PATH}`, 'other'],
    [
      `File at path "${PRIVATE_PATH}\n" does not exist, or is not executable`,
      'other',
    ],
  ])(
    'Firefox reduces native launch error to a safe enum: %s',
    async (message, errorKind) => {
      const fixture = await fixtureHarness('firefox')
      fixture.click()
      fixture.port.error = { message }
      fixture.disconnect()
      expect(fixture.result()).toEqual({
        schemaVersion: 1,
        status: 'disconnected',
        messageCount: 0,
        errorPresent: true,
        errorKind,
        reply: null,
      })
      expect(JSON.stringify(fixture.result())).not.toContain(PRIVATE_PATH)
    }
  )
  it('Firefox clean EOF keeps its strict reply and records no error', async () => {
    const fixture = await fixtureHarness('firefox')
    fixture.click()
    fixture.message(reply('firefox'))
    fixture.disconnect()
    expect(fixture.result()).toMatchObject({
      status: 'reply',
      messageCount: 1,
      errorPresent: false,
      errorKind: 'none',
    })
    expect(validate(fixture.result(), 'firefox').status).toBe('reply')
  })
  it('classifies synchronous connect errors without serializing them', async () => {
    const fixture = await fixtureHarness('firefox')
    fixture.runtime.connectNative.mockImplementation(() => {
      throw new Error(PRIVATE_PATH)
    })
    fixture.click()
    expect(fixture.result()).toMatchObject({
      status: 'connect-failed',
      messageCount: 0,
      errorPresent: true,
      errorKind: 'other',
    })
    expect(JSON.stringify(fixture.result())).not.toContain(PRIVATE_PATH)
  })
})

async function harness() {
  const outputDirectory = await temp()
  const registered = new Set<string>()
  const closed: string[] = []
  const queries = vi.fn(async () => state())
  const input = {
    metadata,
    diagnostic,
    manifestBytes,
    expectedPackageVersion: VERSION,
    outputDirectory,
  }
  const registration = vi.fn(async (args: Record<string, string>) => {
    if (args.action === 'Register') registered.add(args.browser)
    if (args.action === 'Remove') registered.delete(args.browser)
    return {
      exitCode: 0,
      stderrBytes: 0,
      report: {
        schemaVersion: 1,
        ok: true,
        action: args.action,
        browser: args.browser,
        hostName: 'app.motrix.bridge.store.p0',
        registered: registered.has(args.browser),
        cleanupVerified: args.action === 'Remove',
        registryView: 'Registry32',
        registryPathRole: args.browser,
        hostLaunchMode: args.relayPath
          ? 'firefox-alias-relay'
          : 'execution-alias',
        ...(args.relaySha256 ? { relaySha256: args.relaySha256 } : {}),
        receiptSha256: sha(args.browser),
        manifestSha256: HASH,
      },
    }
  })
  const deps = {
    queryInstalledState: queries,
    readInstalledFile: vi.fn(async (name: string) =>
      name.endsWith('AppxManifest.xml') ? manifestBytes : probe
    ),
    browserInventory: vi.fn(async (browser: string) => inventory(browser)),
    fixture: vi.fn(async () => ({
      directory: '/unused-fixture',
      sha256: HASH,
    })),
    registration,
    openBrowser: vi.fn(async ({ browser }: { browser: string }) => ({
      version: '153.0.4.5',
      extensionId: browser === 'firefox' ? FF_ID : ID,
      runCase: vi.fn(async () => observed(browser, registered.has(browser))),
      close: vi.fn(async () => {
        closed.push(browser)
      }),
    })),
  }
  return { input, deps, registered, closed }
}

function relayEvidence() {
  return {
    executablePath: `${PRIVATE_PATH}\\motrix-store-p0-firefox-relay.exe`,
    sourceSha256: HASH,
    executableSha256: 'b'.repeat(64),
    bytes: 512,
    buildReportSha256: 'c'.repeat(64),
  }
}

describe('explicit Firefox relay experiment', () => {
  it('uses a pinned ordinary relay only for Firefox and retains identity checks and cleanup', async () => {
    const lab = await harness()
    const loadFirefoxRelayBuild = vi.fn(async () => relayEvidence())
    const report = await runBrowserNativeMessagingChecks(
      { ...lab.input, firefoxRelayBuildDirectory: PRIVATE_PATH },
      { ...lab.deps, loadFirefoxRelayBuild }
    )
    expect(report.ok).toBe(true)
    expect(
      report.browsers.map(
        (browser: { hostLaunchMode: string }) => browser.hostLaunchMode
      )
    ).toEqual(['execution-alias', 'execution-alias', 'firefox-alias-relay'])
    expect(report.firefoxRelay.executableSha256).toBe(
      relayEvidence().executableSha256
    )
    expect(loadFirefoxRelayBuild.mock.calls.length).toBeGreaterThan(9)
    for (const [input] of lab.deps.registration.mock.calls) {
      expect(input.relayPath).toBe(
        input.browser === 'firefox' ? relayEvidence().executablePath : undefined
      )
    }
    expect(JSON.stringify(report)).not.toContain(PRIVATE_PATH)
    expect(report.browserUpgradeVerified).toBe(false)
    expect(report.mbp1Verified).toBe(false)
  })
  it('stops when relay content changes without promoting passing cases', async () => {
    const lab = await harness()
    const loadFirefoxRelayBuild = vi
      .fn()
      .mockResolvedValueOnce(relayEvidence())
      .mockResolvedValue({
        ...relayEvidence(),
        executableSha256: 'd'.repeat(64),
      })
    const report = await runBrowserNativeMessagingChecks(
      { ...lab.input, firefoxRelayBuildDirectory: PRIVATE_PATH },
      { ...lab.deps, loadFirefoxRelayBuild }
    )
    expect(report.ok).toBe(false)
    expect(report.checks.at(-1).code).toBe('relay-content-changed')
    expect(lab.deps.registration).not.toHaveBeenCalled()
  })
  it('rejects a registration report that substitutes the relay route', async () => {
    const lab = await harness()
    const real = lab.deps.registration.getMockImplementation()
    lab.deps.registration.mockImplementation(async (input) => {
      const result = await real?.(input)
      if (!result) throw new Error('missing fixture')
      if (input.browser === 'firefox')
        result.report.hostLaunchMode = 'execution-alias'
      return result
    })
    const report = await runBrowserNativeMessagingChecks(
      { ...lab.input, firefoxRelayBuildDirectory: PRIVATE_PATH },
      { ...lab.deps, loadFirefoxRelayBuild: async () => relayEvidence() }
    )
    expect(report.ok).toBe(false)
    expect(report.browsers[2].checks.at(-1).code).toBe('registration-failed')
  })
})

function relayBuildFixture() {
  const executableBytes = Buffer.alloc(512)
  executableBytes.write('MZ')
  executableBytes.writeUInt32LE(128, 0x3c)
  executableBytes.writeUInt32LE(0x4550, 128)
  executableBytes.writeUInt16LE(0x8664, 132)
  executableBytes.writeUInt16LE(112, 148)
  executableBytes.writeUInt16LE(2, 150)
  executableBytes.writeUInt16LE(0x20b, 152)
  executableBytes.writeUInt16LE(3, 220)
  const sourceBytes = Buffer.from(
    'synthetic source for contract validation only'
  )
  const build = {
    schemaVersion: 1,
    scope: 'windows-native-messaging-firefox-alias-relay-build',
    ok: true,
    compiled: true,
    compiler: 'Windows .NET Framework64 csc',
    source: {
      path: 'tests/fixtures/windows-store-native-messaging/firefox-alias-relay.cs',
      sha256: sha(sourceBytes),
    },
    executable: {
      path: 'motrix-store-p0-firefox-relay.exe',
      bytes: executableBytes.length,
      sha256: sha(executableBytes),
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
  return { executableBytes, sourceBytes, build }
}

describe('relay build association', () => {
  it('checks actual PE bytes and checkout source without treating the report as signing proof', () => {
    const { build, ...bytes } = relayBuildFixture()
    expect(
      validateFirefoxRelayBuild({
        ...bytes,
        buildReportBytes: Buffer.from(JSON.stringify(build)),
      })
    ).toMatchObject({
      executableSha256: sha(bytes.executableBytes),
      sourceSha256: sha(bytes.sourceBytes),
      bytes: 512,
    })
  })
  it.each([
    'source',
    'executable',
    'pe',
    'scope',
    'claim',
    'extra',
    'malformed',
  ])('rejects %s substitution', (mode) => {
    const { build, ...bytes } = relayBuildFixture()
    if (mode === 'source') bytes.sourceBytes = Buffer.from('other')
    if (mode === 'executable') bytes.executableBytes[400] = 1
    if (mode === 'pe') bytes.executableBytes.writeUInt16LE(0x14c, 132)
    if (mode === 'scope') build.scope = 'windows-native-messaging-probe-build'
    if (mode === 'claim') build.browserNativeMessagingVerified = true
    if (mode === 'extra') Object.assign(build, { path: PRIVATE_PATH })
    expect(() =>
      validateFirefoxRelayBuild({
        ...bytes,
        buildReportBytes: Buffer.from(
          mode === 'malformed' ? '{' : JSON.stringify(build)
        ),
      })
    ).toThrow('relay-build-invalid')
  })
})

describe('isolated sequential experiment coordinator', () => {
  it('completes nine actual-browser API cases with exact receipt hashes and safe claims', async () => {
    const lab = await harness()
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report).toMatchObject({
      ok: true,
      testCount: 9,
      browserNativeMessagingVerified: true,
      cleanupVerified: true,
      sourceCommit: metadata.source.commit,
      packageVersion: VERSION,
      executableSha256: sha(probe),
      diagnosticProbeOnly: true,
      mbp1Verified: false,
      windows11AcceptanceVerified: false,
      browserUpgradeVerified: false,
      signatureVerified: false,
      packageInstallationPerformed: false,
      motrixMainRuntimeVerified: false,
    })
    expect(report.checks).toEqual([
      { name: 'installed-before', ok: true },
      { name: 'installed-after', ok: true },
    ])
    expect(
      report.browsers.map((value: { browser: string }) => value.browser)
    ).toEqual(['chrome', 'edge', 'firefox'])
    expect(lab.closed).toEqual(['chrome', 'edge', 'firefox'])
    expect(lab.registered.size).toBe(0)
    for (const browser of report.browsers) {
      expect(
        browser.checks.map((check: { name: string }) => check.name)
      ).toEqual(['unregistered-before', 'registered', 'unregistered-after'])
      expect(browser.brandedBinaryVerified).toBe(true)
      expect(browser.cleanupVerified).toBe(true)
      await expect(
        lstat(path.join(lab.input.outputDirectory, browser.browser, 'profile'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    for (const [call] of lab.deps.registration.mock.calls.filter(
      ([value]) => value.action === 'Remove'
    ))
      expect(call.receiptSha256).toBe(sha(call.browser))
    const encoded = JSON.stringify(report)
    for (const forbidden of [
      PRIVATE_PATH,
      FULL_NAME,
      FAMILY,
      'exitCode',
      'frameCount',
      'receiptSha256',
      'stdout',
    ])
      expect(encoded).not.toContain(forbidden)
  })
  it('retains no success claim when the package changes during a browser case', async () => {
    const lab = await harness()
    lab.deps.queryInstalledState
      .mockImplementationOnce(async () => state())
      .mockImplementation(async () => {
        const value = state()
        value.packages[0].version = '4.5.7.0'
        return value
      })
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.browserNativeMessagingVerified).toBe(false)
    expect(lab.deps.registration).not.toHaveBeenCalled()
    expect(lab.closed).toEqual(['chrome'])
  })
  it('closes and removes its registration after malformed native output', async () => {
    const lab = await harness()
    lab.deps.openBrowser.mockImplementation(async ({ browser }) => ({
      version: '153.0.4.5',
      extensionId: ID,
      runCase: vi.fn(async () =>
        lab.registered.has(browser)
          ? { ...observed(), reply: { ...reply(), packageVersion: '4.5.7.0' } }
          : observed(browser, false)
      ),
      close: vi.fn(async () => {
        lab.closed.push(browser)
      }),
    }))
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.browsers[0].cleanupVerified).toBe(true)
    expect(lab.registered.size).toBe(0)
    expect(lab.closed).toEqual(['chrome'])
    expect(report.browsers[0].checks.at(-1)).toMatchObject({
      ok: false,
      code: 'invalid-browser-reply',
      status: 'reply',
      messageCount: 1,
      errorPresent: true,
      errorKind: 'other',
    })
  })
  it('retains Firefox failure observations without promoting the two passing brands', async () => {
    const lab = await harness()
    const real = lab.deps.openBrowser.getMockImplementation()
    lab.deps.openBrowser.mockImplementation(async (args) => {
      const session = await real?.(args)
      if (!session) throw new Error('test fixture unavailable')
      if (args.browser === 'firefox')
        session.runCase.mockImplementation(async () => ({
          ...observed('firefox', false),
          errorKind: lab.registered.has('firefox')
            ? 'native-host-not-executable'
            : 'native-host-not-found',
        }))
      return session
    })
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.testCount).toBe(7)
    expect(report.browserNativeMessagingVerified).toBe(false)
    expect(report.cleanupVerified).toBe(true)
    expect(
      report.browsers
        .slice(0, 2)
        .every((browser: { ok: boolean }) => browser.ok)
    ).toBe(true)
    expect(report.browsers[2].checks.at(-1)).toEqual({
      name: 'registered',
      ok: false,
      code: 'invalid-browser-result',
      status: 'disconnected',
      messageCount: 0,
      errorPresent: true,
      errorKind: 'native-host-not-executable',
    })
    expect(lab.registered.size).toBe(0)
    expect(JSON.stringify(report)).not.toContain(PRIVATE_PATH)
  })
  it('honors verified in-call rollback but never turns its failed Register into success', async () => {
    const lab = await harness()
    const real = lab.deps.registration.getMockImplementation()
    lab.deps.registration.mockImplementation(async (args) =>
      args.action === 'Register'
        ? {
            exitCode: 1,
            stderrBytes: 0,
            report: {
              schemaVersion: 1,
              ok: false,
              action: 'Register',
              browser: args.browser,
              hostName: 'app.motrix.bridge.store.p0',
              cleanupVerified: true,
            },
          }
        : real?.(args)
    )
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.browsers[0].cleanupVerified).toBe(true)
    expect(report.browsers[0].cleanup).toContainEqual({
      name: 'registration-rollback',
      ok: true,
    })
    expect(
      lab.deps.registration.mock.calls.some(
        ([args]) => args.action === 'Remove'
      )
    ).toBe(false)
  })
  it('preserves a reliable receipt for exact cleanup after partial Register failure', async () => {
    const lab = await harness()
    const real = lab.deps.registration.getMockImplementation()
    lab.deps.registration.mockImplementation(async (args) => {
      const result = await real?.(args)
      return args.action === 'Register'
        ? { ...result, exitCode: 1, report: { ...result?.report, ok: false } }
        : result
    })
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.browsers[0].cleanupVerified).toBe(true)
    expect(lab.registered.size).toBe(0)
  })
  it('does not falsely clean unknown registration ownership or expose raw exceptions', async () => {
    const lab = await harness()
    const real = lab.deps.registration.getMockImplementation()
    lab.deps.registration.mockImplementation(async (args) => {
      if (args.action === 'Register')
        throw Object.assign(new Error(PRIVATE_PATH), { code: PRIVATE_PATH })
      return real?.(args)
    })
    const report = await runBrowserNativeMessagingChecks(lab.input, lab.deps)
    expect(report.ok).toBe(false)
    expect(report.browsers[0].cleanupVerified).toBe(false)
    expect(JSON.stringify(report)).not.toContain(PRIVATE_PATH)
  })
  it('fails closed on a changed installed executable and on a foreign binary before launching', async () => {
    const lab = await harness()
    lab.deps.readInstalledFile.mockResolvedValue(Buffer.from('changed'))
    expect(
      (await runBrowserNativeMessagingChecks(lab.input, lab.deps)).ok
    ).toBe(false)
    expect(lab.deps.openBrowser).not.toHaveBeenCalled()
    const other = await harness()
    other.deps.browserInventory.mockResolvedValue({
      ...inventory(),
      product: 'Chromium',
    })
    expect(
      (await runBrowserNativeMessagingChecks(other.input, other.deps)).ok
    ).toBe(false)
    expect(other.deps.openBrowser).not.toHaveBeenCalled()
  })
})

describe('Chromium adapter contract without starting a browser', () => {
  async function adapter(loaderFails = false) {
    const lab = await harness()
    const waitForFunction = vi.fn(async () => {})
    const page = {
      goto: vi.fn(async () => {}),
      evaluate: vi.fn(async () => ID),
      waitForFunction,
      locator: (selector: string) => ({
        click: vi.fn(async () => {}),
        textContent: vi.fn(async () =>
          selector === '#result'
            ? JSON.stringify(observed('chrome', lab.registered.has('chrome')))
            : ''
        ),
      }),
    }
    const cdp = {
      send: vi.fn(async (method: string) => {
        if (method === 'SystemInfo.getProcessInfo')
          return { processInfo: [{ type: 'browser', id: 123 }] }
        if (method === 'Browser.getVersion')
          return { product: 'Chrome/153.0.1.2' }
        if (loaderFails) throw new Error(PRIVATE_PATH)
        return { id: ID }
      }),
    }
    const context = {
      browser: () => ({ newBrowserCDPSession: async () => cdp }),
      newPage: async () => page,
      close: vi.fn(async () => {}),
    }
    const launchPersistentContext = vi.fn(async () => context)
    vi.doMock('playwright', () => ({ chromium: { launchPersistentContext } }))
    lab.deps.browserInventory.mockImplementation(async (browser) => {
      if (browser !== 'chrome') throw new Error('stop-before-another-adapter')
      return inventory(browser)
    })
    const { openBrowser: _unused, ...deps } = lab.deps
    return {
      lab,
      context,
      launchPersistentContext,
      waitForFunction,
      report: await runBrowserNativeMessagingChecks(lab.input, deps),
    }
  }
  it('uses a new persistent official browser and the public waitForFunction argument positions', async () => {
    const { report, launchPersistentContext, waitForFunction, context } =
      await adapter()
    expect(report.browsers[0].ok).toBe(true)
    expect(launchPersistentContext.mock.calls[0][1]).toMatchObject({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    })
    expect(waitForFunction.mock.calls).toHaveLength(3)
    expect(waitForFunction.mock.calls[0][2]).toEqual({ timeout: 14000 })
    expect(context.close).toHaveBeenCalledOnce()
  })
  it('closes its acquired context on loader failure without falling back to Chromium', async () => {
    const { report, context, launchPersistentContext } = await adapter(true)
    expect(report.ok).toBe(false)
    expect(report.browsers[0].checks).toContainEqual({
      name: 'load-extension',
      ok: false,
      code: 'browser-loader-unsupported',
    })
    expect(context.close).toHaveBeenCalledOnce()
    expect(launchPersistentContext).toHaveBeenCalledOnce()
    expect(JSON.stringify(report)).not.toContain(PRIVATE_PATH)
  })
})

describe('real bounded-process API compatibility without invoking Windows tools', () => {
  it('uses one encoded command below the shared argument cap and safely transports quoted paths', async () => {
    const args = buildBrowserRegistrationArguments({
      action: 'Register',
      browser: 'chrome',
      runDirectory: "C:\\new\\quote'$(never)",
      extensionId: ID,
      aliasPath:
        'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\motrix-store-p0-native-host.exe',
      packageVersion: VERSION,
      probeSha256: HASH,
      sourceCommit: 'a'.repeat(40),
    })
    expect(args).toHaveLength(5)
    const script = Buffer.from(args[4], 'base64').toString('utf16le')
    const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1]
    expect(
      JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8'))
        .RunDirectory
    ).toBe("C:\\new\\quote'$(never)")
    expect(script).not.toContain('$(never)')
    const result = await runBoundedProbeProcess({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(String(process.argv.length))',
        '--',
        ...args,
      ],
      maxStdoutBytes: 32768,
      maxStderrBytes: 1024,
    })
    expect(result.exitCode).toBe(0)
  })
  it('keeps taskkill options within the existing hard output limits', async () => {
    const options = browserTerminationOptions(123, 'C:\\Windows')
    expect(options.args).toEqual(['/PID', '123', '/T', '/F'])
    expect(options.maxStderrBytes).toBe(1024)
    const result = await runBoundedProbeProcess({
      ...options,
      executable: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })
    expect(result.exitCode).toBe(0)
    expect(() => browserTerminationOptions(-1, 'C:\\Windows')).toThrow()
  })
})

describe('output ownership and CLI boundary', () => {
  it('rejects prepared descendants, existing output and symlink parents', async () => {
    const root = await temp()
    const prepared = path.join(root, 'prepared')
    await mkdir(prepared)
    const options = {
      preparedDirectory: prepared,
      outputDirectory: path.join(prepared, 'browser'),
    }
    await expect(createBrowserOutputDirectory(options)).rejects.toThrow(
      'invalid-arguments'
    )
    await expect(lstat(options.outputDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(
      createBrowserOutputDirectory({ ...options, outputDirectory: root })
    ).rejects.toThrow('output-exists')
    await symlink(prepared, path.join(root, 'link'))
    await expect(
      createBrowserOutputDirectory({
        ...options,
        outputDirectory: path.join(root, 'link', 'browser'),
      })
    ).rejects.toThrow('unsafe-path')
  })
  it('CLI does not modify an existing output or create output beneath prepared', async () => {
    const root = await temp()
    const prepared = path.join(root, 'prepared')
    await mkdir(prepared)
    const existing = path.join(root, 'existing')
    await mkdir(existing)
    await writeFile(path.join(existing, 'sentinel'), 'keep')
    for (const output of [existing, path.join(prepared, 'browser')]) {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/test-windows-store-native-messaging-browser.mjs',
          '--prepared',
          prepared,
          '--expected-package-version',
          VERSION,
          '--output-directory',
          output,
        ],
        { encoding: 'utf8', timeout: 5000 }
      )
      expect(result.status).toBe(1)
      expect(JSON.parse(result.stdout).ok).toBe(false)
      await expect(
        lstat(path.join(output, 'browser-report.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await readFile(path.join(existing, 'sentinel'), 'utf8')).toBe('keep')
  })
})
