// @vitest-environment node
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
