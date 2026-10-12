// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verifyWindowsPackageStartup,
  type WindowsPackageStartupDeps,
} from './windows-package-startup'

const roots: string[] = []
const identity = {
  name: 'Example.Package',
  publisher: 'CN=Example',
  publisherId: '123456789abcd',
  familyName: 'Example.Package_123456789abcd',
  fullName: 'Example.Package_1.0.0.0_x64__123456789abcd',
  version: '1.0.0.0',
  architecture: 'x64',
  resourceId: '',
}
const { publisherId: _publisherId, fullName: _fullName, ...expected } = identity
const runtime = {
  schemaVersion: 1,
  profile: 'test',
  productVersion: '2.0.0-beta.47',
  sourceCommit: 'a'.repeat(40),
  expected,
}
const success = { version: 1, ok: true, packageIdentityPresent: true, identity }

async function fixture(bytes = JSON.stringify(runtime)) {
  const resourcesPath = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-identity-startup-')
  )
  roots.push(resourcesPath)
  await writeFile(
    path.join(resourcesPath, 'windows-package-identity.json'),
    bytes
  )
  return { resourcesPath, productVersion: runtime.productVersion }
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    )
  )
})

describe('Windows package startup preflight', () => {
  it('uses the fixed helper and a bounded read-only request before returning matched identity', async () => {
    const options = await fixture()
    const execute = vi.fn<NonNullable<WindowsPackageStartupDeps['execute']>>(
      () => JSON.stringify(success)
    )
    expect(verifyWindowsPackageStartup(options, { execute })).toEqual({
      ok: true,
      runtime,
      identity,
    })
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      path.join(options.resourcesPath, 'bin', 'motrix-windows-platform.exe'),
      [],
      expect.objectContaining({
        input: '{"version":1,"op":"package_identity_query"}\n',
        shell: false,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    )
  })
  it.each([
    'not json',
    'null',
    JSON.stringify({ ...runtime, profile: 'other' }),
    'x'.repeat(32769),
  ])(
    'rejects invalid resources without starting a process %#',
    async (bytes) => {
      const options = await fixture(bytes)
      const execute = vi.fn()
      expect(verifyWindowsPackageStartup(options, { execute })).toEqual({
        ok: false,
        code: 'invalid_resource',
      })
      expect(execute).not.toHaveBeenCalled()
    }
  )
  it('rejects a missing file, a symlink or invalid UTF-8 before spawning', async () => {
    const options = await fixture()
    const file = path.join(
      options.resourcesPath,
      'windows-package-identity.json'
    )
    const execute = vi.fn()
    await rm(file)
    expect(verifyWindowsPackageStartup(options, { execute }).ok).toBe(false)
    const target = path.join(options.resourcesPath, 'other.json')
    await writeFile(target, JSON.stringify(runtime))
    await symlink(target, file, 'file')
    expect(verifyWindowsPackageStartup(options, { execute }).ok).toBe(false)
    await rm(file)
    await writeFile(file, Buffer.from([0xff]))
    expect(verifyWindowsPackageStartup(options, { execute }).ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
  it('rejects a resource belonging to another product build before querying', async () => {
    const options = await fixture()
    const execute = vi.fn()
    expect(
      verifyWindowsPackageStartup(
        { ...options, productVersion: '2.0.0' },
        { execute }
      )
    ).toEqual({ ok: false, code: 'product_version_mismatch' })
    expect(execute).not.toHaveBeenCalled()
  })
  it.each([
    'not JSON',
    JSON.stringify({ ...success, packageIdentityPresent: false }),
    JSON.stringify({ ...success, extra: true }),
    `${JSON.stringify(success)}\n${JSON.stringify(success)}`,
    'x'.repeat(65537),
  ])('rejects invalid helper responses %#', async (stdout) => {
    expect(
      verifyWindowsPackageStartup(await fixture(), { execute: () => stdout })
    ).toEqual({ ok: false, code: 'invalid_response' })
  })
  it('never accepts successful-looking output from a failed child', async () => {
    expect(
      verifyWindowsPackageStartup(await fixture(), {
        execute: () => {
          throw Object.assign(new Error('failed'), {
            stdout: JSON.stringify(success),
            status: 1,
          })
        },
      })
    ).toEqual({ ok: false, code: 'identity_query_failed' })
  })
  it('rejects a different installed publisher', async () => {
    expect(
      verifyWindowsPackageStartup(await fixture(), {
        execute: () =>
          JSON.stringify({
            ...success,
            identity: { ...identity, publisher: 'CN=Other' },
          }),
      })
    ).toEqual({ ok: false, code: 'identity_mismatch' })
  })

  it('allows only the reserved revision to vary for a stable Store build', async () => {
    const options = await fixture(
      JSON.stringify({ ...runtime, profile: 'store', productVersion: '2.0.0' })
    )
    for (const revision of [0, 1, 65535]) {
      const version = `1.0.0.${revision}`
      const observed = {
        ...identity,
        version,
        fullName: `Example.Package_${version}_x64__123456789abcd`,
      }
      expect(
        verifyWindowsPackageStartup(
          { ...options, productVersion: '2.0.0' },
          { execute: () => JSON.stringify({ ...success, identity: observed }) }
        ).ok
      ).toBe(true)
    }
    const observed = {
      ...identity,
      version: '1.0.1.1',
      fullName: 'Example.Package_1.0.1.1_x64__123456789abcd',
    }
    expect(
      verifyWindowsPackageStartup(
        { ...options, productVersion: '2.0.0' },
        { execute: () => JSON.stringify({ ...success, identity: observed }) }
      ).ok
    ).toBe(false)
  })

  it('keeps exact revision matching for sideloaded test inputs', async () => {
    const observed = {
      ...identity,
      version: '1.0.0.1',
      fullName: 'Example.Package_1.0.0.1_x64__123456789abcd',
    }
    expect(
      verifyWindowsPackageStartup(await fixture(), {
        execute: () => JSON.stringify({ ...success, identity: observed }),
      })
    ).toEqual({ ok: false, code: 'identity_mismatch' })
  })
  it('exercises EOF and complete responses using an actual child process', async () => {
    const options = await fixture()
    const execute: NonNullable<WindowsPackageStartupDeps['execute']> = (
      _file,
      _args,
      settings
    ) =>
      execFileSync(
        process.execPath,
        [
          '-e',
          `let input=''; process.stdin.on('data', x=>input+=x); process.stdin.on('end',()=>{ if(JSON.parse(input).op!=='package_identity_query')process.exit(1);process.stdout.write(${JSON.stringify(JSON.stringify(success))}); });`,
        ],
        settings
      )
    expect(verifyWindowsPackageStartup(options, { execute }).ok).toBe(true)
  })
  it('runs before profile creation and database opening in the main entrypoint', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'src/main/index.ts'),
      'utf8'
    )
    const gate = source.indexOf('const identity = verifyWindowsPackageStartup(')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(
      source.indexOf('const platform = createElectronPlatformServices(')
    )
    expect(gate).toBeLessThan(
      source.indexOf('const motrixDb = new MotrixDatabase(')
    )
  })
})
