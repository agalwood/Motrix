import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function resolveServerPluginsDir(userDataDir: string): Promise<{
  pluginsDir: string
  builtinDir: string
}> {
  const pluginsDir =
    process.env.MOTRIX_PLUGIN_DIR ?? path.join(userDataDir, 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  const builtinDir =
    process.env.MOTRIX_BUILTIN_PLUGIN_DIR ??
    path.join(userDataDir, 'builtin-plugins')
  return { pluginsDir, builtinDir }
}
