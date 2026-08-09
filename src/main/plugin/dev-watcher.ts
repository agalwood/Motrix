// NOTE: This file is intentionally duplicated at
// src/{main,server}/plugin/dev-watcher.ts. chokidar is shell-layer
// (Node/Electron) and stays out of @core/ to preserve the future Rust
// migration boundary. Keep the two copies in sync when making changes here.
//
// Spec §7 L2418-2431 — MOTRIX_PLUGIN_DEV_PATH bypasses the installer and
// consent dialog entirely: PluginRegistry.discover() reads the manifest
// directly from the dev directory and indexes it under origin='community'
// with `dev: true`. No `_install.json` is written; permissions are
// effectively auto-granted because the host never gates capability access
// on the install record. The renderer detects dev plugins via
// `PluginListDTO.source.type === 'dev'` and shows a "Dev mode" badge.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import { parseManifest } from '@core/plugin/manifest/parse'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import { watch as chokidarWatch } from 'chokidar'

const log = getLogger('plugin:dev-watcher')

export async function startDevWatcher(
  devPath: string,
  registry: PluginRegistry,
  host: PluginHost,
  hostVersion: string
): Promise<{ close(): Promise<void> }> {
  const raw = await readFile(path.join(devPath, 'motrix-plugin.json'), 'utf8')
  const { manifest } = parseManifest(raw, { hostVersion })
  const pluginId = manifest.id

  log.info({ pluginId, devPath }, 'dev-watcher: starting')

  const watcher = chokidarWatch(
    [
      path.join(devPath, 'motrix-plugin.json'),
      path.join(devPath, 'dist', 'plugin.js'),
      path.join(devPath, 'locales', '**'),
    ],
    { ignoreInitial: true }
  )

  watcher.on('all', async (event, filePath) => {
    log.info(
      { event, filePath, pluginId },
      'dev-watcher: file changed, reloading'
    )
    try {
      await registry.discover()
      if (host.isActive(pluginId)) {
        await host.deactivate(pluginId)
      }
      await host.activate(pluginId)
      log.info({ pluginId }, 'dev-watcher: plugin reloaded')
    } catch (err) {
      log.warn(
        { err, pluginId },
        'dev-watcher: reload failed — plugin may have errors'
      )
    }
  })

  return {
    close: () => watcher.close(),
  }
}
