// @vitest-environment node
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runProfileIsolationCases,
  validateProfileHostReply,
} from '../../scripts/test-windows-store-native-host-profile.mjs'
import { runBoundedProbeProcess } from '../../scripts/test-windows-store-native-messaging-alias.mjs'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
async function temp() {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), 'motrix-profile-unit-')
  )
  roots.push(root)
  return root
}
function framed(value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return {
    exitCode: 0,
    stdout: Buffer.concat([header, body]),
    stderr: Buffer.alloc(0),
  }
}
const negative = { error: 'motrix-not-running' }

async function syntheticHost(options: {
  executable: string
  profileEnvironment: Record<string, string | null>
}) {
  if (options.executable !== process.execPath) return framed(negative)
  const file = path.join(
    options.profileEnvironment.MOTRIX_BRIDGE_DATA_DIR as string,
    'endpoint.json'
  )
  const { port } = JSON.parse(await readFile(file, 'utf8'))
  const discovery = await fetch(`http://127.0.0.1:${port}/discovery`)
  expect(await discovery.json()).toMatchObject({
    app: 'motrix-bridge',
    apiVersion: 1,
  })
  const response = await fetch(`http://127.0.0.1:${port}/nonce`, {
    method: 'POST',
    headers: { 'X-Motrix-Bridge': '1' },
  })
  const { nonce } = await response.json()
  return framed({ action: 'requestPair', protocolVersion: 1, port, nonce })
}

describe('native host profile isolation evidence', () => {
  it('requires live positive controls before and after alias rejection, and removes its fixture', async () => {
    const root = await temp()
    const run = vi.fn(syntheticHost)
    const report = await runProfileIsolationCases(
      {
        directExecutable: process.execPath,
        aliasExecutable: '/synthetic-alias',
        temporaryParent: root,
      },
      run
    )
    expect(report).toMatchObject({
      ok: true,
      cleanupVerified: true,
      overrideConnectionRejected: true,
      profileParityVerified: false,
      mbp1Verified: false,
      mainApplicationLaunched: false,
    })
    expect(
      report.checks.map(
        (check: { fixtureRequests: number }) => check.fixtureRequests
      )
    ).toEqual([2, 0, 0, 2])
    expect(
      run.mock.calls.every(
        ([args]) =>
          JSON.parse(args.input.subarray(4).toString())?.allowLaunch === false
      )
    ).toBe(true)
    expect(await readdir(root)).toEqual([])
    expect(JSON.stringify(report)).not.toContain(root)
    expect(JSON.stringify(report)).not.toMatch(
      /nonce|endpoint\.json|127\.0\.0\.1/
    )
  })
  it('does not treat an always-failing host as proof of profile isolation', async () => {
    const root = await temp()
    const run = vi.fn(async () => framed(negative))
    const report = await runProfileIsolationCases(
      {
        directExecutable: process.execPath,
        aliasExecutable: '/synthetic-alias',
        temporaryParent: root,
      },
      run
    )
    expect(report.ok).toBe(false)
    expect(report.checks).toMatchObject([
      { name: 'direct-control-before', ok: false },
    ])
    expect(run).toHaveBeenCalledOnce()
    expect(report.cleanupVerified).toBe(true)
    expect(await readdir(root)).toEqual([])
  })
  it.each(['reply', 'traffic'] as const)(
    'rejects a packaged host that consumes the override (%s)',
    async (mode) => {
      const root = await temp()
      const report = await runProfileIsolationCases(
        {
          directExecutable: process.execPath,
          aliasExecutable: '/synthetic-alias',
          temporaryParent: root,
        },
        async (options) => {
          if (options.executable === process.execPath)
            return syntheticHost(options)
          const reply = await syntheticHost({
            ...options,
            executable: process.execPath,
          })
          return mode === 'reply' ? reply : framed(negative)
        }
      )
      expect(report.ok).toBe(false)
      expect(report.overrideConnectionRejected).toBe(false)
      expect(report.checks.at(-1)).toMatchObject({
        name: 'alias-rejects-override',
        ok: false,
      })
      expect(report.cleanupVerified).toBe(true)
      expect(await readdir(root)).toEqual([])
    }
  )
  it.each(['exit', 'stderr', 'trailing', 'oversize', 'json', 'fields'])(
    'rejects unexpected %s output',
    (mode) => {
      const result = framed(negative)
      if (mode === 'exit') result.exitCode = 1
      if (mode === 'stderr') result.stderr = Buffer.from('private sentinel')
      if (mode === 'trailing')
        result.stdout = Buffer.concat([result.stdout, result.stdout])
      if (mode === 'oversize') result.stdout = Buffer.alloc(4101)
      if (mode === 'json') result.stdout[4] = 0xff
      if (mode === 'fields')
        result.stdout = framed({ ...negative, nonce: 'must-not-escape' }).stdout
      expect(() => validateProfileHostReply(result, negative)).toThrow()
    }
  )
})

describe('bounded process profile environment', () => {
  it('replaces inherited case variants and clears profile overrides per child', async () => {
    const root = await temp()
    vi.stubEnv('MOTRIX_USER_DATA', '/private-sentinel')
    vi.stubEnv('motrix_bridge_data_dir', '/private-sentinel')
    const args = [
      '-e',
      'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^MOTRIX_(USER_DATA|BRIDGE_DATA_DIR)$/i.test(k)))))',
    ]
    const result = await runBoundedProbeProcess({
      executable: process.execPath,
      args,
      profileEnvironment: {
        MOTRIX_USER_DATA: null,
        MOTRIX_BRIDGE_DATA_DIR: root,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      MOTRIX_BRIDGE_DATA_DIR: root,
    })
    expect(process.env.MOTRIX_USER_DATA).toBe('/private-sentinel')
  })
  it.each([
    {},
    { MOTRIX_USER_DATA: null, MOTRIX_BRIDGE_DATA_DIR: 'relative' },
    { MOTRIX_USER_DATA: null, MOTRIX_BRIDGE_DATA_DIR: null, PATH: '/other' },
    { MOTRIX_USER_DATA: null, MOTRIX_BRIDGE_DATA_DIR: '/bad\0path' },
  ])(
    'rejects invalid environment input before starting a process',
    async (profileEnvironment) => {
      await expect(
        runBoundedProbeProcess({
          executable: process.execPath,
          profileEnvironment,
        })
      ).rejects.toThrow('invalid-process-options')
    }
  )
})
