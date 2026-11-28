import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { normalizeFnosMetadataPermissions } from './fnos-metadata-permissions.mjs'
import runtimeLock from './fnos-runtime.lock.json' with { type: 'json' }
import { verifyServerPackage } from './verify-server-package.mjs'

export const FNOS_ARCHITECTURES = {
  x64: { platform: 'x86', machine: 62 },
  arm64: { platform: 'arm', machine: 183 },
}
export const repositoryRoot = path.resolve(import.meta.dirname, '..')
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export function fnosPackageVersion(version, revision = 0) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('fnOS requires a stable application version')
  if (
    !/^(0|[1-9]\d*)$/.test(String(revision)) ||
    !Number.isSafeInteger(Number(revision))
  )
    throw new Error('fnOS revision must be a non-negative safe integer')
  return Number(revision) === 0 ? version : `${version}.${revision}`
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${path.basename(command)} failed (${result.status})`)
}

export async function lockedDownload(asset, directory) {
  if (
    !asset ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !asset.url.startsWith('https://')
  )
    throw new Error('Invalid fnOS download lock')
  await mkdir(directory, { recursive: true })
  const destination = path.join(
    directory,
    `${asset.sha256}-${path.basename(new URL(asset.url).pathname)}`
  )
  const existing = await readFile(destination).catch(() => undefined)
  if (existing && sha256(existing) === asset.sha256) return destination
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${asset.url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (sha256(bytes) !== asset.sha256)
    throw new Error(`Checksum mismatch: ${asset.url}`)
  const temporary = `${destination}.${process.pid}.tmp`
  await writeFile(temporary, bytes, { flag: 'wx' })
  await rename(temporary, destination)
  return destination
}

export async function verifyFnosBinary(file, arch) {
  const target = FNOS_ARCHITECTURES[arch]
  if (!target) throw new Error('fnOS supports x64 and arm64 only')
  const info = await stat(file)
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(20)
    await handle.read(header, 0, 20, 0)
    if (
      !info.isFile() ||
      !(info.mode & 0o111) ||
      !header
        .subarray(0, 6)
        .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) ||
      header.readUInt16LE(18) !== target.machine
    )
      throw new Error(`Invalid ${arch} ELF executable: ${file}`)
  } finally {
    await handle.close()
  }
}

export async function prepareFnosProject({
  appDir,
  outputDir,
  arch,
  revision = 0,
  projectDir = repositoryRoot,
  nodeArchive,
}) {
  const target = FNOS_ARCHITECTURES[arch]
  if (!target) throw new Error('fnOS supports x64 and arm64 only')
  const source = path.resolve(appDir)
  const output = path.resolve(outputDir)
  const relative = path.relative(source, output)
  const reverse = path.relative(output, projectDir)
  if (
    !relative.startsWith(`..${path.sep}`) ||
    reverse === '' ||
    !reverse.startsWith(`..${path.sep}`)
  )
    throw new Error('Output must not overlap the app or source checkout')
  if (await stat(output).catch(() => undefined))
    throw new Error(
      'fnOS output already exists; choose a fresh output directory'
    )
  const manifest = JSON.parse(
    await readFile(path.join(source, 'package.json'), 'utf8')
  )
  const project = JSON.parse(
    await readFile(path.join(projectDir, 'package.json'), 'utf8')
  )
  if (
    manifest.version !== project.version ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)
  )
    throw new Error('fnOS package requires the current stable project version')
  const packageVersion = fnosPackageVersion(manifest.version, revision)
  await verifyServerPackage({
    appDir: source,
    platform: 'linux',
    arch,
    libc: 'gnu',
  })
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = await mkdtemp(path.join(path.dirname(output), '.fnos-'))
  try {
    await cp(path.join(projectDir, 'packaging/fnos'), temporary, {
      recursive: true,
    })
    await normalizeFnosMetadataPermissions(temporary)
    await rm(path.join(temporary, 'README.md'), { force: true })
    await cp(source, path.join(temporary, 'app/server'), {
      recursive: true,
      dereference: true,
    })
    const template = await readFile(path.join(temporary, 'manifest'), 'utf8')
    await writeFile(
      path.join(temporary, 'manifest'),
      template
        .replaceAll('@FNOS_PACKAGE_VERSION@', packageVersion)
        .replaceAll('@FNOS_PLATFORM@', target.platform)
    )
    const archive =
      nodeArchive ??
      (await lockedDownload(
        runtimeLock.node[arch],
        path.join(projectDir, 'node_modules/.cache/fnos')
      ))
    if (sha256(await readFile(archive)) !== runtimeLock.node[arch].sha256)
      throw new Error('Node archive checksum mismatch')
    const runtime = path.join(temporary, 'app/runtime')
    await mkdir(runtime, { recursive: true })
    const prefix = `node-v${runtimeLock.nodeVersion}-linux-${arch}`
    run('tar', [
      '-xJf',
      archive,
      '--strip-components=1',
      '-C',
      runtime,
      `${prefix}/bin/node`,
      `${prefix}/LICENSE`,
    ])
    await chmod(path.join(runtime, 'bin/node'), 0o755)
    await verifyFnosBinary(path.join(runtime, 'bin/node'), arch)
    const nodeBinary = await readFile(path.join(runtime, 'bin/node'))
    const main = path.join(temporary, 'cmd/main')
    await writeFile(
      main,
      (await readFile(main, 'utf8'))
        .replaceAll('@FNOS_NODE_SHA256@', sha256(nodeBinary))
        .replaceAll('@FNOS_NODE_SIZE@', String(nodeBinary.length))
    )

    for (const binary of ['aria2c', 'motrix-finalize-fs'])
      await verifyFnosBinary(
        path.join(temporary, 'app/server/bin', binary),
        arch
      )
    await writeFile(
      path.join(temporary, 'app/fnos-build.json'),
      `${JSON.stringify({ schemaVersion: 2, version: manifest.version, packageVersion, revision: Number(revision), arch, nodeVersion: runtimeLock.nodeVersion, nodeArchiveSha256: runtimeLock.node[arch].sha256, nodeSha256: sha256(await readFile(path.join(runtime, 'bin/node'))) }, null, 2)}\n`
    )
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      'app-dir': { type: 'string', default: 'dist/server-app' },
      'output-dir': { type: 'string' },
      arch: { type: 'string', default: process.arch },
      revision: { type: 'string', default: '0' },
      'node-archive': { type: 'string' },
    },
  })
  prepareFnosProject({
    appDir: values['app-dir'],
    outputDir: values['output-dir'] ?? `release/fnos/${values.arch}`,
    arch: values.arch,
    revision: values.revision,
    nodeArchive: values['node-archive'],
  })
    .then((directory) => console.log(`Prepared fnOS project: ${directory}`))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
