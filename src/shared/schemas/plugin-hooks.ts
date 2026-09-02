import { z } from 'zod'

export const HOOK_SCHEMA_VERSION = 1 as const

export const HOOK_DTO_LIMITS = {
  messageBytes: 2 * 1024 * 1024,
  stringBytes: 64 * 1024,
  pathBytes: 32 * 1024,
  urlCount: 128,
  urlBytes: 16 * 1024,
  headerCount: 256,
  headerNameBytes: 256,
  headerValueBytes: 16 * 1024,
  headerBytes: 256 * 1024,
  jsonDepth: 16,
  objectKeys: 1_024,
  arrayItems: 1_024,
  metadataEntries: 1_024,
  metadataKeyBytes: 128,
  metadataValueBytes: 256 * 1024,
  metadataSnapshotBytes: 1024 * 1024,
  errorCodeBytes: 128,
  errorMessageBytes: 16 * 1024,
  opaqueIdBytes: 128,
  effectCount: 1_024,
} as const

const utf8Encoder = new TextEncoder()

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

function boundedString(maxBytes: number, label: string) {
  return z.string().refine((value) => utf8Bytes(value) <= maxBytes, {
    message: `${label} exceeds ${maxBytes} UTF-8 bytes`,
  })
}

function boundedNonEmptyString(maxBytes: number, label: string) {
  return boundedString(maxBytes, label).refine((value) => value.length > 0, {
    message: `${label} must not be empty`,
  })
}

function encodedJsonBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? null : utf8Bytes(encoded)
  } catch {
    return null
  }
}

function addEncodedSizeIssue(
  value: unknown,
  maxBytes: number,
  label: string,
  ctx: z.RefinementCtx
): void {
  const bytes = encodedJsonBytes(value)
  if (bytes === null || bytes > maxBytes) {
    ctx.addIssue({
      code: 'custom',
      message: `${label} must be JSON and at most ${maxBytes} UTF-8 bytes`,
    })
  }
}

type JsonValueShape =
  | string
  | number
  | boolean
  | null
  | JsonValueShape[]
  | { [key: string]: JsonValueShape }

function isBoundedJsonValue(value: unknown): value is JsonValueShape {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new WeakSet<object>()

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    const { value: node, depth } = current

    if (
      node === null ||
      typeof node === 'boolean' ||
      typeof node === 'string'
    ) {
      if (
        typeof node === 'string' &&
        utf8Bytes(node) > HOOK_DTO_LIMITS.stringBytes
      ) {
        return false
      }
      continue
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return false
      continue
    }
    if (typeof node !== 'object' || depth >= HOOK_DTO_LIMITS.jsonDepth) {
      return false
    }
    if (seen.has(node)) return false
    seen.add(node)

    if (Array.isArray(node)) {
      if (node.length > HOOK_DTO_LIMITS.arrayItems) return false
      for (const item of node) stack.push({ value: item, depth: depth + 1 })
      continue
    }

    const prototype = Object.getPrototypeOf(node)
    if (prototype !== Object.prototype && prototype !== null) return false
    const entries = Object.entries(node)
    if (entries.length > HOOK_DTO_LIMITS.objectKeys) return false
    for (const [key, item] of entries) {
      if (utf8Bytes(key) > HOOK_DTO_LIMITS.stringBytes) return false
      stack.push({ value: item, depth: depth + 1 })
    }
  }

  return true
}

export const HookJsonValueSchema = z.custom<JsonValueShape>(
  isBoundedJsonValue,
  'value must be bounded JSON'
)
export type HookJsonValue = z.infer<typeof HookJsonValueSchema>

const GenericStringSchema = boundedString(HOOK_DTO_LIMITS.stringBytes, 'string')
const PathSchema = boundedNonEmptyString(HOOK_DTO_LIMITS.pathBytes, 'path')
const UrlSchema = boundedNonEmptyString(HOOK_DTO_LIMITS.urlBytes, 'URL')
const OpaqueIdSchema = boundedNonEmptyString(
  HOOK_DTO_LIMITS.opaqueIdBytes,
  'identifier'
)
const TimestampSchema = z.number().int().nonnegative().safe()
const NonNegativeCountSchema = z.number().int().nonnegative().safe()

export const HookNameSchema = z.enum([
  'beforeCreate',
  'beforeFinalize',
  'afterComplete',
  'onError',
])
export type HookNameV1 = z.infer<typeof HookNameSchema>

export const HookInvocationScopeSchema = z.strictObject({
  invocationId: OpaqueIdSchema,
  callChainId: OpaqueIdSchema,
  permissionGeneration: z.number().int().nonnegative().safe(),
})
export type HookInvocationScopeV1 = z.infer<typeof HookInvocationScopeSchema>

/**
 * Host-owned command provenance carried across the Worker boundary. Unlike a
 * Hook scope, this is tied to one concrete executeCommand lane entry; nested
 * capability calls must echo it so a concurrent command cannot borrow another
 * invocation's call chain.
 */
export const PluginCallChainV1Schema = z.strictObject({
  id: OpaqueIdSchema,
  plugins: z
    .array(OpaqueIdSchema)
    .min(1)
    .max(64)
    .refine((plugins) => new Set(plugins).size === plugins.length, {
      message: 'command call chain must not contain duplicate plugins',
    }),
})
export type PluginCallChainV1 = z.infer<typeof PluginCallChainV1Schema>

export const CommandInvocationScopeV1Schema = z.strictObject({
  commandInvocationId: z.number().int().positive().safe(),
  callChain: PluginCallChainV1Schema,
})
export type CommandInvocationScopeV1 = z.infer<
  typeof CommandInvocationScopeV1Schema
>

export const ErrorDescriptorV1Schema = z.strictObject({
  code: boundedNonEmptyString(HOOK_DTO_LIMITS.errorCodeBytes, 'error code'),
  message: boundedString(HOOK_DTO_LIMITS.errorMessageBytes, 'error message'),
  detailKey: boundedString(
    HOOK_DTO_LIMITS.errorCodeBytes,
    'error detail key'
  ).nullable(),
  detailParams: z
    .record(
      boundedNonEmptyString(HOOK_DTO_LIMITS.metadataKeyBytes, 'detail key'),
      GenericStringSchema
    )
    .superRefine((value, ctx) => {
      if (Object.keys(value).length > HOOK_DTO_LIMITS.objectKeys) {
        ctx.addIssue({
          code: 'custom',
          message: 'too many error detail values',
        })
      }
    })
    .nullable(),
})
export type ErrorDescriptorV1 = z.infer<typeof ErrorDescriptorV1Schema>

export const PluginTaskSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
  id: OpaqueIdSchema,
  name: GenericStringSchema,
  type: z.enum(['http', 'ftp', 'bt', 'magnet', 'metalink']),
  kind: z.enum(['direct', 'bt', 'hls', 'mux']),
  status: z.enum([
    'queued',
    'fetching_metadata',
    'metadata_ready',
    'downloading',
    'finalizing',
    'seeding',
    'paused',
    'completed',
    'error',
    'removed',
  ]),
  filePath: PathSchema,
  saveDir: PathSchema,
  filename: GenericStringSchema,
  progress: z.number().finite().min(0).max(100),
  totalBytes: NonNegativeCountSchema,
  downloadedBytes: NonNegativeCountSchema,
  uploadedBytes: NonNegativeCountSchema,
  sizeWhenDone: NonNegativeCountSchema,
  fileCount: NonNegativeCountSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  category: GenericStringSchema.nullable(),
  infoHash: GenericStringSchema.nullable(),
  error: ErrorDescriptorV1Schema.nullable(),
})
export type PluginTaskSnapshotV1 = z.infer<typeof PluginTaskSnapshotV1Schema>

const HeaderSchema = z.strictObject({
  name: boundedNonEmptyString(HOOK_DTO_LIMITS.headerNameBytes, 'header name'),
  value: boundedString(HOOK_DTO_LIMITS.headerValueBytes, 'header value'),
})

const HeadersSchema = z
  .array(HeaderSchema)
  .max(HOOK_DTO_LIMITS.headerCount)
  .superRefine((headers, ctx) => {
    const bytes = headers.reduce(
      (total, header) =>
        total + utf8Bytes(header.name) + utf8Bytes(header.value),
      0
    )
    if (bytes > HOOK_DTO_LIMITS.headerBytes) {
      ctx.addIssue({ code: 'custom', message: 'headers exceed byte limit' })
    }
  })

const CommonCreateShape = {
  schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
  invocationId: OpaqueIdSchema,
  taskId: OpaqueIdSchema,
  sourceUrl: UrlSchema,
  createdBy: z.enum(['user', 'protocol', 'api']),
  requestedAt: TimestampSchema,
}

/**
 * A non-secret, stable source identity for BT finalization. Raw magnet URLs,
 * torrent file paths, and tracker URLs are intentionally excluded because
 * they can contain local paths or private tracker credentials.
 */
export const BeforeFinalizeBtSourceIdentifierSchema = z
  .string()
  .refine(
    (value) =>
      /^urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})$/i.test(value) ||
      /^urn:motrix:bt:[A-Za-z0-9_-]+$/.test(value),
    'BT beforeFinalize sourceUrl must be a canonical non-secret identifier'
  )

export const BeforeCreateHttpContextV1Schema = z.strictObject({
  ...CommonCreateShape,
  type: z.literal('http'),
  uris: z.array(UrlSchema).min(1).max(HOOK_DTO_LIMITS.urlCount),
  saveDir: PathSchema,
  filename: GenericStringSchema.optional(),
  connections: z.number().int().positive().safe().optional(),
  headers: HeadersSchema,
  proxy: GenericStringSchema.optional(),
})
export type BeforeCreateHttpContextV1 = z.infer<
  typeof BeforeCreateHttpContextV1Schema
>

export const BeforeCreateBtContextV1Schema = z.strictObject({
  ...CommonCreateShape,
  type: z.enum(['bt', 'magnet']),
  infoHash: GenericStringSchema.optional(),
  trackers: z.array(UrlSchema).max(HOOK_DTO_LIMITS.urlCount),
  displayName: GenericStringSchema.optional(),
})
export type BeforeCreateBtContextV1 = z.infer<
  typeof BeforeCreateBtContextV1Schema
>

export const BeforeFinalizeContextV1Schema = z
  .strictObject({
    ...CommonCreateShape,
    task: PluginTaskSnapshotV1Schema,
    inputFilePath: PathSchema,
    filePath: PathSchema,
    targetFilePath: PathSchema,
  })
  .superRefine((value, ctx) => {
    if (value.taskId !== value.task.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId must match task.id',
      })
    }
    if (value.filePath !== value.targetFilePath) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetFilePath'],
        message: 'targetFilePath must match the initial filePath',
      })
    }
    if (
      (value.task.type === 'bt' || value.task.type === 'magnet') &&
      !BeforeFinalizeBtSourceIdentifierSchema.safeParse(value.sourceUrl).success
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message:
          'BT beforeFinalize sourceUrl must be a canonical non-secret identifier',
      })
    }
  })
export type BeforeFinalizeContextV1 = z.infer<
  typeof BeforeFinalizeContextV1Schema
>

export const DeliveryEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
  id: OpaqueIdSchema,
  occurrenceId: OpaqueIdSchema,
  occurredAt: TimestampSchema,
})
export type DeliveryEnvelopeV1 = z.infer<typeof DeliveryEnvelopeV1Schema>

const CommonPostShape = {
  schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
  invocationId: OpaqueIdSchema,
  taskId: OpaqueIdSchema,
  task: PluginTaskSnapshotV1Schema,
  filePath: PathSchema,
  delivery: DeliveryEnvelopeV1Schema,
}

export const AfterCompleteContextV1Schema = z
  .strictObject(CommonPostShape)
  .superRefine((value, ctx) => {
    if (value.taskId !== value.task.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId must match task.id',
      })
    }
  })
export type AfterCompleteContextV1 = z.infer<
  typeof AfterCompleteContextV1Schema
>

export const OnErrorContextV1Schema = z
  .strictObject({ ...CommonPostShape, error: ErrorDescriptorV1Schema })
  .superRefine((value, ctx) => {
    if (value.taskId !== value.task.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId must match task.id',
      })
    }
  })
export type OnErrorContextV1 = z.infer<typeof OnErrorContextV1Schema>

export const HookMetadataSnapshotSchema = z
  .record(
    boundedNonEmptyString(HOOK_DTO_LIMITS.metadataKeyBytes, 'metadata key'),
    HookJsonValueSchema.superRefine((value, ctx) => {
      addEncodedSizeIssue(
        value,
        HOOK_DTO_LIMITS.metadataValueBytes,
        'metadata value',
        ctx
      )
    })
  )
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > HOOK_DTO_LIMITS.metadataEntries) {
      ctx.addIssue({ code: 'custom', message: 'too many metadata entries' })
    }
    addEncodedSizeIssue(
      value,
      HOOK_DTO_LIMITS.metadataSnapshotBytes,
      'metadata snapshot',
      ctx
    )
  })
export type HookMetadataSnapshot = z.infer<typeof HookMetadataSnapshotSchema>

export const HookMetadataOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set'),
    key: boundedNonEmptyString(
      HOOK_DTO_LIMITS.metadataKeyBytes,
      'metadata key'
    ),
    value: HookJsonValueSchema.superRefine((value, ctx) => {
      addEncodedSizeIssue(
        value,
        HOOK_DTO_LIMITS.metadataValueBytes,
        'metadata value',
        ctx
      )
    }),
  }),
  z.strictObject({
    op: z.literal('delete'),
    key: boundedNonEmptyString(
      HOOK_DTO_LIMITS.metadataKeyBytes,
      'metadata key'
    ),
  }),
])
export type HookMetadataOperation = z.infer<typeof HookMetadataOperationSchema>

export const HookContextPatchSchema = z
  .record(GenericStringSchema, HookJsonValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > HOOK_DTO_LIMITS.objectKeys) {
      ctx.addIssue({
        code: 'custom',
        message: 'context patch has too many keys',
      })
    }
  })
export type HookContextPatch = z.infer<typeof HookContextPatchSchema>

export const HookEffectsV1Schema = z
  .strictObject({
    schemaVersion: z.literal(HOOK_SCHEMA_VERSION),
    contextPatches: z
      .array(HookContextPatchSchema)
      .max(HOOK_DTO_LIMITS.effectCount),
    metadataOperations: z
      .array(HookMetadataOperationSchema)
      .max(HOOK_DTO_LIMITS.metadataEntries),
  })
  .superRefine((value, ctx) => {
    addEncodedSizeIssue(
      value,
      HOOK_DTO_LIMITS.messageBytes,
      'Hook effects',
      ctx
    )
  })
export type HookEffectsV1 = z.infer<typeof HookEffectsV1Schema>

const HookEnterBaseShape = {
  type: z.literal('event'),
  event: z.literal('hookEnter'),
  ...HookInvocationScopeSchema.shape,
  taskId: OpaqueIdSchema,
  metadataSnapshot: HookMetadataSnapshotSchema,
}

function checkedHookEnter<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const message = value as unknown as {
      invocationId: string
      taskId: string
      ctxPayload: { invocationId: string; taskId: string }
    }
    if (message.invocationId !== message.ctxPayload.invocationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctxPayload', 'invocationId'],
        message: 'payload invocationId must match envelope invocationId',
      })
    }
    if (message.taskId !== message.ctxPayload.taskId) {
      ctx.addIssue({
        code: 'custom',
        path: ['ctxPayload', 'taskId'],
        message: 'payload taskId must match envelope taskId',
      })
    }
    addEncodedSizeIssue(
      value,
      HOOK_DTO_LIMITS.messageBytes,
      'Hook enter message',
      ctx
    )
  })
}

export const BeforeCreateHttpHookEnterSchema = checkedHookEnter(
  z.strictObject({
    ...HookEnterBaseShape,
    hook: z.literal('beforeCreate'),
    ctxPayload: BeforeCreateHttpContextV1Schema,
  })
)
export const BeforeCreateBtHookEnterSchema = checkedHookEnter(
  z.strictObject({
    ...HookEnterBaseShape,
    hook: z.literal('beforeCreate'),
    ctxPayload: BeforeCreateBtContextV1Schema,
  })
)
export const BeforeFinalizeHookEnterSchema = checkedHookEnter(
  z.strictObject({
    ...HookEnterBaseShape,
    hook: z.literal('beforeFinalize'),
    ctxPayload: BeforeFinalizeContextV1Schema,
  })
)
export const AfterCompleteHookEnterSchema = checkedHookEnter(
  z.strictObject({
    ...HookEnterBaseShape,
    hook: z.literal('afterComplete'),
    ctxPayload: AfterCompleteContextV1Schema,
  })
)
export const OnErrorHookEnterSchema = checkedHookEnter(
  z.strictObject({
    ...HookEnterBaseShape,
    hook: z.literal('onError'),
    ctxPayload: OnErrorContextV1Schema,
  })
)

export const HookEnterMessageSchema = z.union([
  BeforeCreateHttpHookEnterSchema,
  BeforeCreateBtHookEnterSchema,
  BeforeFinalizeHookEnterSchema,
  AfterCompleteHookEnterSchema,
  OnErrorHookEnterSchema,
])
export type HookEnterMessageV1 = z.infer<typeof HookEnterMessageSchema>

export const HookAbortMessageSchema = z.strictObject({
  type: z.literal('event'),
  event: z.literal('abort'),
  ...HookInvocationScopeSchema.shape,
  reason: boundedString(HOOK_DTO_LIMITS.errorMessageBytes, 'abort reason'),
})
export type HookAbortMessageV1 = z.infer<typeof HookAbortMessageSchema>

export const HookExitMessageSchema = z
  .discriminatedUnion('ok', [
    z.strictObject({
      type: z.literal('event'),
      event: z.literal('hookExit'),
      ...HookInvocationScopeSchema.shape,
      ok: z.literal(true),
      effects: HookEffectsV1Schema,
    }),
    z.strictObject({
      type: z.literal('event'),
      event: z.literal('hookExit'),
      ...HookInvocationScopeSchema.shape,
      ok: z.literal(false),
      error: z.strictObject({
        code: boundedNonEmptyString(
          HOOK_DTO_LIMITS.errorCodeBytes,
          'error code'
        ),
        message: boundedString(
          HOOK_DTO_LIMITS.errorMessageBytes,
          'error message'
        ),
      }),
    }),
  ])
  .superRefine((value, ctx) => {
    addEncodedSizeIssue(
      value,
      HOOK_DTO_LIMITS.messageBytes,
      'Hook exit message',
      ctx
    )
  })
export type HookExitMessageV1 = z.infer<typeof HookExitMessageSchema>

const CapabilityCallShape = {
  type: z.literal('call'),
  id: z.number().int().positive().safe(),
  capability: boundedNonEmptyString(256, 'capability'),
  method: boundedNonEmptyString(256, 'method'),
  args: z.array(z.unknown()).max(HOOK_DTO_LIMITS.arrayItems),
}

export const CapabilityCallMessageSchema = z.union([
  z.strictObject(CapabilityCallShape),
  z.strictObject({
    ...CapabilityCallShape,
    ...HookInvocationScopeSchema.shape,
  }),
  z.strictObject({
    ...CapabilityCallShape,
    commandScope: CommandInvocationScopeV1Schema,
  }),
  z.strictObject({
    ...CapabilityCallShape,
    ...HookInvocationScopeSchema.shape,
    commandScope: CommandInvocationScopeV1Schema,
  }),
])
export type CapabilityCallMessageV1 = z.infer<
  typeof CapabilityCallMessageSchema
>

const CapabilityResponseBaseShape = {
  type: z.literal('response'),
  id: z.number().int().positive().safe(),
}

const CapabilityResponseBodySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ...CapabilityResponseBaseShape,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    ...CapabilityResponseBaseShape,
    ok: z.literal(false),
    error: z.strictObject({
      code: boundedNonEmptyString(HOOK_DTO_LIMITS.errorCodeBytes, 'error code'),
      message: boundedString(
        HOOK_DTO_LIMITS.errorMessageBytes,
        'error message'
      ),
    }),
  }),
])

const ScopedCapabilityResponseBodySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ...CapabilityResponseBaseShape,
    ...HookInvocationScopeSchema.shape,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    ...CapabilityResponseBaseShape,
    ...HookInvocationScopeSchema.shape,
    ok: z.literal(false),
    error: z.strictObject({
      code: boundedNonEmptyString(HOOK_DTO_LIMITS.errorCodeBytes, 'error code'),
      message: boundedString(
        HOOK_DTO_LIMITS.errorMessageBytes,
        'error message'
      ),
    }),
  }),
])

const CommandScopedCapabilityResponseBodySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ...CapabilityResponseBaseShape,
    commandScope: CommandInvocationScopeV1Schema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    ...CapabilityResponseBaseShape,
    commandScope: CommandInvocationScopeV1Schema,
    ok: z.literal(false),
    error: z.strictObject({
      code: boundedNonEmptyString(HOOK_DTO_LIMITS.errorCodeBytes, 'error code'),
      message: boundedString(
        HOOK_DTO_LIMITS.errorMessageBytes,
        'error message'
      ),
    }),
  }),
])

const HookAndCommandScopedCapabilityResponseBodySchema = z.discriminatedUnion(
  'ok',
  [
    z.strictObject({
      ...CapabilityResponseBaseShape,
      ...HookInvocationScopeSchema.shape,
      commandScope: CommandInvocationScopeV1Schema,
      ok: z.literal(true),
      result: z.unknown(),
    }),
    z.strictObject({
      ...CapabilityResponseBaseShape,
      ...HookInvocationScopeSchema.shape,
      commandScope: CommandInvocationScopeV1Schema,
      ok: z.literal(false),
      error: z.strictObject({
        code: boundedNonEmptyString(
          HOOK_DTO_LIMITS.errorCodeBytes,
          'error code'
        ),
        message: boundedString(
          HOOK_DTO_LIMITS.errorMessageBytes,
          'error message'
        ),
      }),
    }),
  ]
)

export const CapabilityResponseMessageSchema = z.union([
  CapabilityResponseBodySchema,
  ScopedCapabilityResponseBodySchema,
  CommandScopedCapabilityResponseBodySchema,
  HookAndCommandScopedCapabilityResponseBodySchema,
])
export type CapabilityResponseMessageV1 = z.infer<
  typeof CapabilityResponseMessageSchema
>
