import { describe, expect, it } from 'vitest'
import {
  AfterCompleteContextV1Schema,
  BeforeCreateHttpContextV1Schema,
  BeforeFinalizeContextV1Schema,
  CapabilityCallMessageSchema,
  CapabilityResponseMessageSchema,
  DeliveryEnvelopeV1Schema,
  HOOK_DTO_LIMITS,
  HookEffectsV1Schema,
  HookEnterMessageSchema,
  HookJsonValueSchema,
  HookMetadataOperationSchema,
  HookMetadataSnapshotSchema,
  PluginTaskSnapshotV1Schema,
} from './plugin-hooks'

const INVOCATION = {
  invocationId: 'invocation-1',
  callChainId: 'chain-1',
  permissionGeneration: 7,
} as const

const TASK = {
  schemaVersion: 1,
  id: 'task-1',
  name: 'archive.zip',
  type: 'http',
  kind: 'direct',
  status: 'completed',
  filePath: '/downloads/archive.zip',
  saveDir: '/downloads',
  filename: 'archive.zip',
  progress: 100,
  totalBytes: 10,
  downloadedBytes: 10,
  uploadedBytes: 0,
  sizeWhenDone: 10,
  fileCount: 1,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: 3,
  category: null,
  infoHash: null,
  error: null,
} as const

const BEFORE_CREATE = {
  schemaVersion: 1,
  invocationId: INVOCATION.invocationId,
  taskId: TASK.id,
  sourceUrl: 'https://example.test/archive.zip',
  createdBy: 'user',
  requestedAt: 1,
  type: 'http',
  uris: ['https://example.test/archive.zip'],
  saveDir: '/downloads',
  headers: [{ name: 'Accept', value: '*/*' }],
} as const

describe('plugin Hook schemas', () => {
  it('accepts complete versioned task and delivery DTOs', () => {
    expect(PluginTaskSnapshotV1Schema.parse(TASK)).toEqual(TASK)
    expect(
      DeliveryEnvelopeV1Schema.parse({
        schemaVersion: 1,
        id: 'delivery-1',
        occurrenceId: 'occurrence-1',
        occurredAt: 3,
      })
    ).toBeTruthy()
  })

  it('rejects internal task fields and incomplete public error descriptors', () => {
    expect(
      PluginTaskSnapshotV1Schema.safeParse({
        ...TASK,
        engineTaskId: 'must-not-cross-the-boundary',
      }).success
    ).toBe(false)
    expect(
      PluginTaskSnapshotV1Schema.safeParse({
        ...TASK,
        error: { code: 'download.failed', message: 'failed' },
      }).success
    ).toBe(false)
  })

  it('uses exact post-Hook DTOs with a stable delivery id', () => {
    const dto = {
      schemaVersion: 1,
      invocationId: INVOCATION.invocationId,
      taskId: TASK.id,
      task: TASK,
      filePath: TASK.filePath,
      delivery: {
        schemaVersion: 1,
        id: 'delivery-1',
        occurrenceId: 'occurrence-1',
        occurredAt: 3,
      },
    }
    expect(AfterCompleteContextV1Schema.parse(dto)).toEqual(dto)
    expect(
      AfterCompleteContextV1Schema.safeParse({ ...dto, attempt: 2 }).success
    ).toBe(false)
  })

  it('accepts byte limits inclusively and rejects the next byte', () => {
    const keyAtLimit = 'k'.repeat(HOOK_DTO_LIMITS.metadataKeyBytes)
    expect(
      HookMetadataOperationSchema.safeParse({
        op: 'set',
        key: keyAtLimit,
        value: true,
      }).success
    ).toBe(true)
    expect(
      HookMetadataOperationSchema.safeParse({
        op: 'set',
        key: `${keyAtLimit}x`,
        value: true,
      }).success
    ).toBe(false)
  })

  it('rejects non-finite, cyclic, oversized, and over-deep JSON', () => {
    expect(HookJsonValueSchema.safeParse(Number.NaN).success).toBe(false)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(HookJsonValueSchema.safeParse(cyclic).success).toBe(false)

    let deep: unknown = 'leaf'
    for (let index = 0; index <= HOOK_DTO_LIMITS.jsonDepth; index += 1) {
      deep = { child: deep }
    }
    expect(HookJsonValueSchema.safeParse(deep).success).toBe(false)

    expect(
      HookMetadataOperationSchema.safeParse({
        op: 'set',
        key: 'large',
        value: 'x'.repeat(HOOK_DTO_LIMITS.metadataValueBytes),
      }).success
    ).toBe(false)
  })

  it('bounds metadata snapshots by entries and encoded bytes', () => {
    const tooMany = Object.fromEntries(
      Array.from(
        { length: HOOK_DTO_LIMITS.metadataEntries + 1 },
        (_, index) => [`k${index}`, index]
      )
    )
    expect(HookMetadataSnapshotSchema.safeParse(tooMany).success).toBe(false)

    const tooLarge = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `k${index}`,
        'x'.repeat(60 * 1024),
      ])
    )
    expect(HookMetadataSnapshotSchema.safeParse(tooLarge).success).toBe(false)
  })

  it('validates the complete Hook envelope and rejects ID mismatch or extras', () => {
    const enter = {
      type: 'event',
      event: 'hookEnter',
      hook: 'beforeCreate',
      ...INVOCATION,
      taskId: TASK.id,
      ctxPayload: BEFORE_CREATE,
      metadataSnapshot: {},
    }
    expect(HookEnterMessageSchema.safeParse(enter).success).toBe(true)
    expect(
      HookEnterMessageSchema.safeParse({
        ...enter,
        ctxPayload: { ...BEFORE_CREATE, invocationId: 'wrong' },
      }).success
    ).toBe(false)
    expect(
      HookEnterMessageSchema.safeParse({ ...enter, untrusted: true }).success
    ).toBe(false)
  })

  it('requires an invocation scope to be complete when a call is scoped', () => {
    const call = {
      type: 'call',
      id: 1,
      capability: 'http',
      method: 'get',
      args: ['https://example.test'],
    }
    expect(CapabilityCallMessageSchema.safeParse(call).success).toBe(true)
    expect(
      CapabilityCallMessageSchema.safeParse({ ...call, ...INVOCATION }).success
    ).toBe(true)
    expect(
      CapabilityCallMessageSchema.safeParse({
        ...call,
        invocationId: INVOCATION.invocationId,
      }).success
    ).toBe(false)
  })

  it('strictly validates command invocation scope and response parity', () => {
    const commandScope = {
      commandInvocationId: 9,
      callChain: { id: 'chain-command', plugins: ['pub.a', 'pub.b'] },
    }
    const call = {
      type: 'call',
      id: 2,
      capability: 'commands',
      method: 'execute',
      args: ['pub.c.run', {}],
      commandScope,
    }
    expect(CapabilityCallMessageSchema.safeParse(call).success).toBe(true)
    expect(
      CapabilityCallMessageSchema.safeParse({
        ...call,
        commandScope: {
          ...commandScope,
          callChain: {
            ...commandScope.callChain,
            plugins: ['pub.a', 'pub.a'],
          },
        },
      }).success
    ).toBe(false)
    expect(
      CapabilityResponseMessageSchema.safeParse({
        type: 'response',
        id: call.id,
        commandScope,
        ok: true,
        result: {},
      }).success
    ).toBe(true)
    expect(
      CapabilityResponseMessageSchema.safeParse({
        type: 'response',
        id: call.id,
        commandScope: { commandInvocationId: commandScope.commandInvocationId },
        ok: true,
        result: {},
      }).success
    ).toBe(false)
  })

  it('rejects an effects envelope beyond the complete message budget', () => {
    const effects = {
      schemaVersion: 1,
      contextPatches: Array.from({ length: 40 }, (_, index) => ({
        [`field${index}`]: 'x'.repeat(60 * 1024),
      })),
      metadataOperations: [],
    }
    expect(HookEffectsV1Schema.safeParse(effects).success).toBe(false)
  })

  it('rejects unknown beforeCreate fields at the DTO trust boundary', () => {
    expect(
      BeforeCreateHttpContextV1Schema.safeParse(BEFORE_CREATE).success
    ).toBe(true)
    expect(
      BeforeCreateHttpContextV1Schema.safeParse({
        ...BEFORE_CREATE,
        engineOptions: { secret: true },
      }).success
    ).toBe(false)
  })

  it('requires a canonical non-secret BT source identifier before finalization', () => {
    const btTask = {
      ...TASK,
      type: 'bt',
      kind: 'bt',
      infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
    } as const
    const context = {
      schemaVersion: 1,
      invocationId: INVOCATION.invocationId,
      taskId: btTask.id,
      sourceUrl: `urn:btih:${btTask.infoHash}`,
      createdBy: 'user',
      requestedAt: 1,
      task: btTask,
      inputFilePath: btTask.filePath,
      filePath: btTask.filePath,
      targetFilePath: btTask.filePath,
    }

    expect(BeforeFinalizeContextV1Schema.safeParse(context).success).toBe(true)
    expect(
      BeforeFinalizeContextV1Schema.safeParse({
        ...context,
        sourceUrl: '/Users/alice/private-tracker.torrent',
      }).success
    ).toBe(false)
    expect(
      BeforeFinalizeContextV1Schema.safeParse({
        ...context,
        sourceUrl:
          'magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&tr=https://secret.example/passkey',
      }).success
    ).toBe(false)
  })
})
