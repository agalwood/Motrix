import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  matchesEntrypoint,
  processStartTime,
  runtimeEnvironment,
} from '../../packaging/fnos/app/lifecycle.mjs'
import {
  normalizeFnosMetadataPermissions,
  verifyFnosMetadataPermissions,
} from '../../scripts/fnos-metadata-permissions.mjs'
import {
  fnosPackageVersion,
  lockedDownload,
  prepareFnosProject,
  sha256,
  verifyFnosBinary,
} from '../../scripts/prepare-fnos-project.mjs'
import { verifyFnosPackage } from '../../scripts/verify-fnos-package.mjs'

const directories: string[] = []
it('normalizes group-writable checkout metadata before privileged lifecycle checks', async () => {
  const project = await temporary()
  const cmd = path.join(project, 'cmd')
  await mkdir(cmd)
  await writeFile(path.join(cmd, 'main'), '#!/bin/bash\n')
  await writeFile(path.join(cmd, 'account-authority.mjs'), '// fixture\n')
  await chmod(cmd, 0o775)
  await chmod(path.join(cmd, 'account-authority.mjs'), 0o664)
  await expect(verifyFnosMetadataPermissions(project)).rejects.toThrow(
    'Writable'
  )
  await normalizeFnosMetadataPermissions(project)
  await verifyFnosMetadataPermissions(project)
  expect((await stat(cmd)).mode & 0o777).toBe(0o755)
  expect((await stat(path.join(cmd, 'main'))).mode & 0o777).toBe(0o755)
  expect(
    (await stat(path.join(cmd, 'account-authority.mjs'))).mode & 0o777
  ).toBe(0o644)
  await chmod(path.join(cmd, 'main'), 0o777)
  await expect(verifyFnosMetadataPermissions(project)).rejects.toThrow(
    'callback: main'
  )
})
it('rejects symbolic links in privileged metadata instead of chmodding their targets', async () => {
  const project = await temporary()
  await mkdir(path.join(project, 'cmd'))
  const target = path.join(project, 'outside')
  await writeFile(target, 'unchanged')
  await chmod(target, 0o600)
  await symlink(target, path.join(project, 'cmd/main'))
  await expect(normalizeFnosMetadataPermissions(project)).rejects.toThrow(
    'Invalid fnOS callback'
  )
  expect((await stat(target)).mode & 0o777).toBe(0o600)
})
it('gives packaging fixes an increasing version without changing the application version', () => {
  expect(fnosPackageVersion('2.2.0')).toBe('2.2.0')
  expect(fnosPackageVersion('2.2.0', '1')).toBe('2.2.0.1')
  expect(fnosPackageVersion('2.2.0', 12)).toBe('2.2.0.12')
  for (const revision of [
    -1,
    1.5,
    '01',
    '1\nversion=99',
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(() => fnosPackageVersion('2.2.0', revision)).toThrow('revision')
  expect(() => fnosPackageVersion('2.2.0-beta', 1)).toThrow('stable')
})
it('recognizes the actual Node entrypoint instead of a later script argument', () => {
  const entry = '/app/server/index.mjs'
  expect(matchesEntrypoint(['node', entry, ''].join('\0'), entry)).toBe(true)
  expect(
    matchesEntrypoint(
      ['node', '--no-opt', '-r', '/bootstrap.cjs', entry, ''].join('\0'),
      entry
    )
  ).toBe(true)
  expect(
    matchesEntrypoint(['node', '/other.mjs', entry, ''].join('\0'), entry)
  ).toBe(false)
  expect(
    matchesEntrypoint(['node', '-e', 'anything', entry, ''].join('\0'), entry)
  ).toBe(false)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})
async function temporary() {
  const directory = await mkdtemp('/tmp/mtx-fpk-test-')
  directories.push(directory)
  return directory
}

it.each([
  { manifestVersion: '2.2.0' },
  { serverVersion: '2.2.1' },
  { packageVersion: '2.2.0.2' },
  { revision: undefined, packageVersion: '2.2.0', manifestVersion: '2.2.0' },
])(
  'rejects inconsistent package and application versions: %j',
  async (overrides) => {
    const directory = await temporary()
    await mkdir(path.join(directory, 'app/server'), { recursive: true })
    const values = {
      revision: 1,
      packageVersion: '2.2.0.1',
      manifestVersion: '2.2.0.1',
      serverVersion: '2.2.0',
      ...overrides,
    }
    await writeFile(
      path.join(directory, 'manifest'),
      `appname=motrix\nplatform=arm\nversion=${values.manifestVersion}\nos_min_version=1.2.0401\nmicro_app=true\n`
    )
    await writeFile(
      path.join(directory, 'app/server/package.json'),
      JSON.stringify({ version: values.serverVersion })
    )
    await writeFile(
      path.join(directory, 'app/fnos-build.json'),
      JSON.stringify({
        schemaVersion: 2,
        version: '2.2.0',
        packageVersion: values.packageVersion,
        revision: values.revision,
      })
    )
    await expect(verifyFnosPackage(directory, 'arm64')).rejects.toThrow(
      'Inconsistent fnOS manifest'
    )
  }
)

it('requires a system download share and keeps private state outside the replaceable application', () => {
  const env = {
    TRIM_APPDEST: '/vol1/@apps/motrix/target',
    TRIM_PKGVAR: '/vol1/@appdata/motrix',
    TRIM_DATA_SHARE_PATHS: '/vol2/downloads',
  }
  const runtime = runtimeEnvironment(env)
  expect(runtime.MOTRIX_DATA_DIR).toBe('/vol1/@appdata/motrix/motrix')
  expect(runtime.MOTRIX_ARIA2_BIN).toBe(
    '/vol1/@apps/motrix/target/server/bin/aria2c'
  )
  expect(runtime.MOTRIX_DEFAULT_SAVE_DIR).toBe('/vol2/downloads')
  expect(() =>
    runtimeEnvironment({ ...env, TRIM_DATA_SHARE_PATHS: '' })
  ).toThrow('unavailable')
  expect(() =>
    runtimeEnvironment({ ...env, TRIM_DATA_SHARE_PATHS: '/one:/two' })
  ).toThrow('unavailable')
})
it('extracts process birth time despite spaces and parentheses in comm, and rejects zombies', () => {
  const fields = ['S', ...Array(18).fill('0'), '482901']
  expect(processStartTime(`123 (node (worker)) ${fields.join(' ')}`)).toBe(
    '482901'
  )
  fields[0] = 'Z'
  expect(processStartTime(`123 (node) ${fields.join(' ')}`)).toBeUndefined()
})
it('rejects a tampered download and does not retain it in the cache', async () => {
  const directory = await temporary()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tampered')))
  await expect(
    lockedDownload(
      { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
      directory
    )
  ).rejects.toThrow('Checksum mismatch')
  const fetch = vi.fn().mockResolvedValue(new Response('expected'))
  vi.stubGlobal('fetch', fetch)
  const cached = await lockedDownload(
    { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
    directory
  )
  expect(await readFile(cached, 'utf8')).toBe('expected')
  await lockedDownload(
    { url: 'https://example.test/node.tar.xz', sha256: sha256('expected') },
    directory
  )
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('detects wrong-architecture and non-executable runtime binaries', async () => {
  const file = path.join(await temporary(), 'node')
  const elf = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf)
  elf.writeUInt16LE(183, 18)
  await writeFile(file, elf, { mode: 0o755 })
  await verifyFnosBinary(file, 'arm64')
  await expect(verifyFnosBinary(file, 'x64')).rejects.toThrow('Invalid')
  await chmod(file, 0o644)
  await expect(verifyFnosBinary(file, 'arm64')).rejects.toThrow('Invalid')
})
it('refuses overlapping output locations before touching the input', async () => {
  const directory = await temporary()
  await writeFile(path.join(directory, 'keep'), 'original')
  await expect(
    prepareFnosProject({
      appDir: directory,
      outputDir: directory,
      arch: 'arm64',
    })
  ).rejects.toThrow('overlap')
  expect(await readFile(path.join(directory, 'keep'), 'utf8')).toBe('original')
})

it('uses a separate configurable native client port and rejects invalid wizard values', () => {
  const env = {
    TRIM_APPDEST: '/app',
    TRIM_PKGVAR: '/data',
    TRIM_DATA_SHARE_PATHS: '/downloads',
  }
  expect(runtimeEnvironment(env).MOTRIX_MDXP_PORT).toBe('16802')
  expect(
    runtimeEnvironment({
      ...env,
      TRIM_SERVICE_PORT: '16802',
      wizard_client_port: '18081',
    }).MOTRIX_MDXP_PORT
  ).toBe('18081')
  for (const port of ['0', '80', '65536', '1e4', '8080;true', '../port'])
    expect(() =>
      runtimeEnvironment({ ...env, wizard_client_port: port })
    ).toThrow('Client port')
})

it('keeps Extension pairing opt-in and passes wizard values to the shared Server validator', () => {
  const env = {
    TRIM_APPDEST: '/app',
    TRIM_PKGVAR: '/data',
    TRIM_DATA_SHARE_PATHS: '/downloads',
  }
  expect(
    runtimeEnvironment({ ...env, MOTRIX_REMOTE_EXTENSION_ENABLED: 'true' })
      .MOTRIX_REMOTE_EXTENSION_ENABLED
  ).toBe('false')
  expect(
    runtimeEnvironment({
      ...env,
      wizard_extension_enabled: 'true',
      wizard_extension_url: 'ws://nas.local:16802',
      wizard_operator_url: 'http://nas.local:5666/app/motrix/',
      wizard_allow_operator_http: 'true',
    })
  ).toMatchObject({
    MOTRIX_REMOTE_EXTENSION_ENABLED: 'true',
    MOTRIX_REMOTE_EXTENSION_PUBLIC_URL: 'ws://nas.local:16802',
    MOTRIX_PUBLIC_URL: 'http://nas.local:5666/app/motrix/',
    MOTRIX_ALLOW_INSECURE_OPERATOR_HTTP: 'true',
  })
  // Optional invalid connection settings must not stop the gateway application.
  expect(() =>
    runtimeEnvironment({
      ...env,
      wizard_extension_enabled: 'yes',
      wizard_extension_url: 'invalid',
    })
  ).not.toThrow()
})
