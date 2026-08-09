import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { afterEach } from 'node:test'
import { gunzipSync } from 'node:zlib'

import {
  FLATPAK_COMPANION_BINARY,
  flatpakCompanionArchiveName,
  packageFlatpakCompanion,
  parseArgs,
} from './package-flatpak-companion.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

test('parses the release packaging arguments', () => {
  assert.deepEqual(
    parseArgs([
      '--version=2.0.0',
      '--arch',
      'arm64',
      '--output-dir',
      'release',
      '--binary=/tmp/companion',
    ]),
    {
      arch: 'arm64',
      binaryPath: '/tmp/companion',
      outputDirectory: 'release',
      version: '2.0.0',
    }
  )
  assert.throws(() => parseArgs(['--arch', 'x64']), /--version is required/)
  assert.throws(
    () => parseArgs(['--version', '2.0.0', '--arch']),
    /--arch requires a value/
  )
  assert.throws(
    () => parseArgs(['--version', '2.0.0', '--arch', 'x64', '--unknown']),
    /unknown flag/
  )
})

test('creates a deterministic archive with the documented install payload', async () => {
  const fixture = await createFixture('x64')
  const firstOutput = path.join(fixture.root, 'first')
  const secondOutput = path.join(fixture.root, 'second')
  const options = {
    arch: 'x64',
    binaryPath: fixture.binary,
    licensePath: fixture.license,
    licensesDirectory: fixture.licensesDirectory,
    noticesPath: fixture.notices,
    noticesZhPath: fixture.noticesZh,
    readmePath: fixture.readme,
    readmeZhPath: fixture.readmeZh,
    sourceDateEpoch: 1_700_000_000,
    version: '2.0.0',
  }

  const first = await packageFlatpakCompanion({
    ...options,
    outputDirectory: firstOutput,
  })
  const second = await packageFlatpakCompanion({
    ...options,
    outputDirectory: secondOutput,
  })
  const firstArchive = await readFile(first.output)
  const secondArchive = await readFile(second.output)

  assert.equal(first.archiveName, 'Motrix-Native-Host-2.0.0-linux-x64.tar.gz')
  assert.deepEqual(firstArchive, secondArchive)
  assert.equal(firstArchive.readUInt32LE(4), 0)

  const root = 'Motrix-Native-Host-2.0.0-linux-x64'
  const entries = readTarEntries(gunzipSync(firstArchive))
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      `${root}/`,
      `${root}/${FLATPAK_COMPANION_BINARY}`,
      `${root}/README.md`,
      `${root}/README.zh-CN.md`,
      `${root}/LICENSE`,
      `${root}/THIRD_PARTY_NOTICES.md`,
      `${root}/THIRD_PARTY_NOTICES.zh-CN.md`,
      `${root}/THIRD_PARTY_LICENSES/`,
      `${root}/THIRD_PARTY_LICENSES/alpha-LICENSE`,
      `${root}/THIRD_PARTY_LICENSES/nested/`,
      `${root}/THIRD_PARTY_LICENSES/nested/beta-LICENSE`,
      `${root}/THIRD_PARTY_LICENSES/rust-unicode-ident-LICENSE-UNICODE`,
    ]
  )
  assert.equal(entries[0].type, '5')
  assert.equal(entries[0].mode, 0o755)
  assert.equal(entries[1].mode, 0o755)
  assert.deepEqual(entries[1].content, fixture.binaryContent)
  assert.equal(entries[2].mode, 0o644)
  assert.equal(entries[2].content.toString(), 'English instructions\n')
  assert.equal(entries[3].content.toString(), '中文说明\n')
  assert.equal(entries[4].content.toString(), 'MIT fixture\n')
  assert.equal(entries[5].content.toString(), 'Third-party notices\n')
  assert.equal(entries[6].content.toString(), '第三方声明\n')
  assert.equal(entries[7].type, '5')
  assert.equal(entries[7].mode, 0o755)
  assert.equal(entries[8].content.toString(), 'Alpha license\n')
  assert.equal(entries[8].mode, 0o644)
  assert.equal(entries[9].type, '5')
  assert.equal(entries[10].content.toString(), 'Beta license\n')
  assert.equal(entries[11].content.toString(), 'Unicode license\n')
  assert.ok(entries.every((entry) => entry.mtime === 1_700_000_000))

  const listed = spawnSync('tar', ['-tzf', first.output], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(
    listed.stdout.trimEnd().split('\n'),
    entries.map((entry) => entry.name)
  )
})

test('rejects unsafe names, unsupported architectures, and wrong ELF targets', async () => {
  assert.equal(
    flatpakCompanionArchiveName('2.0.0-rc.1+build.7', 'x64'),
    'Motrix-Native-Host-2.0.0-rc.1+build.7-linux-x64.tar.gz'
  )
  assert.throws(
    () => flatpakCompanionArchiveName('../2.0.0', 'x64'),
    /invalid companion version/
  )
  assert.throws(
    () => flatpakCompanionArchiveName('2.0.0', 'ia32'),
    /unsupported Flatpak companion architecture/
  )

  const fixture = await createFixture('arm64')
  await assert.rejects(
    packageFlatpakCompanion({
      arch: 'x64',
      binaryPath: fixture.binary,
      licensePath: fixture.license,
      licensesDirectory: fixture.licensesDirectory,
      noticesPath: fixture.notices,
      noticesZhPath: fixture.noticesZh,
      outputDirectory: path.join(fixture.root, 'release'),
      readmePath: fixture.readme,
      readmeZhPath: fixture.readmeZh,
      version: '2.0.0',
    }),
    /not a linux-x64 executable/
  )
})

test('packages supported prerelease metadata using USTAR prefix paths', async () => {
  const fixture = await createFixture('x64')
  const version = '2.0.0-rc.1+build.7'
  const result = await packageFlatpakCompanion({
    arch: 'x64',
    binaryPath: fixture.binary,
    licensePath: fixture.license,
    licensesDirectory: fixture.licensesDirectory,
    noticesPath: fixture.notices,
    noticesZhPath: fixture.noticesZh,
    outputDirectory: path.join(fixture.root, 'release'),
    readmePath: fixture.readme,
    readmeZhPath: fixture.readmeZh,
    version,
  })

  const archive = gunzipSync(await readFile(result.output))
  const entries = readTarEntries(archive)
  const root = `Motrix-Native-Host-${version}-linux-x64`
  assert.ok(
    entries.some(
      (entry) =>
        entry.name ===
        `${root}/THIRD_PARTY_LICENSES/rust-unicode-ident-LICENSE-UNICODE`
    )
  )
  const listed = spawnSync('tar', ['-tzf', result.output], { encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(
    listed.stdout.trimEnd().split('\n'),
    entries.map((entry) => entry.name)
  )
})

test('requires an executable binary and never overwrites an archive', async () => {
  const fixture = await createFixture('x64')
  const outputDirectory = path.join(fixture.root, 'release')
  const options = {
    arch: 'x64',
    binaryPath: fixture.binary,
    licensePath: fixture.license,
    licensesDirectory: fixture.licensesDirectory,
    noticesPath: fixture.notices,
    noticesZhPath: fixture.noticesZh,
    outputDirectory,
    readmePath: fixture.readme,
    readmeZhPath: fixture.readmeZh,
    version: '2.0.0',
  }

  await packageFlatpakCompanion(options)
  await assert.rejects(packageFlatpakCompanion(options), /EEXIST/)

  await chmod(fixture.binary, 0o644)
  await assert.rejects(
    packageFlatpakCompanion({
      ...options,
      outputDirectory: path.join(fixture.root, 'non-executable'),
    }),
    /not executable/
  )
})

test('rejects missing or linked attribution payloads', async () => {
  const fixture = await createFixture('x64')
  const options = {
    arch: 'x64',
    binaryPath: fixture.binary,
    licensePath: fixture.license,
    licensesDirectory: fixture.licensesDirectory,
    noticesPath: fixture.notices,
    noticesZhPath: fixture.noticesZh,
    outputDirectory: path.join(fixture.root, 'release'),
    readmePath: fixture.readme,
    readmeZhPath: fixture.readmeZh,
    version: '2.0.0',
  }

  await rm(fixture.notices)
  await assert.rejects(
    packageFlatpakCompanion(options),
    /third-party notices is not a regular file/
  )

  await writeFile(fixture.notices, 'Third-party notices\n')
  const linkedLicense = path.join(fixture.licensesDirectory, 'linked-LICENSE')
  await symlink(
    path.join(fixture.licensesDirectory, 'alpha-LICENSE'),
    linkedLicense
  )
  await assert.rejects(
    packageFlatpakCompanion({
      ...options,
      outputDirectory: path.join(fixture.root, 'linked-license'),
    }),
    /third-party license is not a regular entry/
  )
})

async function createFixture(arch) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'motrix-flatpak-companion-package-')
  )
  temporaryDirectories.push(root)
  const binary = path.join(root, FLATPAK_COMPANION_BINARY)
  const readme = path.join(root, 'README.md')
  const readmeZh = path.join(root, 'README.zh-CN.md')
  const license = path.join(root, 'LICENSE')
  const notices = path.join(root, 'THIRD_PARTY_NOTICES.md')
  const noticesZh = path.join(root, 'THIRD_PARTY_NOTICES.zh-CN.md')
  const licensesDirectory = path.join(root, 'THIRD_PARTY_LICENSES')
  const nestedLicensesDirectory = path.join(licensesDirectory, 'nested')
  const binaryContent = fakeElf(arch)
  await mkdir(nestedLicensesDirectory, { recursive: true })
  await Promise.all([
    writeFile(binary, binaryContent, { mode: 0o755 }),
    writeFile(readme, 'English instructions\n'),
    writeFile(readmeZh, '中文说明\n'),
    writeFile(license, 'MIT fixture\n'),
    writeFile(notices, 'Third-party notices\n'),
    writeFile(noticesZh, '第三方声明\n'),
    writeFile(path.join(licensesDirectory, 'alpha-LICENSE'), 'Alpha license\n'),
    writeFile(
      path.join(licensesDirectory, 'rust-unicode-ident-LICENSE-UNICODE'),
      'Unicode license\n'
    ),
    writeFile(
      path.join(nestedLicensesDirectory, 'beta-LICENSE'),
      'Beta license\n'
    ),
  ])
  return {
    binary,
    binaryContent,
    license,
    licensesDirectory,
    notices,
    noticesZh,
    readme,
    readmeZh,
    root,
  }
}

function fakeElf(arch) {
  const content = Buffer.alloc(64)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(content)
  content[4] = 2
  content[5] = 1
  content.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  return content
}

function readTarEntries(archive) {
  const entries = []
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = readTarNumber(header, 124, 12)
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    entries.push({
      content: archive.subarray(offset + 512, offset + 512 + size),
      mode: readTarNumber(header, 100, 8),
      mtime: readTarNumber(header, 136, 12),
      name: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(header[156]),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString()
}

function readTarNumber(buffer, offset, length) {
  const value = readTarString(buffer, offset, length).trim()
  return value === '' ? 0 : Number.parseInt(value, 8)
}
