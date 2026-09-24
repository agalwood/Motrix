import { createHash } from 'node:crypto'
import {
  type AtomicPostDeliveryAdmissionResult,
  compactTerminalReceipt,
  POST_DELIVERY_DAILY_BUCKETS_PER_REASON,
  POST_DELIVERY_GLOBAL_TOMBSTONE_BUCKETS,
  type PostDeliveryAdmissionTransaction,
  type PostDeliveryLedgerSnapshot,
  type PostDeliveryRetentionRepository,
} from '@core/plugin/post/delivery-retention'
import {
  type BreakerFailureInput,
  type ClaimPostDeliveryInput,
  type CompletePostDeliveryInput,
  DEFAULT_POST_DELIVERY_QUOTA_CONFIG,
  type DeadLetterPostDeliveryInput,
  type PluginExecutableIdentity,
  POST_DELIVERY_CORE_RESERVE_BYTES,
  POST_DELIVERY_HARD_BUDGET_BYTES,
  POST_DELIVERY_ROW_CHARGE_BYTES,
  type PostDeliveryAdmission,
  type PostDeliveryAdmissionReason,
  type PostDeliveryBreakerPermit,
  type PostDeliveryBreakerState,
  type PostDeliveryClaim,
  type PostDeliveryPermanentReason,
  type PostDeliveryQuotaConfig,
  PostDeliveryQuotaConfigSchema,
  type PostDeliveryRecord,
  type PostDeliveryRepository,
  type RetryPostDeliveryInput,
} from '@core/plugin/post/delivery-types'
import type Database from 'better-sqlite3'

const GLOBAL_SCOPE = 'global'
const ACTIVE_STATUSES = "'pending','delivering'"
const TERMINAL_STATUSES = "'delivered','dead_letter','superseded'"
const DEFAULT_DATABASE_CAPACITY_BYTES =
  POST_DELIVERY_HARD_BUDGET_BYTES + POST_DELIVERY_CORE_RESERVE_BYTES
const POST_STORAGE_NAMES = [
  'plugin_post_deliveries',
  'idx_plugin_post_deliveries_claim',
  'idx_plugin_post_deliveries_task',
  'plugin_post_breakers',
  'plugin_post_quota_ledger',
  'plugin_post_quota_buckets',
  'idx_plugin_post_quota_buckets_rollup',
] as const

export interface PostDeliveryDatabaseCapacity {
  databaseCapacityBytes: number
  coreLogicalBytes: number
}

interface LedgerRow {
  active_rows: number
  active_bytes: number
  terminal_rows: number
  terminal_bytes: number
}

interface RawDeliveryRow {
  delivery_id: string
  deduplication_key: string
  occurrence_id: string
  hook: 'afterComplete' | 'onError'
  task_id: string
  occurred_at: number
  plugin_id: string
  plugin_version: string
  executable_digest: string
  created_generation: number
  effective_permissions_json: string
  required_permissions_json: string
  payload_json: string
  payload_bytes: number
  reserved_bytes: number
  compact: 0 | 1
  status: 'pending' | 'delivering' | 'delivered' | 'dead_letter' | 'superseded'
  attempt_count: number
  next_attempt_at: number
  lease_owner: string | null
  lease_expires_at: number | null
  permanent_reason: PostDeliveryPermanentReason | null
  created_at: number
  updated_at: number
  delivered_at: number | null
  receipt_invocation_id: string | null
  last_error_code: string | null
  last_error_message: string | null
}

interface RawBreakerRow {
  plugin_id: string
  state: 'closed' | 'open' | 'half_open'
  failure_count: number
  window_started_at: number | null
  open_until: number | null
  probe_token: string | null
  probe_lease_expires_at: number | null
}

export interface PostDeliveryAdmissionResult {
  admitted: number
  deduplicated: number
  rejected: number
}

/**
 * SQLite implementation of both durable post-Hook repository contracts.
 * Every state transition and its quota/breaker accounting share one
 * better-sqlite3 transaction. The `admitManyInCurrentTransaction` entry point
 * intentionally does not start a transaction: callers use it from the task
 * terminal transaction so the task, occurrence, and candidate decisions are
 * one commit boundary.
 */
export class SqlitePostDeliveryRepository
  implements
    PostDeliveryRepository,
    PostDeliveryRetentionRepository,
    PostDeliveryAdmissionTransaction
{
  private quota: PostDeliveryQuotaConfig
  private readonly capacity: () => PostDeliveryDatabaseCapacity

  constructor(
    private readonly db: Database.Database,
    quota: PostDeliveryQuotaConfig = DEFAULT_POST_DELIVERY_QUOTA_CONFIG,
    private readonly now: () => number = Date.now,
    capacity?: () => PostDeliveryDatabaseCapacity
  ) {
    this.quota = PostDeliveryQuotaConfigSchema.parse(quota)
    this.capacity = capacity ?? (() => this.readDatabaseCapacity())
  }

  setQuotaConfig(quota: PostDeliveryQuotaConfig): void {
    this.quota = PostDeliveryQuotaConfigSchema.parse(quota)
  }

  admitMany(
    admissions: readonly PostDeliveryAdmission[]
  ): PostDeliveryAdmissionResult {
    return this.db.transaction(() =>
      this.admitManyInCurrentTransaction(admissions)
    )()
  }

  admitManyInCurrentTransaction(
    admissions: readonly PostDeliveryAdmission[]
  ): PostDeliveryAdmissionResult {
    const result: PostDeliveryAdmissionResult = {
      admitted: 0,
      deduplicated: 0,
      rejected: 0,
    }
    for (const admission of admissions) {
      const decision = this.admitOrTombstone(admission, this.quota)
      if (decision.kind === 'admitted') result.admitted += 1
      else if (decision.kind === 'duplicate') result.deduplicated += 1
      else result.rejected += 1
    }
    return result
  }

  admitOrTombstone(
    admission: PostDeliveryAdmission,
    config: PostDeliveryQuotaConfig
  ): AtomicPostDeliveryAdmissionResult {
    const quota = PostDeliveryQuotaConfigSchema.parse(config)
    if (this.deliveryExists(admission.deliveryId, admission.deduplicationKey)) {
      return { kind: 'duplicate', deliveryId: admission.deliveryId }
    }
    const reason = this.admissionRejection(admission, quota)
    if (reason) {
      const tombstoneKey = this.recordTombstone(admission, reason)
      return {
        kind: 'rejected',
        deliveryId: admission.deliveryId,
        reason,
        tombstoneKey,
      }
    }
    this.insertAdmission(admission)
    return { kind: 'admitted', deliveryId: admission.deliveryId }
  }

  async recoverExpiredLeases(now: number): Promise<{
    deliveries: number
    breakerProbes: number
  }> {
    return this.db.transaction(() => {
      const deliveries = this.db
        .prepare(
          `UPDATE plugin_post_deliveries
           SET status='pending', lease_owner=NULL, lease_expires_at=NULL,
               next_attempt_at=?, updated_at=?
           WHERE status='delivering' AND lease_expires_at <= ?`
        )
        .run(now, now, now).changes
      const breakerProbes = this.db
        .prepare(
          `UPDATE plugin_post_breakers
           SET state='open', open_until=?, probe_token=NULL,
               probe_lease_expires_at=NULL, updated_at=?
           WHERE state='half_open' AND probe_lease_expires_at <= ?`
        )
        .run(now, now, now).changes
      return { deliveries, breakerProbes }
    })()
  }

  async listClaimablePluginIds(now: number): Promise<readonly string[]> {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT plugin_id
           FROM plugin_post_deliveries
           WHERE status='pending' AND next_attempt_at <= ?
           ORDER BY plugin_id`
        )
        .all(now) as Array<{ plugin_id: string }>
    ).map((row) => row.plugin_id)
  }

  async claimNextForPlugin(
    input: ClaimPostDeliveryInput
  ): Promise<PostDeliveryClaim | undefined> {
    return this.db.transaction(() => {
      let raw: RawDeliveryRow | undefined
      for (;;) {
        raw = this.db
          .prepare(
            `SELECT * FROM plugin_post_deliveries
             WHERE plugin_id=? AND status='pending' AND next_attempt_at <= ?
             ORDER BY created_at, delivery_id LIMIT 1`
          )
          .get(input.pluginId, input.now) as RawDeliveryRow | undefined
        if (!raw) return undefined
        const terminalReason =
          raw.attempt_count >= input.maxAttempts
            ? 'attempt_limit'
            : input.now - raw.created_at >= input.maxActiveAgeMs
              ? 'age_limit'
              : undefined
        if (!terminalReason) break
        this.terminalizeRow(raw, terminalReason, input.now, {
          errorCode: `plugin.post.${terminalReason}`,
        })
        this.enforceTerminalQuotas(this.quota, input.now, raw.plugin_id)
      }
      const changed = this.db
        .prepare(
          `UPDATE plugin_post_deliveries
           SET status='delivering', attempt_count=attempt_count+1,
               lease_owner=?, lease_expires_at=?, updated_at=?
           WHERE delivery_id=? AND status='pending'`
        )
        .run(
          input.leaseToken,
          input.leaseExpiresAt,
          input.now,
          raw.delivery_id
        ).changes
      if (changed !== 1) return undefined
      try {
        const claimed = this.readDelivery(raw.delivery_id)
        return claimed?.status === 'delivering'
          ? (claimed as PostDeliveryClaim)
          : undefined
      } catch {
        const corrupt = this.readRawDelivery(raw.delivery_id)
        if (corrupt) {
          this.terminalizeRow(corrupt, 'input_invalid', input.now, {
            errorCode: 'plugin.post.persisted_input_invalid',
          })
          this.enforceTerminalQuotas(this.quota, input.now, corrupt.plugin_id)
        }
        return undefined
      }
    })()
  }

  async acquireBreakerPermit(
    pluginId: string,
    now: number,
    token: string,
    leaseExpiresAt: number
  ): Promise<PostDeliveryBreakerPermit | undefined> {
    return this.db.transaction(() => {
      const row = this.readBreaker(pluginId)
      if (!row || row.state === 'closed') {
        return { mode: 'closed' as const, token }
      }
      if (row.state === 'half_open') {
        if ((row.probe_lease_expires_at ?? Number.MAX_SAFE_INTEGER) > now) {
          return undefined
        }
        this.db
          .prepare(
            `UPDATE plugin_post_breakers
             SET state='open', open_until=?, probe_token=NULL,
                 probe_lease_expires_at=NULL, updated_at=?
             WHERE plugin_id=?`
          )
          .run(now, now, pluginId)
      } else if ((row.open_until ?? Number.MAX_SAFE_INTEGER) > now) {
        return undefined
      }
      const changed = this.db
        .prepare(
          `UPDATE plugin_post_breakers
           SET state='half_open', open_until=NULL, probe_token=?,
               probe_lease_expires_at=?, updated_at=?
           WHERE plugin_id=? AND state='open' AND open_until <= ?`
        )
        .run(token, leaseExpiresAt, now, pluginId, now).changes
      return changed === 1 ? { mode: 'half_open' as const, token } : undefined
    })()
  }

  async releaseBreakerPermit(
    pluginId: string,
    permit: PostDeliveryBreakerPermit
  ): Promise<void> {
    if (permit.mode !== 'half_open') return
    this.db
      .prepare(
        `UPDATE plugin_post_breakers
         SET state='open', open_until=updated_at, probe_token=NULL,
             probe_lease_expires_at=NULL
         WHERE plugin_id=? AND state='half_open' AND probe_token=?`
      )
      .run(pluginId, permit.token)
  }

  async complete(
    input: CompletePostDeliveryInput,
    breaker: {
      pluginId: string
      permit: PostDeliveryBreakerPermit
      now: number
    }
  ): Promise<boolean> {
    return this.db.transaction(() => {
      if (!this.breakerPermitIsCurrent(breaker.pluginId, breaker.permit)) {
        return false
      }
      const row = this.readRawDelivery(input.deliveryId)
      if (!this.ownsLease(row, input.leaseToken)) return false
      const receipt = compactTerminalReceipt({
        deliveryId: row.delivery_id,
        pluginId: row.plugin_id,
        hook: row.hook,
        status: 'delivered',
        completedAt: input.receipt.completedAt,
        attemptCount: row.attempt_count,
      })
      const bytes =
        Buffer.byteLength(receipt, 'utf8') +
        Buffer.byteLength('[][]', 'utf8') +
        POST_DELIVERY_ROW_CHARGE_BYTES
      this.ensureTerminalCapacity(row.plugin_id, bytes, this.quota, breaker.now)
      const changed = this.db
        .prepare(
          `UPDATE plugin_post_deliveries
           SET status='delivered', payload_json=?, payload_bytes=?, reserved_bytes=?, compact=1,
               effective_permissions_json='[]', required_permissions_json='[]',
               lease_owner=NULL, lease_expires_at=NULL, permanent_reason=NULL,
               delivered_at=?, receipt_invocation_id=?, last_error_code=NULL,
               last_error_message=NULL, updated_at=?
           WHERE delivery_id=? AND status='delivering' AND lease_owner=?`
        )
        .run(
          receipt,
          Buffer.byteLength(receipt, 'utf8'),
          bytes,
          input.receipt.completedAt,
          input.receipt.invocationId,
          breaker.now,
          input.deliveryId,
          input.leaseToken
        ).changes
      if (changed !== 1) return false
      this.moveActiveToTerminal(
        row.plugin_id,
        this.reservedBytes(row),
        bytes,
        breaker.now
      )
      this.closeBreaker(breaker.pluginId, breaker.permit, breaker.now)
      this.enforceTerminalQuotas(this.quota, breaker.now, row.plugin_id)
      return true
    })()
  }

  async retry(
    input: RetryPostDeliveryInput,
    breaker: BreakerFailureInput
  ): Promise<{ updated: boolean; breaker: PostDeliveryBreakerState }> {
    return this.db.transaction(() => {
      if (!this.breakerPermitIsCurrent(breaker.pluginId, breaker.permit)) {
        return { updated: false, breaker: this.breakerState(breaker.pluginId) }
      }
      const changed = this.db
        .prepare(
          `UPDATE plugin_post_deliveries
           SET status='pending', lease_owner=NULL, lease_expires_at=NULL,
               next_attempt_at=?, last_error_code=?, last_error_message=?,
               updated_at=?
           WHERE delivery_id=? AND status='delivering' AND lease_owner=?`
        )
        .run(
          input.nextAttemptAt,
          input.errorCode,
          truncate(input.errorMessage, 1024),
          input.failedAt,
          input.deliveryId,
          input.leaseToken
        ).changes
      if (changed !== 1) {
        return { updated: false, breaker: this.breakerState(breaker.pluginId) }
      }
      const state = this.recordBreakerFailure(breaker)
      return { updated: true, breaker: state }
    })()
  }

  async deadLetter(
    input: DeadLetterPostDeliveryInput,
    breaker: { pluginId: string; permit: PostDeliveryBreakerPermit }
  ): Promise<boolean> {
    return this.db.transaction(() => {
      if (!this.breakerPermitIsCurrent(breaker.pluginId, breaker.permit)) {
        return false
      }
      const row = this.readRawDelivery(input.deliveryId)
      if (!this.ownsLease(row, input.leaseToken)) return false
      this.terminalizeRow(
        row,
        input.reason,
        input.completedAt,
        {
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
        },
        input.terminalStatus
      )
      this.closeBreaker(breaker.pluginId, breaker.permit, input.completedAt)
      this.enforceTerminalQuotas(this.quota, input.completedAt, row.plugin_id)
      return true
    })()
  }

  async reconcileLedger(): Promise<PostDeliveryLedgerSnapshot> {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM plugin_post_quota_ledger').run()
      const now = this.now()
      const rows = this.db
        .prepare(
          `SELECT plugin_id, status, reserved_bytes
           FROM plugin_post_deliveries`
        )
        .all() as Array<{
        plugin_id: string
        status: RawDeliveryRow['status']
        reserved_bytes: number
      }>
      for (const row of rows) {
        const bytes = row.reserved_bytes
        const terminal = isTerminalStatus(row.status)
        this.bumpLedger(
          row.plugin_id,
          terminal ? 0 : 1,
          terminal ? 0 : bytes,
          terminal ? 1 : 0,
          terminal ? bytes : 0,
          now
        )
      }
      const global = this.ledger(GLOBAL_SCOPE)
      const tombstones = this.tombstoneUsage()
      return {
        activeRows: global.active_rows,
        activeBytes: global.active_bytes,
        terminalRows: global.terminal_rows,
        terminalBytes: global.terminal_bytes,
        tombstoneRows: tombstones.rows,
        tombstoneBytes: tombstones.bytes,
      }
    })()
  }

  async compactTerminalOverQuota(
    config: PostDeliveryQuotaConfig
  ): Promise<number> {
    const parsed = PostDeliveryQuotaConfigSchema.parse(config)
    return this.db.transaction(() => {
      const before = this.terminalRowCount()
      const pluginIds = (
        this.db
          .prepare(
            `SELECT DISTINCT plugin_id FROM plugin_post_deliveries
             WHERE status IN (${TERMINAL_STATUSES})`
          )
          .all() as Array<{ plugin_id: string }>
      ).map((row) => row.plugin_id)
      const now = this.now()
      for (const pluginId of pluginIds) {
        this.enforceTerminalQuotas(parsed, now, pluginId)
      }
      return before - this.terminalRowCount()
    })()
  }

  async pruneTerminalReceipts(before: number): Promise<number> {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM plugin_post_deliveries
           WHERE status IN (${TERMINAL_STATUSES}) AND updated_at < ?
           ORDER BY updated_at, delivery_id`
        )
        .all(before) as RawDeliveryRow[]
      for (const row of rows)
        this.pruneTerminalRow(row, 'terminal_expired', before)
      return rows.length
    })()
  }

  async terminalizeExecutable(input: {
    executable: PluginExecutableIdentity
    reason: 'superseded' | 'uninstalled'
    at: number
  }): Promise<number> {
    return this.terminalizeWhere(
      `plugin_id=? AND plugin_version=? AND executable_digest=?`,
      [
        input.executable.pluginId,
        input.executable.version,
        input.executable.digest,
      ],
      input.reason,
      input.at
    )
  }

  async terminalizePlugin(input: {
    pluginId: string
    reason: 'disabled' | 'uninstalled' | 'quarantined'
    at: number
  }): Promise<number> {
    return this.terminalizeWhere(
      'plugin_id=?',
      [input.pluginId],
      input.reason,
      input.at
    )
  }

  async terminalizePermissionRevoked(input: {
    pluginId: string
    revokedPermissions: readonly string[]
    at: number
  }): Promise<number> {
    const revoked = new Set(input.revokedPermissions)
    return this.db.transaction(() => {
      const rows = this.activeRows('plugin_id=?', [input.pluginId])
      let count = 0
      for (const row of rows) {
        const required = parseStringArray(row.required_permissions_json)
        if (!required.some((permission) => revoked.has(permission))) continue
        this.terminalizeRow(row, 'permission_revoked', input.at)
        count += 1
      }
      this.enforceTerminalQuotas(this.quota, input.at, input.pluginId)
      return count
    })()
  }

  private terminalizeWhere(
    predicate: string,
    params: readonly unknown[],
    reason: PostDeliveryPermanentReason,
    at: number
  ): Promise<number> {
    return Promise.resolve(
      this.db.transaction(() => {
        const rows = this.activeRows(predicate, params)
        for (const row of rows) this.terminalizeRow(row, reason, at)
        for (const pluginId of new Set(rows.map((row) => row.plugin_id))) {
          this.enforceTerminalQuotas(this.quota, at, pluginId)
        }
        return rows.length
      })()
    )
  }

  private activeRows(
    predicate: string,
    params: readonly unknown[]
  ): RawDeliveryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM plugin_post_deliveries
         WHERE status IN (${ACTIVE_STATUSES}) AND ${predicate}
         ORDER BY created_at, delivery_id`
      )
      .all(...params) as RawDeliveryRow[]
  }

  private terminalizeRow(
    row: RawDeliveryRow,
    reason: PostDeliveryPermanentReason,
    at: number,
    error?: { errorCode?: string; errorMessage?: string },
    terminalStatus: 'dead_letter' | 'superseded' = reason === 'superseded'
      ? 'superseded'
      : 'dead_letter'
  ): void {
    const receipt = compactTerminalReceipt({
      deliveryId: row.delivery_id,
      pluginId: row.plugin_id,
      hook: row.hook,
      status: terminalStatus,
      completedAt: at,
      attemptCount: row.attempt_count,
      reason,
    })
    const payloadBytes = Buffer.byteLength(receipt, 'utf8')
    const terminalBytes =
      payloadBytes +
      Buffer.byteLength('[][]', 'utf8') +
      POST_DELIVERY_ROW_CHARGE_BYTES
    this.ensureTerminalCapacity(row.plugin_id, terminalBytes, this.quota, at)
    const changed = this.db
      .prepare(
        `UPDATE plugin_post_deliveries
         SET status=?, payload_json=?, payload_bytes=?, reserved_bytes=?, compact=1,
             effective_permissions_json='[]', required_permissions_json='[]',
             lease_owner=NULL, lease_expires_at=NULL, permanent_reason=?,
             delivered_at=NULL, receipt_invocation_id=NULL,
             last_error_code=?, last_error_message=?, updated_at=?
         WHERE delivery_id=? AND status IN (${ACTIVE_STATUSES})`
      )
      .run(
        terminalStatus,
        receipt,
        payloadBytes,
        terminalBytes,
        reason,
        error?.errorCode ?? null,
        truncate(error?.errorMessage, 1024),
        at,
        row.delivery_id
      ).changes
    if (changed === 1) {
      this.moveActiveToTerminal(
        row.plugin_id,
        this.reservedBytes(row),
        terminalBytes,
        at
      )
    }
  }

  private admissionRejection(
    admission: PostDeliveryAdmission,
    quota: PostDeliveryQuotaConfig
  ): PostDeliveryAdmissionReason | undefined {
    const incomingBytes =
      admission.initialStatus === 'dead_letter'
        ? this.initialTerminalReceipt(admission).reservedBytes
        : admission.reservedBytes
    const plugin = this.ledger(this.pluginScope(admission.executable.pluginId))
    const global = this.ledger(GLOBAL_SCOPE)
    if (
      admission.initialStatus === 'pending' &&
      plugin.active_rows + 1 > quota.pluginActiveRows
    ) {
      return 'plugin_active_rows'
    }
    if (
      admission.initialStatus === 'pending' &&
      plugin.active_bytes + incomingBytes > quota.pluginActiveBytes
    ) {
      return 'plugin_active_bytes'
    }
    if (
      admission.initialStatus === 'pending' &&
      global.active_rows + 1 > quota.globalActiveRows
    ) {
      return 'global_active_rows'
    }
    if (
      admission.initialStatus === 'pending' &&
      global.active_bytes + incomingBytes > quota.globalActiveBytes
    ) {
      return 'global_active_bytes'
    }
    if (
      global.active_bytes + global.terminal_bytes + incomingBytes >
      POST_DELIVERY_HARD_BUDGET_BYTES
    ) {
      return 'post_hard_budget'
    }
    const tombstones = this.tombstoneUsage()
    const postLogicalBytes =
      global.active_bytes + global.terminal_bytes + tombstones.bytes
    const capacity = this.capacity()
    if (
      !Number.isSafeInteger(capacity.databaseCapacityBytes) ||
      !Number.isSafeInteger(capacity.coreLogicalBytes) ||
      capacity.databaseCapacityBytes < 0 ||
      capacity.coreLogicalBytes < 0
    ) {
      throw new TypeError('post-delivery database capacity is invalid')
    }
    const bytesAvailableToPost = Math.max(
      0,
      capacity.databaseCapacityBytes -
        capacity.coreLogicalBytes -
        POST_DELIVERY_CORE_RESERVE_BYTES
    )
    if (
      postLogicalBytes + incomingBytes > bytesAvailableToPost ||
      postLogicalBytes + incomingBytes > POST_DELIVERY_HARD_BUDGET_BYTES
    ) {
      return 'post_hard_budget'
    }
    return undefined
  }

  private insertAdmission(admission: PostDeliveryAdmission): void {
    let payload = admission.canonicalPayload
    let payloadBytes = admission.payloadBytes
    let effectivePermissionsJson = JSON.stringify(
      admission.createdEffectivePermissions
    )
    let requiredPermissionsJson = JSON.stringify(admission.requiredPermissions)
    const permissionSnapshotBytes = Buffer.byteLength(
      effectivePermissionsJson + requiredPermissionsJson,
      'utf8'
    )
    if (
      permissionSnapshotBytes !== admission.permissionSnapshotBytes ||
      admission.payloadBytes +
        permissionSnapshotBytes +
        POST_DELIVERY_ROW_CHARGE_BYTES !==
        admission.reservedBytes
    ) {
      throw new TypeError(
        'post-delivery reservation does not match canonical bytes'
      )
    }
    const status = admission.initialStatus
    const permanentReason = admission.initialReason ?? null
    if (status === 'dead_letter') {
      const terminal = this.initialTerminalReceipt(admission)
      payload = terminal.payload
      payloadBytes = terminal.payloadBytes
      effectivePermissionsJson = '[]'
      requiredPermissionsJson = '[]'
    }
    const bytes =
      payloadBytes +
      Buffer.byteLength(
        effectivePermissionsJson + requiredPermissionsJson,
        'utf8'
      ) +
      POST_DELIVERY_ROW_CHARGE_BYTES
    if (status === 'dead_letter') {
      this.ensureTerminalCapacity(
        admission.executable.pluginId,
        bytes,
        this.quota,
        admission.createdAt
      )
    }
    this.db
      .prepare(
        `INSERT INTO plugin_post_deliveries (
          delivery_id, deduplication_key, occurrence_id, hook, task_id,
          occurred_at, plugin_id, plugin_version, executable_digest,
          created_generation, effective_permissions_json,
          required_permissions_json, payload_json, payload_bytes,
          reserved_bytes, compact,
          status, attempt_count, next_attempt_at, lease_owner,
          lease_expires_at, permanent_reason, created_at, updated_at,
          delivered_at, receipt_invocation_id, last_error_code,
          last_error_message
        ) VALUES (
          ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?
        )`
      )
      .run(
        admission.deliveryId,
        admission.deduplicationKey,
        admission.occurrenceId,
        admission.hook,
        admission.taskId,
        admission.occurredAt,
        admission.executable.pluginId,
        admission.executable.version,
        admission.executable.digest,
        admission.createdGeneration,
        effectivePermissionsJson,
        requiredPermissionsJson,
        payload,
        payloadBytes,
        bytes,
        status === 'dead_letter' ? 1 : 0,
        status,
        0,
        admission.createdAt,
        null,
        null,
        permanentReason,
        admission.createdAt,
        admission.createdAt,
        null,
        null,
        admission.initialErrorCode ?? null,
        null
      )
    this.bumpLedger(
      admission.executable.pluginId,
      status === 'pending' ? 1 : 0,
      status === 'pending' ? bytes : 0,
      status === 'dead_letter' ? 1 : 0,
      status === 'dead_letter' ? bytes : 0,
      admission.createdAt
    )
    if (status === 'dead_letter') {
      this.enforceTerminalQuotas(
        this.quota,
        admission.createdAt,
        admission.executable.pluginId
      )
    }
  }

  private initialTerminalReceipt(admission: PostDeliveryAdmission): {
    payload: string
    payloadBytes: number
    reservedBytes: number
  } {
    const payload = compactTerminalReceipt({
      deliveryId: admission.deliveryId,
      pluginId: admission.executable.pluginId,
      hook: admission.hook,
      status: 'dead_letter',
      completedAt: admission.createdAt,
      attemptCount: 0,
      reason: admission.initialReason ?? 'input_invalid',
    })
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    return {
      payload,
      payloadBytes,
      reservedBytes:
        payloadBytes +
        Buffer.byteLength('[][]', 'utf8') +
        POST_DELIVERY_ROW_CHARGE_BYTES,
    }
  }

  private deliveryExists(
    deliveryId: string,
    deduplicationKey: string
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM plugin_post_deliveries
           WHERE delivery_id=? OR deduplication_key=?`
        )
        .get(deliveryId, deduplicationKey)
    )
  }

  private recordTombstone(
    admission: PostDeliveryAdmission,
    reason: PostDeliveryAdmissionReason | string
  ): string {
    const day = Math.floor(admission.createdAt / 86_400_000)
    const ordinaryKey = tombstoneKey(
      admission.executable.pluginId,
      admission.hook,
      reason,
      day
    )
    const alreadyExists = this.db
      .prepare('SELECT 1 FROM plugin_post_quota_buckets WHERE bucket_key=?')
      .get(ordinaryKey)
    if (!alreadyExists) {
      this.foldDailyTombstones(
        admission.executable.pluginId,
        reason,
        day,
        admission.createdAt
      )
    }
    const overflow =
      !alreadyExists && this.ensureTombstoneCapacity(admission.createdAt)
    const key = overflow
      ? tombstoneKey('__global__', 'all', 'bucket_overflow', -1)
      : ordinaryKey
    const targetPluginId = overflow
      ? '__global__'
      : admission.executable.pluginId
    const targetHook = overflow ? 'all' : admission.hook
    const targetReason = overflow ? 'bucket_overflow' : reason
    const targetDay = overflow ? -1 : day
    this.db
      .prepare(
        `INSERT INTO plugin_post_quota_buckets (
          bucket_key, plugin_id, hook, reason, bucket_day, rejected_count,
          first_occurrence_id, last_occurrence_id, first_at, last_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          rejected_count=rejected_count+1,
          first_occurrence_id=CASE
            WHEN excluded.first_at < first_at
            THEN excluded.first_occurrence_id ELSE first_occurrence_id END,
          last_occurrence_id=CASE
            WHEN excluded.last_at >= last_at
            THEN excluded.last_occurrence_id ELSE last_occurrence_id END,
          first_at=MIN(first_at, excluded.first_at),
          last_at=MAX(last_at, excluded.last_at)`
      )
      .run(
        key,
        targetPluginId,
        targetHook,
        targetReason,
        targetDay,
        admission.occurrenceId,
        admission.occurrenceId,
        admission.createdAt,
        admission.createdAt
      )
    return key
  }

  private foldDailyTombstones(
    pluginId: string,
    reason: string,
    _day: number,
    at: number
  ): void {
    const daily = this.db
      .prepare(
        `SELECT * FROM plugin_post_quota_buckets
         WHERE plugin_id=? AND reason=? AND bucket_day>=0
         ORDER BY bucket_day`
      )
      .all(pluginId, reason) as Array<{
      bucket_key: string
      hook: 'afterComplete' | 'onError' | 'all'
      rejected_count: number
      first_occurrence_id: string
      last_occurrence_id: string
      first_at: number
      last_at: number
    }>
    while (daily.length >= POST_DELIVERY_DAILY_BUCKETS_PER_REASON) {
      const oldest = daily.shift()
      if (!oldest) break
      this.mergeRollup(pluginId, reason, oldest, at)
      this.db
        .prepare('DELETE FROM plugin_post_quota_buckets WHERE bucket_key=?')
        .run(oldest.bucket_key)
    }
  }

  /** Returns true when the new rejection must fold into the global rollup. */
  private ensureTombstoneCapacity(at: number): boolean {
    const overflowKey = tombstoneKey('__global__', 'all', 'bucket_overflow', -1)
    for (;;) {
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM plugin_post_quota_buckets')
          .get() as { count: number }
      ).count
      if (count < POST_DELIVERY_GLOBAL_TOMBSTONE_BUCKETS) return false
      const oldest = this.db
        .prepare(
          `SELECT * FROM plugin_post_quota_buckets
           WHERE bucket_key<>? ORDER BY last_at, bucket_key LIMIT 1`
        )
        .get(overflowKey) as
        | {
            bucket_key: string
            rejected_count: number
            first_occurrence_id: string
            last_occurrence_id: string
            first_at: number
            last_at: number
          }
        | undefined
      if (!oldest) return true
      this.mergeRollup('__global__', 'bucket_overflow', oldest, at)
      this.db
        .prepare('DELETE FROM plugin_post_quota_buckets WHERE bucket_key=?')
        .run(oldest.bucket_key)
    }
  }

  private mergeRollup(
    pluginId: string,
    reason: string,
    row: {
      rejected_count: number
      first_occurrence_id: string
      last_occurrence_id: string
      first_at: number
      last_at: number
    },
    _at: number
  ): void {
    const key = tombstoneKey(pluginId, 'all', reason, -1)
    this.db
      .prepare(
        `INSERT INTO plugin_post_quota_buckets (
          bucket_key, plugin_id, hook, reason, bucket_day, rejected_count,
          first_occurrence_id, last_occurrence_id, first_at, last_at
        ) VALUES (?, ?, 'all', ?, -1, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET
          rejected_count=rejected_count+excluded.rejected_count,
          first_occurrence_id=CASE
            WHEN excluded.first_at < first_at
            THEN excluded.first_occurrence_id ELSE first_occurrence_id END,
          last_occurrence_id=CASE
            WHEN excluded.last_at >= last_at
            THEN excluded.last_occurrence_id ELSE last_occurrence_id END,
          first_at=MIN(first_at, excluded.first_at),
          last_at=MAX(last_at, excluded.last_at)`
      )
      .run(
        key,
        pluginId,
        reason,
        row.rejected_count,
        row.first_occurrence_id,
        row.last_occurrence_id,
        row.first_at,
        row.last_at
      )
  }

  private enforceTerminalQuotas(
    quota: PostDeliveryQuotaConfig,
    at: number,
    pluginId: string
  ): void {
    for (;;) {
      const plugin = this.ledger(this.pluginScope(pluginId))
      const global = this.ledger(GLOBAL_SCOPE)
      if (
        plugin.terminal_rows <= quota.pluginTerminalRows &&
        plugin.terminal_bytes <= quota.pluginTerminalBytes &&
        global.terminal_rows <= quota.globalTerminalRows &&
        global.terminal_bytes <= quota.globalTerminalBytes
      ) {
        return
      }
      const row = this.db
        .prepare(
          `SELECT * FROM plugin_post_deliveries
           WHERE status IN (${TERMINAL_STATUSES})
             AND (? OR plugin_id=?)
           ORDER BY updated_at, delivery_id LIMIT 1`
        )
        .get(
          global.terminal_rows > quota.globalTerminalRows ||
            global.terminal_bytes > quota.globalTerminalBytes
            ? 1
            : 0,
          pluginId
        ) as RawDeliveryRow | undefined
      if (!row) return
      this.pruneTerminalRow(row, 'terminal_quota_compacted', at)
    }
  }

  private ensureTerminalCapacity(
    pluginId: string,
    incomingBytes: number,
    quota: PostDeliveryQuotaConfig,
    at: number
  ): void {
    for (;;) {
      const plugin = this.ledger(this.pluginScope(pluginId))
      const global = this.ledger(GLOBAL_SCOPE)
      const globalExceeded =
        global.terminal_rows + 1 > quota.globalTerminalRows ||
        global.terminal_bytes + incomingBytes > quota.globalTerminalBytes
      const pluginExceeded =
        plugin.terminal_rows + 1 > quota.pluginTerminalRows ||
        plugin.terminal_bytes + incomingBytes > quota.pluginTerminalBytes
      if (!globalExceeded && !pluginExceeded) return
      const row = this.db
        .prepare(
          `SELECT * FROM plugin_post_deliveries
           WHERE status IN (${TERMINAL_STATUSES})
             AND (? OR plugin_id=?)
           ORDER BY updated_at, delivery_id LIMIT 1`
        )
        .get(globalExceeded ? 1 : 0, pluginId) as RawDeliveryRow | undefined
      if (!row) {
        throw new RangeError('terminal receipt cannot fit configured quota')
      }
      this.pruneTerminalRow(row, 'terminal_quota_compacted', at)
    }
  }

  private pruneTerminalRow(
    row: RawDeliveryRow,
    reason: string,
    at: number
  ): void {
    this.recordTombstone(
      {
        deliveryId: row.delivery_id,
        deduplicationKey: row.deduplication_key,
        hook: row.hook,
        executable: {
          pluginId: row.plugin_id,
          version: row.plugin_version,
          digest: row.executable_digest,
        },
        createdGeneration: row.created_generation,
        requiredPermissions: [],
        createdEffectivePermissions: [],
        occurrenceId: row.occurrence_id,
        taskId: row.task_id,
        occurredAt: row.occurred_at,
        canonicalPayload: '{}',
        payloadBytes: 2,
        permissionSnapshotBytes: 4,
        reservedBytes: 2 + 4 + POST_DELIVERY_ROW_CHARGE_BYTES,
        createdAt: at,
        initialStatus: 'dead_letter',
        initialReason: 'input_invalid',
      },
      reason
    )
    this.db
      .prepare('DELETE FROM plugin_post_deliveries WHERE delivery_id=?')
      .run(row.delivery_id)
    this.bumpLedger(row.plugin_id, 0, 0, -1, -this.reservedBytes(row), at)
  }

  private moveActiveToTerminal(
    pluginId: string,
    activeBytes: number,
    terminalBytes: number,
    at: number
  ): void {
    this.bumpLedger(pluginId, -1, -activeBytes, 1, terminalBytes, at)
  }

  private bumpLedger(
    pluginId: string,
    activeRows: number,
    activeBytes: number,
    terminalRows: number,
    terminalBytes: number,
    at: number
  ): void {
    for (const scope of [GLOBAL_SCOPE, this.pluginScope(pluginId)]) {
      this.ensureLedger(scope, at)
      this.db
        .prepare(
          `UPDATE plugin_post_quota_ledger SET
            active_rows=active_rows+?, active_bytes=active_bytes+?,
            terminal_rows=terminal_rows+?, terminal_bytes=terminal_bytes+?,
            updated_at=?
           WHERE scope_key=?`
        )
        .run(activeRows, activeBytes, terminalRows, terminalBytes, at, scope)
    }
  }

  private ensureLedger(scope: string, at: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO plugin_post_quota_ledger (
          scope_key, active_rows, active_bytes, terminal_rows, terminal_bytes,
          updated_at
        ) VALUES (?, 0, 0, 0, 0, ?)`
      )
      .run(scope, Math.max(1, at))
  }

  private tombstoneUsage(): { rows: number; bytes: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(
                  length(CAST(bucket_key AS BLOB)) +
                  length(CAST(plugin_id AS BLOB)) +
                  length(CAST(hook AS BLOB)) +
                  length(CAST(reason AS BLOB)) +
                  length(CAST(first_occurrence_id AS BLOB)) +
                  length(CAST(last_occurrence_id AS BLOB)) + 128
                ), 0) AS bytes
         FROM plugin_post_quota_buckets`
      )
      .get() as { rows: number; bytes: number }
  }

  private readDatabaseCapacity(): PostDeliveryDatabaseCapacity {
    const placeholders = POST_STORAGE_NAMES.map(() => '?').join(', ')
    const core = this.db
      .prepare(
        `SELECT COALESCE(SUM(pgsize), 0) AS bytes
         FROM dbstat
         WHERE name NOT IN (${placeholders})`
      )
      .get(...POST_STORAGE_NAMES) as { bytes: number }
    return {
      databaseCapacityBytes: DEFAULT_DATABASE_CAPACITY_BYTES,
      coreLogicalBytes: core.bytes,
    }
  }

  private ledger(scope: string): LedgerRow {
    return (
      (this.db
        .prepare(
          `SELECT active_rows, active_bytes, terminal_rows, terminal_bytes
           FROM plugin_post_quota_ledger WHERE scope_key=?`
        )
        .get(scope) as LedgerRow | undefined) ?? {
        active_rows: 0,
        active_bytes: 0,
        terminal_rows: 0,
        terminal_bytes: 0,
      }
    )
  }

  private pluginScope(pluginId: string): string {
    return `plugin:${pluginId}`
  }

  private readDelivery(deliveryId: string): PostDeliveryRecord | undefined {
    const row = this.readRawDelivery(deliveryId)
    if (!row) return undefined
    if (!row.compact && !isJsonObject(row.payload_json)) {
      throw new TypeError('persisted post-delivery payload is invalid')
    }
    return {
      deliveryId: row.delivery_id,
      deduplicationKey: row.deduplication_key,
      hook: row.hook,
      executable: {
        pluginId: row.plugin_id,
        version: row.plugin_version,
        digest: row.executable_digest,
      },
      createdGeneration: row.created_generation,
      requiredPermissions: parseStringArray(row.required_permissions_json),
      createdEffectivePermissions: parseStringArray(
        row.effective_permissions_json
      ),
      occurrenceId: row.occurrence_id,
      taskId: row.task_id,
      occurredAt: row.occurred_at,
      canonicalPayload: row.payload_json,
      payloadBytes: row.payload_bytes,
      permissionSnapshotBytes: Buffer.byteLength(
        row.effective_permissions_json + row.required_permissions_json,
        'utf8'
      ),
      reservedBytes: this.reservedBytes(row),
      createdAt: row.created_at,
      status: row.status,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      leaseToken: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
      terminalReason: row.permanent_reason ?? undefined,
    }
  }

  private readRawDelivery(deliveryId: string): RawDeliveryRow | undefined {
    return this.db
      .prepare('SELECT * FROM plugin_post_deliveries WHERE delivery_id=?')
      .get(deliveryId) as RawDeliveryRow | undefined
  }

  private reservedBytes(row: Pick<RawDeliveryRow, 'reserved_bytes'>): number {
    return row.reserved_bytes
  }

  private ownsLease(
    row: RawDeliveryRow | undefined,
    leaseToken: string
  ): row is RawDeliveryRow {
    return Boolean(
      row && row.status === 'delivering' && row.lease_owner === leaseToken
    )
  }

  private readBreaker(pluginId: string): RawBreakerRow | undefined {
    return this.db
      .prepare('SELECT * FROM plugin_post_breakers WHERE plugin_id=?')
      .get(pluginId) as RawBreakerRow | undefined
  }

  private breakerPermitIsCurrent(
    pluginId: string,
    permit: PostDeliveryBreakerPermit
  ): boolean {
    const row = this.readBreaker(pluginId)
    if (permit.mode === 'closed') return !row || row.state === 'closed'
    return row?.state === 'half_open' && row.probe_token === permit.token
  }

  private closeBreaker(
    pluginId: string,
    permit: PostDeliveryBreakerPermit,
    now: number
  ): void {
    if (!this.breakerPermitIsCurrent(pluginId, permit)) return
    this.db
      .prepare(
        `INSERT INTO plugin_post_breakers (
          plugin_id, state, failure_count, window_started_at, open_until,
          probe_token, probe_lease_expires_at, updated_at
        ) VALUES (?, 'closed', 0, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          state='closed', failure_count=0, window_started_at=NULL,
          open_until=NULL, probe_token=NULL, probe_lease_expires_at=NULL,
          updated_at=excluded.updated_at`
      )
      .run(pluginId, now)
  }

  private recordBreakerFailure(
    input: BreakerFailureInput
  ): PostDeliveryBreakerState {
    const current = this.readBreaker(input.pluginId)
    const halfOpenFailure = input.permit.mode === 'half_open'
    const withinWindow =
      current?.window_started_at !== null &&
      current?.window_started_at !== undefined &&
      input.now - current.window_started_at <= input.windowMs
    const failureCount = halfOpenFailure
      ? input.threshold
      : withinWindow
        ? (current?.failure_count ?? 0) + 1
        : 1
    const windowStartedAt = withinWindow
      ? (current?.window_started_at ?? input.now)
      : input.now
    const open = halfOpenFailure || failureCount >= input.threshold
    this.db
      .prepare(
        `INSERT INTO plugin_post_breakers (
          plugin_id, state, failure_count, window_started_at, open_until,
          probe_token, probe_lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          state=excluded.state, failure_count=excluded.failure_count,
          window_started_at=excluded.window_started_at,
          open_until=excluded.open_until, probe_token=NULL,
          probe_lease_expires_at=NULL, updated_at=excluded.updated_at`
      )
      .run(
        input.pluginId,
        open ? 'open' : 'closed',
        failureCount,
        windowStartedAt,
        open ? input.now + input.pauseMs : null,
        input.now
      )
    return this.breakerState(input.pluginId)
  }

  private breakerState(pluginId: string): PostDeliveryBreakerState {
    const row = this.readBreaker(pluginId)
    if (!row) return { pluginId, state: 'closed', failureCount: 0 }
    return {
      pluginId,
      state: row.state,
      failureCount: row.failure_count,
      windowStartedAt: row.window_started_at ?? undefined,
      openUntil: row.open_until ?? undefined,
      probeLeaseExpiresAt: row.probe_lease_expires_at ?? undefined,
    }
  }

  private terminalRowCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM plugin_post_deliveries
           WHERE status IN (${TERMINAL_STATUSES})`
        )
        .get() as { count: number }
    ).count
  }
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(
      'persisted post-delivery permission snapshot is invalid'
    )
  }
  return [...new Set(value)].sort()
}

function isJsonObject(json: string): boolean {
  const value: unknown = JSON.parse(json)
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isTerminalStatus(status: RawDeliveryRow['status']): boolean {
  return (
    status === 'delivered' ||
    status === 'dead_letter' ||
    status === 'superseded'
  )
}

function truncate(value: string | undefined, max: number): string | null {
  if (!value) return null
  return value.slice(0, max)
}

function tombstoneKey(
  pluginId: string,
  hook: 'afterComplete' | 'onError' | 'all',
  reason: string,
  day: number
): string {
  const raw = `${pluginId}:${hook}:${reason}:${day}`
  if (Buffer.byteLength(raw, 'utf8') <= 512) return raw
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
  return `hashed:${digest}`
}
