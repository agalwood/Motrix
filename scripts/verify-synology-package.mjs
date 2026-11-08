import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import nodeLock from './fnos-runtime.lock.json' with { type: 'json' }
import {
  repositoryRoot,
  run,
  sha256,
  verifyFnosBinary,
} from './prepare-fnos-project.mjs'
import dsmLock from './synology-runtime.lock.json' with { type: 'json' }
import { synologyTarget } from './synology-target.mjs'
import { verifyServerPackage } from './verify-server-package.mjs'

export async function payloadInventory(root) {
  const files = {}
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name)
      const relative = `${prefix}${name}`
      if (relative === 'payload-sha256.json') continue
      const info = await lstat(absolute)
      if (info.isDirectory()) await walk(absolute, `${relative}/`)
      else if (!info.isFile() || (info.mode & 0o7022) !== 0)
        throw new Error(`Unsafe SPK member: ${relative}`)
      else
        files[relative] = {
          sha256: sha256(await readFile(absolute)),
          executable: Boolean(info.mode & 0o111),
        }
    }
  }
  await walk(root)
  return files
}

export async function verifySynologyProject(root) {
  const app = path.join(root, 'app')
  const readJson = async (name) =>
    JSON.parse(await readFile(path.join(root, name), 'utf8'))
  const receipt = await readJson('app/synology-build.json')
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/)
  assert.equal(typeof receipt.sourceDirty, 'boolean')
  const arch = receipt.architecture
  const target = synologyTarget(arch)
  if (receipt.schemaVersion === 1) {
    // Previously shipped x64 archives recorded only the Gemini Lake build SDK.
    assert.equal(arch, 'x64')
    assert.equal(
      receipt.toolchainSha256,
      target.platforms.geminilake.toolchain.sha256
    )
  } else {
    assert.equal(receipt.schemaVersion, 2)
    assert.deepEqual(receipt.platforms, Object.keys(target.platforms))
    assert.deepEqual(receipt.toolchainDigests, target.toolchainDigests)
  }
  assert.equal(receipt.minimumDsm, dsmLock.dsmVersion)
  assert.equal(receipt.nodeArchiveSha256, nodeLock.node[arch].sha256)
  assert.equal(
    sha256(await readFile(path.join(app, 'runtime/bin/node'))),
    receipt.nodeSha256
  )
  assert.equal(receipt.nodeSha256, nodeLock.node[arch].binarySha256)
  assert.deepEqual(await readJson('conf/privilege'), {
    defaults: { 'run-as': 'package' },
    username: 'motrix',
    groupname: 'motrix',
    'join-groupname': 'http',
  })
  const info = await readFile(path.join(root, 'INFO'), 'utf8')
  for (const field of [
    `version="${receipt.version}-${receipt.revision}"`,
    `arch="${target.infoArch}"`,
    `os_min_ver="${dsmLock.dsmVersion}"`,
    'maintainer="Dr_rOot"',
    'maintainer_url="https://github.com/agalwood"',
  ])
    assert.ok(info.split('\n').includes(field), field)
  for (const file of [
    'runtime/bin/node',
    'server/bin/aria2c',
    'server/bin/motrix-finalize-fs',
  ])
    await verifyFnosBinary(path.join(app, file), arch)
  for (const file of [
    'LICENSE',
    'runtime/LICENSE',
    'server/legal/THIRD_PARTY_LICENSES.txt',
  ])
    assert.ok(
      (
        await readFile(
          path.join(app, file === 'LICENSE' ? 'server/LICENSE' : file)
        )
      ).length > 0
    )
  for (const action of [
    'preinst',
    'postinst',
    'preupgrade',
    'postupgrade',
    'preuninst',
    'postuninst',
    'start-stop-status',
  ]) {
    const file = path.join(root, 'scripts', action)
    assert.ok((await lstat(file)).mode & 0o111)
    assert.ok(!(await readFile(file, 'utf8')).includes('npm '))
  }
  for (const language of ['', '_chs', '_cht'])
    for (const action of ['install', 'upgrade', 'uninstall'])
      assert.ok(
        Array.isArray(
          await readJson(`WIZARD_UIFILES/${action}_uifile${language}`)
        )
      )
  await verifyServerPackage({
    appDir: path.join(app, 'server'),
    platform: 'linux',
    arch,
    libc: 'gnu',
  })
  assert.deepEqual(
    await payloadInventory(app),
    await readJson('app/payload-sha256.json')
  )
  return receipt
}

export async function verifySynologyPackage(file, inspect = async () => {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'motrix-spk-verify-'))
  try {
    const unpacked = path.join(temporary, 'spk')
    run('python3', [
      path.join(repositoryRoot, 'scripts/spk_archive.py'),
      file,
      unpacked,
    ])
    const archive = path.join(unpacked, 'package.tgz')
    const checksum = createHash('md5')
      .update(await readFile(archive))
      .digest('hex')
    assert.ok(
      (await readFile(path.join(unpacked, 'INFO'), 'utf8'))
        .split('\n')
        .includes(`checksum="${checksum}"`)
    )
    run('python3', [
      path.join(repositoryRoot, 'scripts/spk_archive.py'),
      archive,
      path.join(unpacked, 'app'),
    ])
    const receipt = await verifySynologyProject(unpacked)
    await inspect(unpacked)
    return receipt
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { spk: { type: 'string' } },
  })
  console.log(await verifySynologyPackage(path.resolve(values.spk)))
}
