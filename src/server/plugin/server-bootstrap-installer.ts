import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import { parseAllowlist } from '@core/plugin/install/server-ack'
import type { GrantsMap } from '@shared/types/plugin-install'
import type { ServerPluginInstallService } from './install-service'

export interface BootstrapInstallResult {
  accepted: string[]
  rejected: Array<{ source: string; reason: string }>
}

export interface ServerBootstrapEnv {
  MOTRIX_PLUGIN_INSTALL_URLS?: string
}

function installPayload(source: string): unknown {
  if (source.startsWith('github:')) {
    return { sourceType: 'github', spec: source.slice('github:'.length) }
  }
  if (source.startsWith('registry:')) {
    return {
      sourceType: 'registry',
      pluginId: source.slice('registry:'.length),
    }
  }
  return { sourceType: 'url', url: source }
}

/**
 * Reconciles explicit startup install sources before plugin activation.
 * Setting the environment variable is the operator consent boundary; required
 * permissions are inherent and optional permissions start denied.
 */
export async function serverBootstrapInstall(
  service: Pick<ServerPluginInstallService, 'stage'>,
  installer: Pick<PluginInstaller, 'commit'>,
  env: ServerBootstrapEnv
): Promise<BootstrapInstallResult> {
  const accepted: string[] = []
  const rejected: BootstrapInstallResult['rejected'] = []
  for (const source of parseAllowlist(env.MOTRIX_PLUGIN_INSTALL_URLS)) {
    try {
      const staged = await service.stage(installPayload(source))
      if (staged.committed && staged.pluginId) {
        accepted.push(staged.pluginId)
        continue
      }
      const grants: GrantsMap = Object.fromEntries(
        staged.consent.trustSurface.optionalPermissions.map(({ name }) => [
          name,
          'denied',
        ])
      )
      const committed = await installer.commit(staged.stagingId, grants)
      accepted.push(committed.pluginId)
    } catch (cause) {
      rejected.push({
        source,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return { accepted, rejected }
}
