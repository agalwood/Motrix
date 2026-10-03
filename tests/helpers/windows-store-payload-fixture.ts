import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPackageWithOptions } from '@electron/asar'

const OUTPUTS = [
  'dist/core/plugin/host/quick-js-worker.cjs',
  'dist/main/index.cjs',
  'dist/preload/preload.cjs',
  'dist/renderer/index.html',
]
const LEGAL = [
  'THIRD_PARTY_LICENSES/aria2-COPYING',
  'THIRD_PARTY_LICENSES/aria2-LICENSE.OpenSSL',
  'THIRD_PARTY_NOTICES.md',
  'THIRD_PARTY_NOTICES.zh-CN.md',
  'legal/THIRD_PARTY_DEPENDENCIES.md',
  'legal/THIRD_PARTY_LICENSES.txt',
  'legal/sbom.spdx.json',
]
const EXECUTABLES = [
  'Motrix.exe',
  'resources/bin/motrix-native-host.exe',
  'resources/bin/motrix-finalize-fs.exe',
  'resources/extra/win32/x64/aria2c.exe',
]
export const WINDOWS_STORE_PAYLOAD_METADATA = {
  schemaVersion: 1,
  profile: 'store',
  architecture: 'x64',
  productVersion: '1.2.3',
  packageVersion: '4.5.6.0',
  source: { commit: 'a'.repeat(40), tag: 'v1.2.3' },
  identity: {
    name: 'Example.Motrix',
    publisher: 'CN=Example Publisher',
    publisherDisplayName: 'Example Publisher',
  },
}

export function payloadFixtureSha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function windowsPeHeader(machine = 0x8664) {
  // Only enough PE structure to test machine selection, not a runnable program.
  const bytes = Buffer.alloc(72)
  bytes.write('MZ')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64)
  bytes.writeUInt16LE(machine, 68)
  return bytes
}

export async function writePayloadFixtureFile(
  root: string,
  relative: string,
  bytes: string | Buffer
) {
  const destination = path.join(root, relative)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}

export async function createWindowsStorePayloadFixture(
  mutate?: (source: string) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'motrix-store-payload-'))
  )
  const source = path.join(root, 'source')
  const appDir = path.join(root, 'payload')
  const asar = path.join(appDir, 'resources/app.asar')
  await mkdir(source)
  await writePayloadFixtureFile(
    source,
    'package.json',
    JSON.stringify({
      name: 'motrix-fixture',
      version: '1.2.3',
      main: 'dist/main/index.cjs',
    })
  )
  for (const output of OUTPUTS)
    await writePayloadFixtureFile(source, output, output)
  await writePayloadFixtureFile(
    source,
    'node_modules/better-sqlite3/package.json',
    JSON.stringify({
      name: 'better-sqlite3',
      version: '1.0.0',
      main: 'lib/index.js',
    })
  )
  await writePayloadFixtureFile(
    source,
    'node_modules/better-sqlite3/lib/index.js',
    'module.exports = {}'
  )
  await writePayloadFixtureFile(
    source,
    'node_modules/better-sqlite3/LICENSE',
    'fixture license'
  )
  await writePayloadFixtureFile(
    source,
    'node_modules/better-sqlite3/prebuilds/win32-x64.node',
    windowsPeHeader()
  )
  await writePayloadFixtureFile(
    source,
    '.motrix-package-stage.json',
    JSON.stringify({
      schemaVersion: 1,
      target: { platform: 'win32', arch: 'x64', key: 'win32-x64' },
      rootVersion: '1.2.3',
      buildOutputs: OUTPUTS.map((entry) => ({
        path: entry,
        bytes: Buffer.byteLength(entry),
        sha256: payloadFixtureSha256(entry),
      })),
      externals: ['better-sqlite3'],
      inventory: { files: 10, bytes: 100 },
      optionalOmissions: [],
      packages: [
        {
          destination: 'node_modules/better-sqlite3',
          name: 'better-sqlite3',
          version: '1.0.0',
        },
      ],
    })
  )
  for (const file of EXECUTABLES)
    await writePayloadFixtureFile(appDir, file, windowsPeHeader())
  await writePayloadFixtureFile(appDir, 'runtime.dll', windowsPeHeader())
  for (const file of LEGAL)
    await writePayloadFixtureFile(appDir, `resources/${file}`, file)
  await writePayloadFixtureFile(
    appDir,
    'resources/builtin-plugins/motrix.fixture/motrix-plugin.json',
    JSON.stringify({ id: 'motrix.fixture' })
  )
  await writePayloadFixtureFile(
    appDir,
    'resources/builtin-plugins/motrix.fixture/dist/plugin.js',
    'export default true'
  )
  await mutate?.(source)
  await createPackageWithOptions(source, asar, {
    dot: true,
    unpackDir: 'dist/renderer',
  })
  return { root, source, appDir, asar }
}
