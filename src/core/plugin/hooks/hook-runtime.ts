import path from 'node:path'
import type { PluginHost } from '../host/plugin-host'
import { HookAuditLog } from './audit-log'
import { HookOrchestrator } from './hook-orchestrator'

export interface PluginHookRuntime {
  orchestrator: HookOrchestrator
  auditLog: HookAuditLog
}

export function createPluginHookRuntime(opts: {
  host: PluginHost
  pluginsDir: string
  userDataDir: string
}): PluginHookRuntime {
  const auditLog = new HookAuditLog(
    path.join(opts.userDataDir, 'plugin-audit', 'hooks.ndjson')
  )
  const orchestrator = new HookOrchestrator({
    host: opts.host,
    hookTimeoutMs: { series: 10_000, parallel: 30_000 },
    pluginsDir: opts.pluginsDir,
    pluginStorageRootFor: (pluginId) =>
      path.join(opts.pluginsDir, pluginId, 'storage'),
    auditLog,
  })

  return { orchestrator, auditLog }
}
