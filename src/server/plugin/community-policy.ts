import { readInstallRecord } from '@core/plugin/install/install-record'

export interface ServerCommunityPluginPolicyOptions {
  allowUnmanagedPlugins: boolean
}

export function parseAllowUnmanagedPlugins(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new Error('MOTRIX_ALLOW_UNMANAGED_PLUGINS must be true, false, 1, or 0')
}

export function createServerCommunityPluginPolicy(
  options: ServerCommunityPluginPolicyOptions
): (pluginDir: string) => Promise<{ ok: boolean; reason?: string }> {
  return async (pluginDir) => {
    if (options.allowUnmanagedPlugins) return { ok: true }
    const record = await readInstallRecord(pluginDir)
    return record
      ? { ok: true }
      : { ok: false, reason: 'plugin.lifecycle.install_record_required' }
  }
}
