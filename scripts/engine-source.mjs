import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const projectRoot = path.resolve(import.meta.dirname, '..')
export const sha256Hex = (bytes) =>
  createHash('sha256').update(bytes).digest('hex')
export const binaryName = (platform) =>
  platform === 'win32' ? 'taiji.exe' : 'taiji'
export const bundledPath = (extra, platform, arch) =>
  path.join(extra, platform, arch, binaryName(platform))

export async function readEngineSource(root = projectRoot) {
  const lock = JSON.parse(
    await readFile(path.join(root, 'scripts/engine.lock.json'), 'utf8')
  )
  const source = JSON.parse(
    await readFile(path.join(root, 'scripts/taiji-source.lock.json'), 'utf8')
  )
  if (
    lock.engine !== 'taiji' ||
    !/^[a-f0-9]{40}$/.test(source.revision) ||
    !/^[a-f0-9]{64}$/.test(source.cargoLockSha256)
  )
    throw new Error('Invalid taiji source lock')
  return {
    lock,
    source,
    sourceDigest: sha256Hex(JSON.stringify({ lock, source })),
  }
}
