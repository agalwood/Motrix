import path from 'node:path'
import { getLogger } from '@core/logger'
import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import { ArtifactMutationLeaseCoordinator } from '@core/plugin/finalize/artifact-mutation-lease'
import { NativeFinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import { NativeFinalizeArtifactOperations } from '@core/plugin/finalize/native-artifact-operations'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import { HookAuditLog } from '@core/plugin/hooks/audit-log'
import { HookOrchestrator } from '@core/plugin/hooks/hook-orchestrator'
import type { StagedMetadataOp } from '@core/plugin/hooks/staged-effects'
import type { ActivationDispatcher } from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginInstaller } from '@core/plugin/install/plugin-installer'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import {
  createLoggingPostDeliveryObservability,
  type PostDeliveryObservability,
} from '@core/plugin/post/delivery-observability'
import type { PostDeliveryRetentionRepository } from '@core/plugin/post/delivery-retention'
import type { PostDeliveryRepository } from '@core/plugin/post/delivery-types'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import type { SessionManager } from '@core/session/session-manager'
import type { DownloadTask } from '@shared/types/task'
import type { TaskOccurrence } from '@shared/types/task-occurrence'
import type Database from 'better-sqlite3'
import {
  PluginHookRuntime,
  type PluginTerminalPersistenceInput,
} from './plugin-hook-runtime'

export interface PluginRuntimeFactoryOptions {
  activation: ActivationDispatcher
  registry: PluginRegistry
  grants: GrantsManager
  host: PluginHost
  installer: Pick<PluginInstaller, 'bindRetentionSink'>
  capabilityHost: CapabilityHost
  repository: PostDeliveryRepository & PostDeliveryRetentionRepository
  database: Database.Database
  session: Pick<
    SessionManager,
    | 'persistFinalizedArtifact'
    | 'persistTaskWithPluginMetadata'
    | 'bindPostDeliveryObservability'
    | 'bindTerminalOccurrencePersistence'
  >
  persistTerminal(
    task: DownloadTask,
    occurrence: TaskOccurrence,
    input: PluginTerminalPersistenceInput
  ): Promise<void>
  pluginsDir: string
  auditLogPath: string
  finalizeSidecarPath: string
  acquireTaskMutationLease?(taskId: string): Promise<{
    release(): Promise<void>
  }>
  assertEngineQuiesced(taskId: string): Promise<void>
  observability?: PostDeliveryObservability
}

export interface PluginRuntimeAssembly {
  auditLog: HookAuditLog
  orchestrator: HookOrchestrator
  hooks: PluginHookRuntime
  finalize: DurableFinalizeRuntime
  finalizeFilesystem: NativeFinalizeFilesystemAdapter
  persistTaskWithPluginMetadata(
    task: DownloadTask,
    operations: readonly StagedMetadataOp[]
  ): Promise<void>
}

/**
 * The sole production assembly point for the Hook runtime shared by Electron
 * and Server. It fails closed before returning when the native finalize
 * boundary cannot provide every required filesystem primitive.
 */
export async function createPluginRuntime(
  options: PluginRuntimeFactoryOptions
): Promise<PluginRuntimeAssembly> {
  const auditLog = new HookAuditLog(options.auditLogPath)
  const observability =
    options.observability ??
    createLoggingPostDeliveryObservability(getLogger('plugin:post-delivery'))
  const orchestrator = new HookOrchestrator({
    host: options.host,
    activationDispatcher: options.activation,
    hookTimeoutMs: { series: 10_000, parallel: 30_000 },
    pluginsDir: options.pluginsDir,
    pluginStorageRootFor: (pluginId) =>
      path.join(options.pluginsDir, pluginId, 'storage'),
    capabilityHost: options.capabilityHost,
    auditLog,
  })
  const hooks = new PluginHookRuntime({
    activation: options.activation,
    registry: options.registry,
    grants: options.grants,
    host: options.host,
    capabilityHost: options.capabilityHost,
    repository: options.repository,
    persistTerminal: options.persistTerminal,
    observability,
  })
  const finalizeFilesystem = new NativeFinalizeFilesystemAdapter(
    options.finalizeSidecarPath
  )
  const finalizeOperations = new NativeFinalizeArtifactOperations(
    finalizeFilesystem
  )
  try {
    await finalizeOperations.assertSupported()
  } catch (error) {
    await finalizeFilesystem.dispose()
    throw error
  }
  const finalize = new DurableFinalizeRuntime({
    db: options.database,
    session: options.session,
    fs: finalizeOperations,
    leases: new ArtifactMutationLeaseCoordinator([
      ...(options.acquireTaskMutationLease
        ? [
            {
              quiesce: async (taskId: string) => {
                const lease = await options.acquireTaskMutationLease?.(taskId)
                if (!lease) {
                  throw new Error('task mutation lease provider disappeared')
                }
                return () => lease.release()
              },
            },
          ]
        : []),
      {
        quiesce: async (taskId) => {
          await options.assertEngineQuiesced(taskId)
          return () => undefined
        },
      },
      {
        quiesce: (taskId) => options.host.quiesceArtifactWriters(taskId),
      },
    ]),
  })
  options.host.bindPluginUnavailable((pluginId, reason, at) =>
    hooks.pluginUnavailable(pluginId, reason, at)
  )
  options.grants.bindPermissionRevoked((pluginId, permissions, at) =>
    hooks.permissionRevoked(pluginId, permissions, at)
  )
  options.installer.bindRetentionSink(hooks)
  options.session.bindPostDeliveryObservability(observability)
  options.session.bindTerminalOccurrencePersistence((task, occurrence) =>
    hooks.persistTerminal(task, occurrence)
  )
  return {
    auditLog,
    orchestrator,
    hooks,
    finalize,
    finalizeFilesystem,
    persistTaskWithPluginMetadata: (task, operations) =>
      options.session.persistTaskWithPluginMetadata(task, operations),
  }
}
