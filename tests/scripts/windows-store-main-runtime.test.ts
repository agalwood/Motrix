// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isMainRendererUrl,
  validateColdMainProcess,
  validateMainHostReply,
  validateMainProcess,
} from '../../scripts/test-windows-store-main-runtime.mjs'

const installed = {
  installLocation:
    'C:\\Program Files\\WindowsApps\\Motrix.Store.Test_1.0.1.0_x64__abcde12345678',
  packageFullName: 'Motrix.Store.Test_1.0.1.0_x64__abcde12345678',
  packageFamilyName: 'Motrix.Store.Test_abcde12345678',
}
const startTicks = '638000000000000000'
function processState() {
  return {
    pid: 4321,
    executable: `${installed.installLocation}\\app\\Motrix.exe`,
    startTicks,
    sessionId: 1,
    sameSession: true,
    packageFullName: installed.packageFullName,
    applicationUserModelId: `${installed.packageFamilyName}!Motrix`,
    listeners: [{ pid: 4321, address: '127.0.0.1' }],
  }
}
function framed(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return {
    exitCode: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.concat([header, body]),
  }
}
const pair = {
  action: 'requestPair',
  protocolVersion: 1,
  port: 49152,
  nonce: `${'a'.repeat(21)}A`,
}

describe('installed main process ownership', () => {
  const options = { pid: 4321, installed, startTicks }
  it('requires exact package, application, executable, process generation and loopback ownership', () => {
    expect(validateMainProcess(processState(), options)).toBe(startTicks)
  })
  it.each([
    { pid: 4322 },
    { startTicks: '638000000000000001' },
    { sameSession: false },
    { sessionId: null },
    { executable: 'C:\\Other\\Motrix.exe' },
    { packageFullName: 'Motrix.Other_1.0.1.0_x64__abcde12345678' },
    {
      applicationUserModelId: `${installed.packageFamilyName}!MotrixNativeHost`,
    },
    { listeners: [] },
    { listeners: [{ pid: 4322, address: '127.0.0.1' }] },
    { listeners: [{ pid: 4321, address: '0.0.0.0' }] },
    { listeners: [{ pid: 4321, address: '::' }] },
  ])('rejects mismatched process or listener evidence: %j', (change) => {
    expect(() =>
      validateMainProcess({ ...processState(), ...change }, options)
    ).toThrow()
  })
  it('allows startup polling without a listener but still rejects a foreign listener', () => {
    expect(
      validateMainProcess(
        { ...processState(), listeners: [] },
        { ...options, requireListener: false }
      )
    ).toBe(startTicks)
    expect(() =>
      validateMainProcess(
        { ...processState(), listeners: [{ pid: 99, address: '127.0.0.1' }] },
        { ...options, requireListener: false }
      )
    ).toThrow()
  })
})

describe('actual host response and redaction', () => {
  it('returns only port and count, never the nonce', () => {
    const result = framed(pair)
    expect(validateMainHostReply(result)).toEqual({
      port: pair.port,
      stdoutBytes: result.stdout.length,
    })
    expect(JSON.stringify(validateMainHostReply(result))).not.toContain(
      pair.nonce
    )
  })
  it('recognizes only the exact pending-startup response', () => {
    expect(
      validateMainHostReply(framed({ error: 'motrix-not-running' }))
    ).toBeNull()
    expect(() =>
      validateMainHostReply(
        framed({ error: 'motrix-not-running', port: 49152 })
      )
    ).toThrow()
  })
  it.each([
    { nonce: 'a'.repeat(32) },
    { nonce: 'a'.repeat(22) },
    { nonce: '' },
    { port: 0 },
    { port: 65536 },
    { port: '49152' },
    { protocolVersion: 2 },
    { nmTicket: 'must-not-be-logged' },
    { localToken: 'must-not-be-logged' },
  ])('rejects malformed or unexpected replies: %j', (change) => {
    expect(() =>
      validateMainHostReply(framed({ ...pair, ...change }))
    ).toThrow()
  })
  it('rejects extra frames, stderr and unsuccessful exits', () => {
    const result = framed(pair)
    for (const change of [
      { stdout: Buffer.concat([result.stdout, result.stdout]) },
      { stderr: Buffer.from('private-path') },
      { exitCode: 1 },
    ])
      expect(() => validateMainHostReply({ ...result, ...change })).toThrow()
  })
})

describe('renderer ownership before UI interaction', () => {
  const renderer = `file:///${installed.installLocation.replaceAll('\\', '/')}/app/resources/app.asar/dist/renderer/index.html`
  it('accepts the installed packaged renderer and expected route', () => {
    expect(
      isMainRendererUrl(
        `${renderer}?w=onboarding`,
        installed.installLocation,
        'onboarding'
      )
    ).toBe(true)
  })
  it.each([
    'https://example.test/?w=onboarding',
    'file:///C:/Other/index.html?w=onboarding',
    `${renderer}?w=main`,
    `${renderer}?w=onboarding#other`,
    `${renderer.replace('file:///', 'file://server/')}?w=onboarding`,
    `${renderer}/other?w=onboarding`,
  ])('refuses an unrelated renderer: %s', (url) => {
    expect(
      isMainRendererUrl(url, installed.installLocation, 'onboarding')
    ).toBe(false)
  })
})

describe('cold activation process ownership', () => {
  it('requires a process created after this test requested activation', () => {
    expect(() =>
      validateColdMainProcess(processState(), installed, startTicks)
    ).not.toThrow()
    expect(() =>
      validateColdMainProcess(processState(), installed, '638000000000000001')
    ).toThrow()
    expect(() =>
      validateColdMainProcess(processState(), installed, 'invalid')
    ).toThrow()
  })
  it('rejects a foreign application even if its creation time is new', () => {
    expect(() =>
      validateColdMainProcess(
        { ...processState(), applicationUserModelId: 'Other!Motrix' },
        installed,
        startTicks
      )
    ).toThrow()
    expect(() =>
      validateColdMainProcess(
        { ...processState(), pid: undefined },
        installed,
        startTicks
      )
    ).toThrow()
  })
})

describe('fatal installed-runtime evidence', () => {
  const moduleUrl = pathToFileURL(
    path.resolve('scripts/test-windows-store-main-runtime.mjs')
  ).href

  function exercise(ending: string) {
    const directory = mkdtempSync(path.join(tmpdir(), 'motrix-runtime-fatal-'))
    const file = path.join(directory, 'report.json')
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { openSync, closeSync, writeFileSync } from 'node:fs';
        import { installRuntimeFailureRecorder } from ${JSON.stringify(moduleUrl)};
        const fd = openSync(${JSON.stringify(file)}, 'wx');
        let stage = 'load-mbp1-test-client';
        const finish = installRuntimeFailureRecorder(fd, () => stage);
        ${ending}
      `,
        ],
        { encoding: 'utf8', timeout: 10000 }
      )
      return {
        status: result.status,
        report: JSON.parse(readFileSync(file, 'utf8')),
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it('preserves a nonzero uncaught rejection and reports only fixed error classifications', () => {
    const { status, report } = exercise(`
      stage = 'main-runtime:installed-mbp1-pairing';
      const error = new TypeError('private-message-sentinel');
      error.code = 'private-code-sentinel';
      Promise.reject(error);
    `)
    expect(status).toBe(1)
    expect(report.failureStage).toBe('main-runtime:installed-mbp1-pairing')
    expect(report.failureCode).toBe('uncaught-runtime-error')
    expect(report.fatal).toEqual({
      name: 'TypeError',
      code: 'other',
      origin: 'unhandledRejection',
    })
    expect(JSON.stringify(report)).not.toContain('private-')
    for (const key of [
      'ok',
      'installedMbp1TransportVerified',
      'mbp1ClientCleanupVerified',
      'mbp1Verified',
      'storeReady',
    ])
      expect(report[key]).toBe(false)
  })

  it('retains an incomplete report for direct process exit', () => {
    const { status, report } = exercise('process.exit(7)')
    expect(status).toBe(7)
    expect(report.failureStage).toBe('load-mbp1-test-client')
    expect(report.failureCode).toBe('incomplete-runtime-check')
    expect(report.fatal).toBeUndefined()
    expect(report.ok).toBe(false)
  })

  it('releases the observer before normal report finalization', () => {
    const { status, report } = exercise(`
      finish();
      writeFileSync(fd, JSON.stringify({ ok: true }));
      closeSync(fd);
    `)
    expect(status).toBe(0)
    expect(report).toEqual({ ok: true })
  })
})
