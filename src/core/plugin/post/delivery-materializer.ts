import { createHash } from 'node:crypto'
import {
  AfterCompleteContextV1Schema,
  HOOK_DTO_LIMITS,
  HookJsonValueSchema,
  OnErrorContextV1Schema,
} from '@shared/schemas/plugin-hooks'
import {
  type JsonValue,
  type PluginExecutableIdentity,
  POST_DELIVERY_ROW_CHARGE_BYTES,
  type PostDeliveryAdmission,
  type PostDeliveryCandidateSnapshot,
  type PostDeliveryEventSnapshot,
} from './delivery-types'

const MAX_OPAQUE_ID_BYTES = 128
const MAX_PLUGIN_ID_BYTES = 256
const MAX_VERSION_BYTES = 128
const MAX_PERMISSION_BYTES = 256
const MAX_PERMISSIONS = 256

export interface PostDeliveryMaterializationInput {
  event: PostDeliveryEventSnapshot
  candidates: readonly PostDeliveryCandidateSnapshot[]
  createdAt: number
}

export class PostDeliveryMaterializationError extends Error {
  constructor(
    readonly code: 'event_invalid',
    message: string
  ) {
    super(message)
    this.name = 'PostDeliveryMaterializationError'
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function canonicalJson(value: JsonValue): string {
  const ancestors = new Set<object>()

  const serialize = (candidate: unknown): string => {
    if (candidate === null || typeof candidate === 'boolean') {
      return JSON.stringify(candidate)
    }
    if (typeof candidate === 'string') return JSON.stringify(candidate)
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('canonical JSON rejects non-finite numbers')
      }
      return JSON.stringify(candidate)
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('canonical JSON accepts JSON values only')
    }
    if (ancestors.has(candidate)) {
      throw new TypeError('canonical JSON rejects cyclic values')
    }

    ancestors.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate.map((item) => serialize(item)).join(',')}]`
      }
      if (!isPlainObject(candidate)) {
        throw new TypeError('canonical JSON rejects non-plain objects')
      }
      const fields = Object.keys(candidate)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(candidate[key])}`)
      return `{${fields.join(',')}}`
    } finally {
      ancestors.delete(candidate)
    }
  }

  return serialize(value)
}

function requireBoundedText(
  value: string,
  field: string,
  maxBytes: number
): string {
  if (value.length === 0 || byteLength(value) > maxBytes) {
    throw new PostDeliveryMaterializationError(
      'event_invalid',
      `${field} must be non-empty and at most ${maxBytes} UTF-8 bytes`
    )
  }
  return value
}

function normalizeIdentity(identity: PluginExecutableIdentity): {
  executable: PluginExecutableIdentity
  valid: boolean
} {
  const pluginValid =
    typeof identity.pluginId === 'string' &&
    identity.pluginId.length > 0 &&
    byteLength(identity.pluginId) <= MAX_PLUGIN_ID_BYTES
  const versionValid =
    typeof identity.version === 'string' &&
    identity.version.length > 0 &&
    byteLength(identity.version) <= MAX_VERSION_BYTES
  const digestValid =
    typeof identity.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(identity.digest)
  if (pluginValid && versionValid && digestValid) {
    return { executable: identity, valid: true }
  }
  const rawIdentity = JSON.stringify({
    digest:
      typeof identity.digest === 'string' ? identity.digest : '<non-string>',
    pluginId:
      typeof identity.pluginId === 'string'
        ? identity.pluginId
        : '<non-string>',
    version:
      typeof identity.version === 'string' ? identity.version : '<non-string>',
  })
  const fallbackDigest = createHash('sha256')
    .update(rawIdentity, 'utf8')
    .digest('hex')
  return {
    executable: {
      pluginId: pluginValid
        ? identity.pluginId
        : `invalid-candidate.${fallbackDigest.slice(0, 32)}`,
      version: versionValid ? identity.version : '0.0.0-invalid',
      digest: digestValid ? identity.digest : fallbackDigest,
    },
    valid: false,
  }
}

function normalizePermissions(
  permissions: readonly string[]
): readonly string[] | undefined {
  if (permissions.length > MAX_PERMISSIONS) return undefined
  const normalized = new Set<string>()
  for (const permission of permissions) {
    if (
      typeof permission !== 'string' ||
      permission.length === 0 ||
      byteLength(permission) > MAX_PERMISSION_BYTES
    ) {
      return undefined
    }
    normalized.add(permission)
  }
  return [...normalized].sort()
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PostDeliveryMaterializationError(
      'event_invalid',
      `${field} must be a non-negative safe integer`
    )
  }
}

function makeStableIdentity(
  event: PostDeliveryEventSnapshot,
  candidate: PostDeliveryCandidateSnapshot
): { deliveryId: string; deduplicationKey: string } {
  const identityJson = canonicalJson({
    digest: candidate.executable.digest,
    hook: candidate.hook,
    occurrenceId: event.occurrenceId,
    pluginId: candidate.executable.pluginId,
    version: candidate.executable.version,
  })
  const digest = createHash('sha256').update(identityJson, 'utf8').digest('hex')
  return {
    deliveryId: `post:v1:${digest}`,
    deduplicationKey: digest,
  }
}

function materializeCandidate(
  event: PostDeliveryEventSnapshot,
  candidate: PostDeliveryCandidateSnapshot,
  createdAt: number
): PostDeliveryAdmission {
  const normalizedIdentity = normalizeIdentity(candidate.executable)
  const executable = normalizedIdentity.executable
  const hook = candidate.hook === 'onError' ? 'onError' : 'afterComplete'
  const hookValid =
    candidate.hook === 'afterComplete' || candidate.hook === 'onError'
  const { deliveryId, deduplicationKey } = makeStableIdentity(event, {
    ...candidate,
    hook,
    executable,
  })
  const requiredPermissions = normalizePermissions(
    candidate.requiredPermissions
  )
  const createdEffectivePermissions = normalizePermissions(
    candidate.createdEffectivePermissions
  )
  const generationValid =
    Number.isSafeInteger(candidate.createdGeneration) &&
    candidate.createdGeneration >= 0
  const permissionsValid =
    requiredPermissions !== undefined &&
    createdEffectivePermissions !== undefined &&
    requiredPermissions.every((permission) =>
      createdEffectivePermissions.includes(permission)
    )
  const valid =
    normalizedIdentity.valid && hookValid && generationValid && permissionsValid

  if (
    event.payload === null ||
    Array.isArray(event.payload) ||
    typeof event.payload !== 'object'
  ) {
    throw new PostDeliveryMaterializationError(
      'event_invalid',
      'post-delivery payload must be an object'
    )
  }

  const payloadFields = event.payload as Record<string, JsonValue>
  const expectedFields =
    hook === 'afterComplete'
      ? new Set(['task', 'filePath'])
      : new Set(['task', 'filePath', 'error'])
  const payloadShapeValid =
    Object.keys(payloadFields).every((key) => expectedFields.has(key)) &&
    [...expectedFields].every((key) => key in payloadFields)
  const stablePayload = {
    schemaVersion: 1 as const,
    taskId: event.taskId,
    task: payloadFields.task ?? null,
    filePath: payloadFields.filePath ?? null,
    ...(hook === 'onError' ? { error: payloadFields.error ?? null } : {}),
    delivery: {
      id: deliveryId,
      occurrenceId: event.occurrenceId,
      occurredAt: event.occurredAt,
      schemaVersion: 1 as const,
    },
  }
  const boundedJson = HookJsonValueSchema.safeParse(stablePayload).success
  const dtoValid =
    payloadShapeValid &&
    boundedJson &&
    (hook === 'afterComplete'
      ? AfterCompleteContextV1Schema
      : OnErrorContextV1Schema
    ).safeParse({
      ...stablePayload,
      invocationId: 'materialization-validation',
    }).success
  const canonicalPayload = canonicalJson(
    boundedJson
      ? stablePayload
      : {
          delivery: stablePayload.delivery,
          invalidPayload: true,
          schemaVersion: 1,
          taskId: event.taskId,
        }
  )
  const payloadBytes = byteLength(canonicalPayload)
  const permissionSnapshotBytes =
    byteLength(canonicalJson(requiredPermissions ?? [])) +
    byteLength(canonicalJson(createdEffectivePermissions ?? []))
  const payloadSizeValid = payloadBytes <= HOOK_DTO_LIMITS.messageBytes

  return {
    deliveryId,
    deduplicationKey,
    hook,
    executable,
    createdGeneration: generationValid ? candidate.createdGeneration : 0,
    requiredPermissions: requiredPermissions ?? [],
    createdEffectivePermissions: createdEffectivePermissions ?? [],
    occurrenceId: event.occurrenceId,
    taskId: event.taskId,
    occurredAt: event.occurredAt,
    canonicalPayload,
    payloadBytes,
    permissionSnapshotBytes,
    reservedBytes:
      payloadBytes + permissionSnapshotBytes + POST_DELIVERY_ROW_CHARGE_BYTES,
    createdAt,
    initialStatus:
      valid && dtoValid && payloadSizeValid ? 'pending' : 'dead_letter',
    initialReason:
      valid && dtoValid && payloadSizeValid ? undefined : 'input_invalid',
    initialErrorCode:
      valid && dtoValid && payloadSizeValid
        ? undefined
        : 'plugin.hook.input_invalid',
  }
}

/**
 * Produces stable, insertion-ready rows for the caller's terminal transaction.
 * The repository owns quota admission and the unique-key idempotency check.
 */
export function materializePostDeliveries(
  input: PostDeliveryMaterializationInput
): readonly PostDeliveryAdmission[] {
  requireBoundedText(
    input.event.occurrenceId,
    'occurrenceId',
    MAX_OPAQUE_ID_BYTES
  )
  requireBoundedText(input.event.taskId, 'taskId', MAX_OPAQUE_ID_BYTES)
  assertTimestamp(input.event.occurredAt, 'occurredAt')
  assertTimestamp(input.createdAt, 'createdAt')
  if (input.event.schemaVersion !== 1) {
    throw new PostDeliveryMaterializationError(
      'event_invalid',
      'unsupported post-delivery event schemaVersion'
    )
  }

  return input.candidates.map((candidate) =>
    materializeCandidate(input.event, candidate, input.createdAt)
  )
}
