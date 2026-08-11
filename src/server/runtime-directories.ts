import { mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export interface ServerRuntimeDirectoryOptions {
  dataDir: string
  tempDirValue?: string
}

export interface ServerRuntimeDirectories {
  dataDir: string
  tempDir: string
  torrentsDir: string
  homeDir: string
}

function absolutePath(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return path.resolve(trimmed)
}

async function requireWritableDirectory(dir: string, label: string) {
  await mkdir(dir, { recursive: true }).catch((cause) => {
    throw new Error(`${label} cannot be created: ${dir}`, { cause })
  })
  const info = await stat(dir)
  if (!info.isDirectory())
    throw new Error(`${label} is not a directory: ${dir}`)
  const probe = path.join(
    dir,
    `.motrix-runtime-write-test-${process.pid}-${Date.now()}`
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(probe, 'wx', 0o600)
    await handle.close()
    handle = undefined
    await unlink(probe)
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    await unlink(probe).catch(() => undefined)
    throw new Error(`${label} is not writable: ${dir}`, { cause })
  }
}

export async function prepareServerRuntimeDirectories(
  options: ServerRuntimeDirectoryOptions
): Promise<ServerRuntimeDirectories> {
  const dataDir = absolutePath(options.dataDir, 'MOTRIX_DATA_DIR')
  const tempDir = absolutePath(
    options.tempDirValue?.trim() || path.join(dataDir, 'tmp'),
    options.tempDirValue?.trim() ? 'MOTRIX_TEMP_DIR' : 'Server temp directory'
  )
  const torrentsDir = path.join(dataDir, 'torrents')
  const homeDir = path.join(dataDir, 'home')
  await requireWritableDirectory(dataDir, 'Server data directory')
  await Promise.all([
    requireWritableDirectory(tempDir, 'Server temp directory'),
    requireWritableDirectory(torrentsDir, 'Torrent metadata directory'),
    requireWritableDirectory(homeDir, 'Server runtime home directory'),
  ])
  return { dataDir, tempDir, torrentsDir, homeDir }
}
