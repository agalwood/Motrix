import type { CapabilityHost } from '@core/plugin/capabilities/interface'
import type { GrantsManager } from '@core/plugin/grants/grants-manager'
import type {
  ActivationDispatcher,
  HookCandidateDescriptor,
} from '@core/plugin/host/activation-dispatcher'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import { materializePostDeliveries } from '@core/plugin/post/delivery-materializer'
import type { PostDeliveryObservability } from '@core/plugin/post/delivery-observability'
import {
  PostDeliveryRetention,
  type PostDeliveryRetentionRepository,
} from '@core/plugin/post/delivery-retention'
import { PostDeliveryScheduler } from '@core/plugin/post/delivery-scheduler'
import type {
  JsonValue,
  PluginExecutableIdentity,
  PostDeliveryCandidateSnapshot,
  PostDeliveryClaim,
  PostDeliveryInvocationInput,
  PostDeliveryInvocationResult,
  PostDeliveryPluginInvoker,
  PostDeliveryPolicyDecision,
  PostDeliveryPolicyProvider,
  PostDeliveryRepository,
  PostDeliverySchedulerConfig,
  PostHookName,
} from '@core/plugin/post/delivery-types'
import type { PluginTaskSnapshotV1 } from '@shared/schemas/plugin-hooks'
import type { DownloadTask } from '@shared/types/task'
import type {
  TaskOccurrence,
  TaskTerminalOccurrence,
} from '@shared/types/task-occurrence'

export interface PluginTerminalPersistenceInput {
  postDeliveries: ReturnType<typeof materializePostDeliveries>
  beforeCommit: () => void
}

export interface PluginHookRuntimeOptions {
  activation: Pick<
    ActivationDispatcher,
    'candidatesForHook' | 'activateForHook'
  >
  registry: PluginRegistry
  grants: Pick<GrantsManager, 'effectivePermissionsFor'>
  host: PluginHost
  capabilityHost: CapabilityHost
  repository: PostDeliveryRepository & PostDeliveryRetentionRepository
  persistTerminal(
    task: DownloadTask,
    occurrence: TaskOccurrence,
    input: PluginTerminalPersistenceInput
  ): Promise<void>
  parallelTimeoutMs?: number
  schedulerConfig?: Partial<PostDeliverySchedulerConfig>
  observability?: PostDeliveryObservability
}

export class PolicySnapshotStaleError extends Error {
  constructor() {
    super('plugin policy changed while materializing terminal deliveries')
    this.name = 'PolicySnapshotStaleError'
  }
}

/** Shared shell-independent owner for durable post-Hook admission/execution. */
export class PluginHookRuntime {
  readonly scheduler: PostDeliveryScheduler
  readonly retention: PostDeliveryRetention
  private readonly timeoutMs: number

  constructor(private readonly options: PluginHookRuntimeOptions) {
    this.timeoutMs = options.parallelTimeoutMs ?? 30_000
    this.retention = new PostDeliveryRetention({
      repository: options.repository,
      observability: options.observability,
    })
    this.scheduler = new PostDeliveryScheduler({
      repository: options.repository,
      policy: this.policyProvider(),
      invoker: this.pluginInvoker(),
      config: options.schedulerConfig,
      observability: options.observability,
      maintenance: this.retention,
    })
  }

  async persistTerminal(
    task: DownloadTask,
    occurrence: TaskOccurrence
  ): Promise<void> {
    if (occurrence.type !== 'terminal') {
      await this.options.persistTerminal(task, occurrence, {
        postDeliveries: [],
        beforeCommit: () => undefined,
      })
      return
    }

    for (let attempt = 0; ; attempt += 1) {
      const materialized = await this.materialize(task, occurrence)
      try {
        await this.options.persistTerminal(task, occurrence, materialized)
        return
      } catch (error) {
        if (!(error instanceof PolicySnapshotStaleError) || attempt >= 7) {
          throw error
        }
      }
    }
  }

  /** Freeze terminal candidates for a caller that owns a larger FS+DB commit. */
  prepareTerminal(
    task: DownloadTask,
    occurrence: TaskTerminalOccurrence
  ): Promise<PluginTerminalPersistenceInput> {
    return this.materialize(task, occurrence)
  }

  async recoverAndDrain(): Promise<void> {
    await this.scheduler.recover()
    await this.scheduler.drainOnce()
  }

  supersede(executable: PluginExecutableIdentity, at: number): Promise<number> {
    return this.retention.supersede(executable, at)
  }

  pluginUnavailable(
    pluginId: string,
    reason: 'disabled' | 'uninstalled' | 'quarantined',
    at: number
  ): Promise<number> {
    return this.retention.pluginUnavailable(pluginId, reason, at)
  }

  permissionRevoked(
    pluginId: string,
    revokedPermissions: readonly string[],
    at: number
  ): Promise<number> {
    return this.retention.permissionRevoked(pluginId, revokedPermissions, at)
  }

  private async materialize(
    task: DownloadTask,
    occurrence: TaskTerminalOccurrence
  ): Promise<PluginTerminalPersistenceInput> {
    const hook: PostHookName =
      occurrence.toStatus === 'completed' ? 'afterComplete' : 'onError'
    const descriptors = this.options.activation.candidatesForHook(hook, {
      taskType: task.type,
    })
    const candidates: readonly PostDeliveryCandidateSnapshot[] =
      await Promise.all(
        descriptors.map(async (descriptor) => ({
          hook,
          executable: {
            pluginId: descriptor.id,
            version: descriptor.manifest.version,
            digest: descriptor.executableDigest,
          },
          createdGeneration: descriptor.generation,
          requiredPermissions: descriptor.manifest.permissions ?? [],
          createdEffectivePermissions: [
            ...(await this.options.grants.effectivePermissionsFor(
              descriptor.id
            )),
          ].sort(),
        }))
      )
    this.assertCandidatesCurrent(descriptors)
    const taskSnapshot = toPluginTaskSnapshot(task)
    const payload: JsonValue =
      hook === 'afterComplete'
        ? { task: taskSnapshot, filePath: task.finalPath || task.diskPath }
        : {
            task: taskSnapshot,
            filePath: task.finalPath || task.diskPath,
            error: terminalError(occurrence),
          }
    const postDeliveries = materializePostDeliveries({
      event: {
        schemaVersion: 1,
        occurrenceId: occurrence.occurrenceId,
        taskId: occurrence.taskId,
        occurredAt: occurrence.createdAt,
        payload,
      },
      candidates,
      createdAt: occurrence.createdAt,
    })
    return {
      postDeliveries,
      beforeCommit: () => this.assertCandidatesCurrent(descriptors),
    }
  }

  private assertCandidatesCurrent(
    descriptors: readonly HookCandidateDescriptor[]
  ): void {
    for (const descriptor of descriptors) {
      const current = this.options.registry.policySnapshot(descriptor.id)
      if (
        !current?.enabled ||
        current.generation !== descriptor.generation ||
        current.version !== descriptor.manifest.version ||
        current.executableDigest !== descriptor.executableDigest ||
        this.options.host.isPolicyMutationPending(descriptor.id)
      ) {
        throw new PolicySnapshotStaleError()
      }
    }
  }

  private policyProvider(): PostDeliveryPolicyProvider {
    return {
      acquire: async (
        record: PostDeliveryClaim
      ): Promise<PostDeliveryPolicyDecision> => {
        const current = this.options.registry.policySnapshot(
          record.executable.pluginId
        )
        if (!current) {
          return { kind: 'permanent', reason: 'uninstalled' }
        }
        if (!current.enabled) {
          return { kind: 'permanent', reason: 'disabled' }
        }
        if (
          current.version !== record.executable.version ||
          current.executableDigest !== record.executable.digest
        ) {
          return { kind: 'permanent', reason: 'superseded' }
        }
        if (
          this.options.host.isPolicyMutationPending(record.executable.pluginId)
        ) {
          throw new PolicySnapshotStaleError()
        }
        const effective = [
          ...(await this.options.grants.effectivePermissionsFor(
            record.executable.pluginId
          )),
        ].sort()
        const after = this.options.registry.policySnapshot(
          record.executable.pluginId
        )
        if (!after || after.generation !== current.generation) {
          throw new PolicySnapshotStaleError()
        }
        let hostLease: ReturnType<PluginHost['acquirePolicyLease']>
        try {
          hostLease = this.options.host.acquirePolicyLease(
            record.executable.pluginId,
            after.generation
          )
        } catch {
          throw new PolicySnapshotStaleError()
        }
        return {
          kind: 'authorized',
          lease: {
            currentGeneration: hostLease.generation,
            currentEffectivePermissions: effective,
            signal: hostLease.signal,
            release: hostLease.release,
          },
        }
      },
    }
  }

  private pluginInvoker(): PostDeliveryPluginInvoker {
    return {
      invoke: (input) => this.invokePostHook(input),
    }
  }

  private async invokePostHook(
    input: PostDeliveryInvocationInput
  ): Promise<PostDeliveryInvocationResult> {
    const { record } = input
    await this.options.activation.activateForHook(
      record.executable.pluginId,
      record.hook
    )
    const current = this.options.registry.policySnapshot(
      record.executable.pluginId
    )
    if (
      !current ||
      current.generation !== input.permissionGeneration ||
      current.version !== record.executable.version ||
      current.executableDigest !== record.executable.digest
    ) {
      throw new PolicySnapshotStaleError()
    }
    if (!this.options.host.isActive(record.executable.pluginId)) {
      throw new Error('post-Hook activation did not produce a worker')
    }
    const payload = parsePayload(record.canonicalPayload)
    const task = payload.task as { saveDir?: unknown; filePath?: unknown }
    if (
      typeof task?.saveDir !== 'string' ||
      typeof task.filePath !== 'string'
    ) {
      return {
        kind: 'failure' as const,
        classification: 'permanent' as const,
        code: 'plugin.hook.input_invalid',
        permanentReason: 'input_invalid' as const,
      }
    }
    const metadataSnapshot = await this.options.capabilityHost.metadata.getAll(
      record.taskId,
      record.executable.pluginId
    )
    await this.options.host.invokeHook(
      record.executable.pluginId,
      record.hook,
      {
        taskId: record.taskId,
        signal: input.signal,
        timeoutMs: this.timeoutMs,
        ctxPayload: payload,
        metadataSnapshot,
        invocationId: input.invocationId,
        permissionGeneration: input.permissionGeneration,
        context: {
          fsTaskHost: this.options.capabilityHost.fsTaskFor(
            task.saveDir,
            task.filePath
          ),
          taskId: record.taskId,
          effectivePermissions: new Set(input.effectivePermissions),
        },
      }
    )
    return {
      kind: 'success' as const,
      receipt: {
        deliveryId: record.deliveryId,
        invocationId: input.invocationId,
      },
    }
  }
}

export function toPluginTaskSnapshot(task: DownloadTask): PluginTaskSnapshotV1 {
  return {
    schemaVersion: 1,
    id: task.id,
    name: task.name,
    type: task.type,
    kind: task.kind,
    status: task.status,
    filePath: task.finalPath || task.diskPath,
    saveDir: task.saveDir,
    filename: task.filename,
    progress: Math.max(0, Math.min(100, task.progress * 100)),
    totalBytes: task.totalBytes,
    downloadedBytes: task.downloadedBytes,
    uploadedBytes: task.uploadedBytes,
    sizeWhenDone: task.sizeWhenDone,
    fileCount: task.fileCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    category: task.category,
    infoHash: task.infoHash,
    error: task.errorMessage
      ? {
          code: task.errorCode ?? 'TASK_ERROR',
          message: task.errorMessage,
          detailKey: task.errorDetailKey,
          detailParams: task.errorDetailParams,
        }
      : null,
  }
}

function terminalError(occurrence: TaskTerminalOccurrence) {
  return {
    code: occurrence.errorGroup?.errorCode ?? 'TASK_ERROR',
    message: occurrence.errorGroup?.errorMessage ?? 'Task failed',
    detailKey: occurrence.errorGroup?.errorDetailKey ?? null,
    detailParams: occurrence.errorGroup?.errorDetailParams ?? null,
  }
}

function parsePayload(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('persisted post-Hook payload is not an object')
  }
  return value as Record<string, unknown>
}
