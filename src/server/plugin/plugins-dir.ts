import { mkdir, open, realpath, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

interface ServerPluginDirectoryEnvironment {
  MOTRIX_PLUGIN_DIR?: string
  MOTRIX_BUILTIN_PLUGIN_DIR?: string
  MOTRIX_PLUGIN_IMPORT_DIRS?: string
}

function absolutePath(value: string, label: string): string {
  const trimmed = value.trim()
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return path.resolve(trimmed)
}

async function requireWritableDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const probe = path.join(
    dir,
    `.motrix-plugin-write-test-${process.pid}-${Date.now()}`
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
    throw new Error(`Plugin directory is not writable: ${dir}`, {
      cause,
    })
  }
}

async function resolveImportRoots(raw: string | undefined): Promise<string[]> {
  if (!raw?.trim()) return []
  const roots: string[] = []
  for (const value of raw.split(path.delimiter)) {
    if (!value.trim()) continue
    const configured = absolutePath(value, 'MOTRIX_PLUGIN_IMPORT_DIRS entry')
    const info = await stat(configured).catch((cause) => {
      throw new Error(`Plugin import directory is unavailable: ${configured}`, {
        cause,
      })
    })
    if (!info.isDirectory()) {
      throw new Error(`Plugin import path is not a directory: ${configured}`)
    }
    roots.push(await realpath(configured))
  }
  return [...new Set(roots)]
}

export async function resolveServerPluginsDir(
  userDataDir: string,
  env: ServerPluginDirectoryEnvironment = process.env
): Promise<{
  pluginsDir: string
  builtinDir: string
  pluginImportRoots: readonly string[]
}> {
  const pluginsDir = absolutePath(
    env.MOTRIX_PLUGIN_DIR ?? path.join(userDataDir, 'plugins'),
    env.MOTRIX_PLUGIN_DIR ? 'MOTRIX_PLUGIN_DIR' : 'Server plugin directory'
  )
  await requireWritableDirectory(pluginsDir)
  await Promise.all(
    ['_downloads', '_staging', '_uploads'].map(async (name) => {
      const transientDir = path.join(pluginsDir, name)
      await rm(transientDir, { recursive: true, force: true })
      await requireWritableDirectory(transientDir)
    })
  )
  await requireWritableDirectory(path.join(pluginsDir, '_logs'))
  const builtinDir = absolutePath(
    env.MOTRIX_BUILTIN_PLUGIN_DIR ?? path.join(userDataDir, 'builtin-plugins'),
    env.MOTRIX_BUILTIN_PLUGIN_DIR
      ? 'MOTRIX_BUILTIN_PLUGIN_DIR'
      : 'Server builtin plugin directory'
  )
  const pluginImportRoots = await resolveImportRoots(
    env.MOTRIX_PLUGIN_IMPORT_DIRS
  )
  return { pluginsDir, builtinDir, pluginImportRoots }
}
