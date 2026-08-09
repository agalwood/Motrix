import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { PlatformServices } from '@shared/platform/services'
import { app } from 'electron'

export async function resolvePluginsDir(
  platform: Pick<PlatformServices, 'isDev' | 'extraResourceDir'>
): Promise<{
  pluginsDir: string
  builtinDir: string
}> {
  const pluginsDir = path.join(app.getPath('userData'), 'plugins')
  await mkdir(pluginsDir, { recursive: true })
  // Builtin plugins are fetched by `pnpm build:builtin`
  // (scripts/fetch-builtins.mjs, lockfile-pinned motrixapp/builtin-plugins
  // release artifacts) into <projectRoot>/dist/builtin-plugins/<id>/ and, at
  // electron-builder time, copied to <resourcesDir>/builtin-plugins (sibling
  // of <resourcesDir>/extra).
  // Derive the base from extraResourceDir — the single source of truth
  // services.ts already computed (and which respects MOTRIX_USER_DATA):
  //   dev : dirname(<projectRoot>/extra)  = <projectRoot>  → dist/builtin-plugins
  //   prod: dirname(<resourcesDir>/extra) = <resourcesDir> → builtin-plugins
  const builtinBase = path.dirname(platform.extraResourceDir)
  const builtinDir = platform.isDev
    ? path.join(builtinBase, 'dist', 'builtin-plugins')
    : path.join(builtinBase, 'builtin-plugins')
  return { pluginsDir, builtinDir }
}
