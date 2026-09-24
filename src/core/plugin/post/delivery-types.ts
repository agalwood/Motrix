import { z } from 'zod'

export const POST_DELIVERY_ROW_CHARGE_BYTES = 512
export const POST_DELIVERY_RECEIPT_MAX_BYTES = 1024
export const POST_DELIVERY_HARD_BUDGET_BYTES = 1024 * 1024 * 1024
export const POST_DELIVERY_CORE_RESERVE_BYTES = 128 * 1024 * 1024

export const postHookNames = ['afterComplete', 'onError'] as const
export type PostHookName = (typeof postHookNames)[number]

export const postDeliveryStatuses = [
  'pending',
  'delivering',
  'delivered',
  'dead_letter',
  'superseded',
] as const
export type PostDeliveryStatus = (typeof postDeliveryStatuses)[number]

export const postDeliveryPermanentReasons = [
  'input_invalid',
  'identity_missing',
  'superseded',
  'disabled',
  'uninstalled',
  'quarantined',
  'permission_revoked',
  'output_invalid',
  'attempt_limit',
  'age_limit',
] as const
export type PostDeliveryPermanentReason =
  (typeof postDeliveryPermanentReasons)[number]

export type PostDeliveryAdmissionReason =
  | 'plugin_active_rows'
  | 'plugin_active_bytes'
  | 'global_active_rows'
  | 'global_active_bytes'
  | 'post_hard_budget'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[]

export interface PluginExecutableIdentity {
  pluginId: string
  version: string
  digest: string
}

export interface PostDeliveryCandidateSnapshot {
  hook: PostHookName
  executable: PluginExecutableIdentity
  createdGeneration: number
  requiredPermissions: readonly string[]
  createdEffectivePermissions: readonly string[]
}

/**
 * A complete, already runtime-validated event. It deliberately contains no
 * task-store reference: delivery remains possible after the task is deleted.
 */
export interface PostDeliveryEventSnapshot {
  schemaVersion: 1
  occurrenceId: string
  taskId: string
  occurredAt: number
  /** Validated post-Hook fields except for the host-created delivery envelope. */
  payload: JsonValue
}

export interface PostDeliveryAdmission {
  deliveryId: string
  deduplicationKey: string
  hook: PostHookName
  executable: PluginExecutableIdentity
  createdGeneration: number
  requiredPermissions: readonly string[]
  createdEffectivePermissions: readonly string[]
  occurrenceId: string
  taskId: string
  occurredAt: number
  canonicalPayload: string
  payloadBytes: number
  permissionSnapshotBytes: number
  reservedBytes: number
  createdAt: number
  initialStatus: 'pending' | 'dead_letter'
  initialReason?: 'input_invalid'
  initialErrorCode?: string
}

export type PostDeliveryRecord = Omit<
  PostDeliveryAdmission,
  'initialStatus' | 'initialReason' | 'initialErrorCode'
> & {
  status: PostDeliveryStatus
  attemptCount: number
  nextAttemptAt: number
  leaseToken?: string
  leaseExpiresAt?: number
  terminalReason?: PostDeliveryPermanentReason
}

export type PostDeliveryClaim = PostDeliveryRecord & {
  status: 'delivering'
  leaseToken: string
  leaseExpiresAt: number
}

export interface PostDeliveryReceipt {
  deliveryId: string
  invocationId: string
  completedAt: number
}

export type PostDeliveryInvocationReceipt = Pick<
  PostDeliveryReceipt,
  'deliveryId' | 'invocationId'
>

export interface PostDeliveryTerminalReceipt {
  deliveryId: string
  pluginId: string
  hook: PostHookName
  status: 'delivered' | 'dead_letter' | 'superseded'
  completedAt: number
  attemptCount: number
  reason?: PostDeliveryPermanentReason
}

export interface PostDeliveryQuotaTombstone {
  pluginId: string
  hook: PostHookName
  reason: PostDeliveryAdmissionReason
  utcDay: string
  count: number
  firstOccurrenceId: string
  lastOccurrenceId: string
  firstRejectedAt: number
  lastRejectedAt: number
}

export interface PostDeliveryBreakerPermit {
  mode: 'closed' | 'half_open'
  token: string
}

export interface PostDeliveryBreakerState {
  pluginId: string
  state: 'closed' | 'open' | 'half_open'
  failureCount: number
  windowStartedAt?: number
  openUntil?: number
  probeLeaseExpiresAt?: number
}

export const PostDeliverySchedulerConfigSchema = z
  .object({
    leaseMs: z
      .number()
      .int()
      .min(30_000)
      .max(10 * 60_000)
      .default(120_000),
    claimBatch: z.number().int().min(1).max(256).default(64),
    globalWorkers: z.number().int().min(1).max(32).default(8),
    maxAttempts: z.number().int().min(1).max(32).default(12),
    maxActiveAgeMs: z
      .number()
      .int()
      .min(60 * 60_000)
      .max(30 * 24 * 60 * 60_000)
      .default(7 * 24 * 60 * 60_000),
    baseDelayMs: z.number().int().min(100).max(60_000).default(1_000),
    delayCapMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000)
      .default(60 * 60_000),
    terminalRetentionMs: z
      .number()
      .int()
      .min(24 * 60 * 60_000)
      .max(90 * 24 * 60 * 60_000)
      .default(30 * 24 * 60 * 60_000),
    breakerThreshold: z.number().int().min(1).max(100).default(5),
    breakerWindowMs: z
      .number()
      .int()
      .min(60_000)
      .max(60 * 60_000)
      .default(10 * 60_000),
    breakerPauseMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60_000)
      .default(15 * 60_000),
    pollIntervalMs: z.number().int().min(10).max(60_000).default(1_000),
  })
  .superRefine((value, ctx) => {
    if (value.delayCapMs < value.baseDelayMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayCapMs'],
        message: 'delayCapMs must not be below baseDelayMs',
      })
    }
  })

export type PostDeliverySchedulerConfig = z.infer<
  typeof PostDeliverySchedulerConfigSchema
>

export const DEFAULT_POST_DELIVERY_SCHEDULER_CONFIG =
  PostDeliverySchedulerConfigSchema.parse({})

export const PostDeliveryQuotaConfigSchema = z
  .object({
    pluginActiveRows: z.number().int().min(1).max(1_000).default(1_000),
    pluginActiveBytes: z
      .number()
      .int()
      .min(2 * 1024 * 1024)
      .max(64 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    globalActiveRows: z.number().int().min(1_000).max(10_000).default(10_000),
    globalActiveBytes: z
      .number()
      .int()
      .min(64 * 1024 * 1024)
      .max(512 * 1024 * 1024)
      .default(512 * 1024 * 1024),
    pluginTerminalRows: z.number().int().min(1).max(4_000).default(4_000),
    pluginTerminalBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(4 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    globalTerminalRows: z.number().int().min(4_000).max(40_000).default(40_000),
    globalTerminalBytes: z
      .number()
      .int()
      .min(4 * 1024 * 1024)
      .max(40 * 1024 * 1024)
      .default(40 * 1024 * 1024),
  })
  .superRefine((value, ctx) => {
    const pairs: ReadonlyArray<
      readonly [keyof typeof value, keyof typeof value]
    > = [
      ['globalActiveRows', 'pluginActiveRows'],
      ['globalActiveBytes', 'pluginActiveBytes'],
      ['globalTerminalRows', 'pluginTerminalRows'],
      ['globalTerminalBytes', 'pluginTerminalBytes'],
    ]
    for (const [globalKey, pluginKey] of pairs) {
      if (value[globalKey] < value[pluginKey]) {
        ctx.addIssue({
          code: 'custom',
          path: [globalKey],
          message: `${globalKey} must cover ${pluginKey}`,
        })
      }
    }
  })

export type PostDeliveryQuotaConfig = z.infer<
  typeof PostDeliveryQuotaConfigSchema
>

export const DEFAULT_POST_DELIVERY_QUOTA_CONFIG =
  PostDeliveryQuotaConfigSchema.parse({})

export interface PostDeliveryClock {
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

export interface PostDeliveryJitter {
  /** Returns a factor in the closed interval [0.75, 1.25]. */
  factor(): number
}

export interface PostDeliveryPolicyLease {
  currentGeneration: number
  currentEffectivePermissions: readonly string[]
  signal: AbortSignal
  release(): void | Promise<void>
}

export type PostDeliveryPolicyDecision =
  | { kind: 'authorized'; lease: PostDeliveryPolicyLease }
  | {
      kind: 'permanent'
      reason:
        | 'identity_missing'
        | 'superseded'
        | 'disabled'
        | 'uninstalled'
        | 'quarantined'
      message?: string
    }

export interface PostDeliveryPolicyProvider {
  /** Acquires the live generation lease; policy changes abort its signal. */
  acquire(record: PostDeliveryClaim): Promise<PostDeliveryPolicyDecision>
}

export interface PostDeliveryInvocationInput {
  record: PostDeliveryClaim
  invocationId: string
  permissionGeneration: number
  effectivePermissions: readonly string[]
  signal: AbortSignal
}

export type PostDeliveryInvocationResult =
  | { kind: 'success'; receipt: PostDeliveryInvocationReceipt }
  | {
      kind: 'failure'
      classification: 'retryable' | 'permanent'
      code: string
      message?: string
      permanentReason?: 'input_invalid' | 'output_invalid'
    }

export interface PostDeliveryPluginInvoker {
  /** Activates the recorded identity and enters the shared per-plugin lane. */
  invoke(
    input: PostDeliveryInvocationInput
  ): Promise<PostDeliveryInvocationResult>
}

export interface ClaimPostDeliveryInput {
  pluginId: string
  now: number
  leaseToken: string
  leaseExpiresAt: number
  maxAttempts: number
  maxActiveAgeMs: number
}

export interface RetryPostDeliveryInput {
  deliveryId: string
  leaseToken: string
  nextAttemptAt: number
  errorCode: string
  errorMessage?: string
  failedAt: number
}

export interface DeadLetterPostDeliveryInput {
  deliveryId: string
  leaseToken: string
  terminalStatus: 'dead_letter' | 'superseded'
  reason: PostDeliveryPermanentReason
  errorCode: string
  errorMessage?: string
  completedAt: number
}

export interface CompletePostDeliveryInput {
  deliveryId: string
  leaseToken: string
  receipt: PostDeliveryReceipt
}

export interface BreakerFailureInput {
  pluginId: string
  permit: PostDeliveryBreakerPermit
  now: number
  threshold: number
  windowMs: number
  pauseMs: number
}

export interface PostDeliveryRepository {
  /** Reclaims expired delivery and half-open probe leases after restart. */
  recoverExpiredLeases(now: number): Promise<{
    deliveries: number
    breakerProbes: number
  }>
  listClaimablePluginIds(now: number): Promise<readonly string[]>
  claimNextForPlugin(
    input: ClaimPostDeliveryInput
  ): Promise<PostDeliveryClaim | undefined>
  acquireBreakerPermit(
    pluginId: string,
    now: number,
    token: string,
    leaseExpiresAt: number
  ): Promise<PostDeliveryBreakerPermit | undefined>
  releaseBreakerPermit(
    pluginId: string,
    permit: PostDeliveryBreakerPermit
  ): Promise<void>
  complete(
    input: CompletePostDeliveryInput,
    breaker: {
      pluginId: string
      permit: PostDeliveryBreakerPermit
      now: number
    }
  ): Promise<boolean>
  retry(
    input: RetryPostDeliveryInput,
    breaker: BreakerFailureInput
  ): Promise<{ updated: boolean; breaker: PostDeliveryBreakerState }>
  deadLetter(
    input: DeadLetterPostDeliveryInput,
    breaker: { pluginId: string; permit: PostDeliveryBreakerPermit }
  ): Promise<boolean>
}

export function intersectPermissions(
  created: readonly string[],
  current: readonly string[]
): readonly string[] {
  const live = new Set(current)
  return [...new Set(created)]
    .filter((permission) => live.has(permission))
    .sort()
}

export function missingRequiredPermissions(
  required: readonly string[],
  effective: readonly string[]
): readonly string[] {
  const available = new Set(effective)
  return [...new Set(required)]
    .filter((permission) => !available.has(permission))
    .sort()
}

export function computeRetryDelayMs(
  attemptCount: number,
  config: Pick<PostDeliverySchedulerConfig, 'baseDelayMs' | 'delayCapMs'>,
  jitter: PostDeliveryJitter
): number {
  const factor = jitter.factor()
  if (!Number.isFinite(factor) || factor < 0.75 || factor > 1.25) {
    throw new RangeError('post-delivery jitter must be in [0.75, 1.25]')
  }
  const exponent = Math.max(0, attemptCount - 1)
  const exponential = config.baseDelayMs * 2 ** Math.min(exponent, 52)
  return Math.max(
    1,
    Math.round(Math.min(config.delayCapMs, exponential) * factor)
  )
}
