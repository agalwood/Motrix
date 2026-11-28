import { execFileSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import nodeLock from './fnos-runtime.lock.json' with { type: 'json' }
import {
  lockedDownload,
  repositoryRoot,
  run,
  sha256,
  verifyFnosBinary,
} from './prepare-fnos-project.mjs'
import dsmLock from './synology-runtime.lock.json' with { type: 'json' }
import { synologyTarget } from './synology-target.mjs'
import { verifyServerPackage } from './verify-server-package.mjs'

export async function prepareSynologyProject({
  appDir = 'dist/server-app',
  outputDir = 'release/synology/project',
  revision = String(dsmLock.revision),
  arch = 'x64',
} = {}) {
  const target = synologyTarget(arch)
  const source = path.resolve(appDir)
  const output = path.resolve(outputDir)
  if (!/^[1-9]\d{0,7}$/.test(revision)) throw new Error('Invalid SPK revision')
  if (
    !path.relative(source, output).startsWith(`..${path.sep}`) ||
    !path.relative(output, repositoryRoot).startsWith(`..${path.sep}`)
  )
    throw new Error('Overlapping SPK output directory')
  if (await stat(output).catch(() => undefined))
    throw new Error('Choose a fresh SPK output directory')
  await verifyServerPackage({
    appDir: source,
    platform: 'linux',
    arch,
    libc: 'gnu',
  })
  const manifest = JSON.parse(
    await readFile(path.join(source, 'package.json'), 'utf8')
  )
  const project = JSON.parse(
    await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')
  )
  if (
    manifest.version !== project.version ||
    !/^\d+\.\d+\.\d+$/.test(project.version)
  )
    throw new Error('SPK requires the current stable application version')
  await mkdir(path.dirname(output), { recursive: true })
  const temporary = await mkdtemp(path.join(path.dirname(output), '.spk-'))
  try {
    await cp(path.join(repositoryRoot, 'packaging/synology'), temporary, {
      recursive: true,
    })
    for (const name of ['README.md', 'README.zh-CN.md'])
      await rm(path.join(temporary, name), { force: true })
    await cp(source, path.join(temporary, 'app/server'), {
      recursive: true,
      dereference: true,
    })
    await cp(
      path.join(repositoryRoot, 'LICENSE'),
      path.join(temporary, 'LICENSE')
    )
    const archive = await lockedDownload(
      nodeLock.node[arch],
      path.join(repositoryRoot, 'node_modules/.cache/fnos')
    )
    const runtime = path.join(temporary, 'app/runtime')
    await mkdir(runtime, { recursive: true })
    const prefix = `node-v${nodeLock.nodeVersion}-linux-${arch}`
    run('tar', [
      '-xJf',
      archive,
      '--strip-components=1',
      '-C',
      runtime,
      `${prefix}/bin/node`,
      `${prefix}/LICENSE`,
    ])
    await verifyFnosBinary(path.join(runtime, 'bin/node'), arch)
    const git = (args) =>
      execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
      }).trim()
    const receipt = {
      sourceCommit: git(['rev-parse', 'HEAD']),
      sourceDirty:
        git(['status', '--porcelain', '--untracked-files=normal']) !== '',
      schemaVersion: 2,
      version: project.version,
      revision: Number(revision),
      architecture: arch,
      platforms: Object.keys(target.platforms),
      minimumDsm: dsmLock.dsmVersion,
      nodeVersion: nodeLock.nodeVersion,
      nodeArchiveSha256: nodeLock.node[arch].sha256,
      nodeSha256: sha256(await readFile(path.join(runtime, 'bin/node'))),
      toolchainDigests: target.toolchainDigests,
      deviceAcceptance: 'not-run',
    }
    await writeFile(
      path.join(temporary, 'app/synology-build.json'),
      `${JSON.stringify(receipt, null, 2)}\n`
    )
    const info = path.join(temporary, 'INFO')
    await writeFile(
      info,
      (await readFile(info, 'utf8'))
        .replaceAll('@ARCH@', target.infoArch)
        .replaceAll('@VERSION@', project.version)
        .replaceAll('@REVISION@', revision)
    )
    await rename(temporary, output)
    return output
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
    options: {
      arch: { type: 'string' },
      'app-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      revision: { type: 'string' },
    },
  })
  console.log(
    await prepareSynologyProject({
      appDir: values['app-dir'],
      arch: values.arch,
      outputDir: values['output-dir'],
      revision: values.revision,
    })
  )
}
