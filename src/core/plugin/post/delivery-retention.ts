import { canonicalJson } from './delivery-materializer'
import {
  NOOP_POST_DELIVERY_OBSERVABILITY,
  type PostDeliveryObservability,
  safeObserve,
} from './delivery-observability'
import {
  DEFAULT_POST_DELIVERY_QUOTA_CONFIG,
  type PluginExecutableIdentity,
  POST_DELIVERY_CORE_RESERVE_BYTES,
  POST_DELIVERY_HARD_BUDGET_BYTES,
  POST_DELIVERY_RECEIPT_MAX_BYTES,
  type PostDeliveryAdmission,
  type PostDeliveryAdmissionReason,
  type PostDeliveryClock,
  type PostDeliveryPermanentReason,
  type PostDeliveryQuotaConfig,
  PostDeliveryQuotaConfigSchema,
  type PostDeliveryTerminalReceipt,
  type PostHookName,
} from './delivery-types'

export const POST_DELIVERY_TOMBSTONE_MAX_BYTES = 1024
export const POST_DELIVERY_DAILY_BUCKETS_PER_REASON = 32
export const POST_DELIVERY_GLOBAL_TOMBSTONE_BUCKETS = 8192

export interface PostDeliveryQuotaUsage {
  pluginActiveRows: number
  pluginActiveBytes: number
  globalActiveRows: number
  globalActiveBytes: number
  postLogicalBytes: number
  databaseCapacityBytes: number
  coreLogicalBytes: number
}

export type PostDeliveryAdmissionDecision =
  | { admitted: true }
  | { admitted: false; reason: PostDeliveryAdmissionReason }

export type AtomicPostDeliveryAdmissionResult =
  | { kind: 'admitted'; deliveryId: string }
  | { kind: 'duplicate'; deliveryId: string }
  | {
      kind: 'rejected'
      deliveryId: string
      reason: PostDeliveryAdmissionReason
      tombstoneKey: string
    }

/**
 * Synchronous participant supplied to the task terminal-state transaction.
 * Implementations assert that the caller already holds the SQLite write
 * transaction. The row/tombstone, per-plugin and global ledgers, hard budget,
 * and core reserve decision are one atomic statement sequence.
 */
export interface PostDeliveryAdmissionTransaction {
  admitOrTombstone(
    row: PostDeliveryAdmission,
    config: PostDeliveryQuotaConfig
  ): AtomicPostDeliveryAdmissionResult
}

export interface PostDeliveryAdmissionSummary {
  admitted: number
  duplicates: number
  rejected: number
  results: readonly AtomicPostDeliveryAdmissionResult[]
}

/** Runs inside the caller-owned terminal transaction; any throw aborts it. */
export function admitPostDeliveries(
  transaction: PostDeliveryAdmissionTransaction,
  rows: readonly PostDeliveryAdmission[],
  config: PostDeliveryQuotaConfig = DEFAULT_POST_DELIVERY_QUOTA_CONFIG
): PostDeliveryAdmissionSummary {
  const parsed = PostDeliveryQuotaConfigSchema.parse(config)
  const results = rows.map((row) => transaction.admitOrTombstone(row, parsed))
  return {
    admitted: results.filter((result) => result.kind === 'admitted').length,
    duplicates: results.filter((result) => result.kind === 'duplicate').length,
    rejected: results.filter((result) => result.kind === 'rejected').length,
    results,
  }
}

/**
 * Pure mirror of the checks the database adapter performs atomically. It is
 * useful for diagnostics and conformance tests, but must not be used as a
 * preflight followed by an unlocked insert.
 */
export function evaluatePostDeliveryAdmission(
  row: Pick<PostDeliveryAdmission, 'reservedBytes'>,
  usage: PostDeliveryQuotaUsage,
  config: PostDeliveryQuotaConfig = DEFAULT_POST_DELIVERY_QUOTA_CONFIG
): PostDeliveryAdmissionDecision {
  const parsed = PostDeliveryQuotaConfigSchema.parse(config)
  const nextPluginRows = usage.pluginActiveRows + 1
  const nextPluginBytes = usage.pluginActiveBytes + row.reservedBytes
  const nextGlobalRows = usage.globalActiveRows + 1
  const nextGlobalBytes = usage.globalActiveBytes + row.reservedBytes
  if (nextPluginRows > parsed.pluginActiveRows) {
    return { admitted: false, reason: 'plugin_active_rows' }
  }
  if (nextPluginBytes > parsed.pluginActiveBytes) {
    return { admitted: false, reason: 'plugin_active_bytes' }
  }
  if (nextGlobalRows > parsed.globalActiveRows) {
    return { admitted: false, reason: 'global_active_rows' }
  }
  if (nextGlobalBytes > parsed.globalActiveBytes) {
    return { admitted: false, reason: 'global_active_bytes' }
  }
  if (
    usage.postLogicalBytes + row.reservedBytes >
    POST_DELIVERY_HARD_BUDGET_BYTES
  ) {
    return { admitted: false, reason: 'post_hard_budget' }
  }
  const bytesAvailableToPost = Math.max(
    0,
    usage.databaseCapacityBytes -
      usage.coreLogicalBytes -
      POST_DELIVERY_CORE_RESERVE_BYTES
  )
  if (usage.postLogicalBytes + row.reservedBytes > bytesAvailableToPost) {
    return { admitted: false, reason: 'post_hard_budget' }
  }
  return { admitted: true }
}

export function quotaTombstoneUtcDay(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('timestamp must be a non-negative safe integer')
  }
  return new Date(timestamp).toISOString().slice(0, 10)
}

export function compactTerminalReceipt(
  receipt: PostDeliveryTerminalReceipt
): string {
  const compacted = canonicalJson({
    attemptCount: receipt.attemptCount,
    completedAt: receipt.completedAt,
    deliveryId: receipt.deliveryId,
    hook: receipt.hook,
    pluginId: receipt.pluginId,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    status: receipt.status,
  })
  if (Buffer.byteLength(compacted, 'utf8') > POST_DELIVERY_RECEIPT_MAX_BYTES) {
    throw new RangeError('post-delivery terminal receipt exceeds 1 KiB')
  }
  return compacted
}

export interface PostDeliveryLedgerSnapshot {
  activeRows: number
  activeBytes: number
  terminalRows: number
  terminalBytes: number
  tombstoneRows: number
  tombstoneBytes: number
}

export interface PostDeliveryRetentionRepository {
  /** Recomputes exact counters from table contents in one write transaction. */
  reconcileLedger(): Promise<PostDeliveryLedgerSnapshot>
  /** Rolls oldest terminal receipts into aggregates until every quota fits. */
  compactTerminalOverQuota(config: PostDeliveryQuotaConfig): Promise<number>
  /** Rolls expired receipts into aggregates before removing their rows. */
  pruneTerminalReceipts(before: number): Promise<number>
  /**
   * Atomically terminalizes matching active rows and compacts their payloads.
   * Implementations retain the exact permanent reason in each receipt.
   */
  terminalizeExecutable(input: {
    executable: PluginExecutableIdentity
    reason: 'superseded' | 'uninstalled'
    at: number
  }): Promise<number>
  terminalizePlugin(input: {
    pluginId: string
    reason: 'disabled' | 'uninstalled' | 'quarantined'
    at: number
  }): Promise<number>
  terminalizePermissionRevoked(input: {
    pluginId: string
    revokedPermissions: readonly string[]
    at: number
  }): Promise<number>
}

export interface PostDeliveryRetentionOptions {
  repository: PostDeliveryRetentionRepository
  config?: Partial<PostDeliveryQuotaConfig>
  observability?: PostDeliveryObservability
  clock?: Pick<PostDeliveryClock, 'now'>
}

export class PostDeliveryRetention {
  private readonly config: PostDeliveryQuotaConfig
  private readonly observability: PostDeliveryObservability
  private readonly clock: Pick<PostDeliveryClock, 'now'>

  constructor(private readonly options: PostDeliveryRetentionOptions) {
    this.config = PostDeliveryQuotaConfigSchema.parse(options.config ?? {})
    this.observability =
      options.observability ?? NOOP_POST_DELIVERY_OBSERVABILITY
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  async reconcile(): Promise<PostDeliveryLedgerSnapshot> {
    return this.repositoryCall('reconcileLedger', () =>
      this.options.repository.reconcileLedger()
    )
  }

  async maintain(
    now: number,
    terminalRetentionMs: number
  ): Promise<{
    compacted: number
    pruned: number
  }> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('now must be a non-negative safe integer')
    }
    if (
      !Number.isSafeInteger(terminalRetentionMs) ||
      terminalRetentionMs < 24 * 60 * 60_000 ||
      terminalRetentionMs > 90 * 24 * 60 * 60_000
    ) {
      throw new RangeError('terminal retention must be between 1 and 90 days')
    }
    const compacted = await this.repositoryCall(
      'compactTerminalOverQuota',
      () => this.options.repository.compactTerminalOverQuota(this.config)
    )
    const pruned = await this.repositoryCall('pruneTerminalReceipts', () =>
      this.options.repository.pruneTerminalReceipts(now - terminalRetentionMs)
    )
    return { compacted, pruned }
  }

  async supersede(
    executable: PluginExecutableIdentity,
    at: number
  ): Promise<number> {
    return this.terminalize(
      executable.pluginId,
      'superseded',
      'terminalizeExecutable',
      () =>
        this.options.repository.terminalizeExecutable({
          executable,
          reason: 'superseded',
          at,
        }),
      at
    )
  }

  async pluginUnavailable(
    pluginId: string,
    reason: 'disabled' | 'uninstalled' | 'quarantined',
    at: number
  ): Promise<number> {
    return this.terminalize(
      pluginId,
      reason,
      'terminalizePlugin',
      () => this.options.repository.terminalizePlugin({ pluginId, reason, at }),
      at
    )
  }

  async permissionRevoked(
    pluginId: string,
    revokedPermissions: readonly string[],
    at: number
  ): Promise<number> {
    return this.terminalize(
      pluginId,
      'permission_revoked',
      'terminalizePermissionRevoked',
      () =>
        this.options.repository.terminalizePermissionRevoked({
          pluginId,
          revokedPermissions: [...new Set(revokedPermissions)].sort(),
          at,
        }),
      at
    )
  }

  private async terminalize(
    pluginId: string,
    reason: PostDeliveryPermanentReason,
    operation: string,
    transition: () => Promise<number>,
    at: number,
    hook?: PostHookName
  ): Promise<number> {
    const affectedRows = await this.repositoryCall(operation, transition)
    safeObserve(this.observability, {
      type: 'plugin.post.lifecycle_terminal',
      at,
      pluginId,
      hook,
      affectedRows,
      reason,
    })
    return affectedRows
  }

  private async repositoryCall<T>(
    operation: string,
    run: () => Promise<T>
  ): Promise<T> {
    try {
      return await run()
    } catch (error) {
      safeObserve(this.observability, {
        type: 'plugin.post.storage_error',
        at: this.clock.now(),
        operation,
        errorCode: 'plugin.post.storage_error',
      })
      throw error
    }
  }
}
