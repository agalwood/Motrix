import { createHash } from 'node:crypto'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type LegacyCheckpointImport,
  type LegacyCheckpointInspection,
  type LegacyCheckpointReceipt,
  type LegacyCheckpointReconcile,
  type LegacyCheckpointReconciliation,
  legacyCheckpointImportSchema,
  legacyCheckpointInspectionSchema,
  legacyCheckpointReceiptSchema,
  legacyCheckpointReconcileSchema,
  MAX_LEGACY_CHECKPOINT_BYTES,
  MAX_LEGACY_CHECKPOINT_RANGES,
} from '@shared/schemas/legacy-checkpoint'
import { FEATURE_SQLITE3_PERSISTENCE } from '@shared/types/engine'
import { z } from 'zod'
import type { Aria2RpcClient } from './aria2-rpc-client'

export const FEATURE_LEGACY_CHECKPOINT_IMPORT_V1 = 'LegacyCheckpointImportV1'
const MAX_REQUEST_BYTES = 2 * 1024 * 1024 - 4096
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .transform(Number)
  .refine(Number.isSafeInteger)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const wireInspection = z
  .object({
    version: z.literal('1'),
    format: z.literal('aria2-v1'),
    kind: z.enum(['http', 'bittorrent']),
    totalLength: decimal,
    pieceLength: decimal,
    infoHash: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{40}$/)]),
    uploadLength: decimal,
    completedLength: decimal,
    controlDigest: digest,
    ranges: z
      .array(z.object({ offset: decimal, length: decimal }).strict())
      .max(MAX_LEGACY_CHECKPOINT_RANGES),
  })
  .strict()
const wireReceipt = z
  .object({
    version: z.literal('1'),
    status: z.enum(['created', 'consumed']),
    token: z.string(),
    gid: z.string(),
    targetPath: z.string(),
    controlDigest: digest,
  })
  .strict()
const wireAbsent = z
  .object({
    version: z.literal('1'),
    status: z.literal('absent'),
    token: z.string(),
    targetPath: z.string(),
  })
  .strict()

export interface Aria2LegacyCheckpointImport {
  token: string
  gid: string
  controlFile: string
  controlDigest: string
  targetPath: string
  expected: {
    kind: 'http' | 'bittorrent'
    totalLength: string
    pieceLength: string
    infoHash: string
  }
  files: Array<{
    path: string
    offset: string
    length: string
    identity: LegacyCheckpointImport['files'][number]['identity']
  }>
}

type CheckpointRpc = Pick<
  Aria2RpcClient,
  | 'getVersion'
  | 'inspectLegacyCheckpointV1'
  | 'importLegacyCheckpointV1'
  | 'reconcileLegacyCheckpointV1'
>

function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code = ErrorCode.EngineProtocolError
): T {
  const value = schema.safeParse(input)
  if (!value.success)
    throw new AppError(code, 'Invalid legacy checkpoint contract')
  return value.data
}

function checkPath(value: string): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    Buffer.byteLength(value) > 4096
  )
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Invalid legacy checkpoint path'
    )
}

function controlSnapshot(bytes: Uint8Array): {
  controlFile: string
  sourceDigest: string
} {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > MAX_LEGACY_CHECKPOINT_BYTES
  )
    throw new AppError(
      ErrorCode.InvalidSelection,
      'Invalid legacy checkpoint size'
    )
  // Copy before any await so caller mutation cannot change the admitted snapshot.
  const copy = Buffer.from(bytes)
  return {
    controlFile: copy.toString('base64'),
    sourceDigest: createHash('sha256').update(copy).digest('hex'),
  }
}

function receipt(
  value: unknown,
  expected: LegacyCheckpointReconcile
): LegacyCheckpointReceipt {
  const wire = parse(wireReceipt, value)
  const result = parse(legacyCheckpointReceiptSchema, {
    status: wire.status,
    token: wire.token,
    engineTaskId: wire.gid,
    targetPath: wire.targetPath,
    sourceDigest: wire.controlDigest,
  })
  if (
    result.token !== expected.token ||
    result.targetPath !== expected.targetPath
  )
    throw new AppError(
      ErrorCode.EngineProtocolError,
      'Legacy checkpoint receipt identity mismatch'
    )
  return result
}

/** Native bytes stay opaque outside the concrete engine boundary. No method starts a task. */
export class Aria2LegacyCheckpoint {
  constructor(private readonly rpc: CheckpointRpc) {}

  async supported(): Promise<boolean> {
    // Pre-spawn --version reports only compile-time features. This operation
    // requires the live process's SQLite mode and platform safety support.
    const report = parse(
      z.object({ enabledFeatures: z.array(z.string()) }),
      await this.rpc.getVersion()
    )
    return (
      report.enabledFeatures.includes(FEATURE_SQLITE3_PERSISTENCE) &&
      report.enabledFeatures.includes(FEATURE_LEGACY_CHECKPOINT_IMPORT_V1)
    )
  }

  private async requireSupport(): Promise<void> {
    if (!(await this.supported()))
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Legacy checkpoint import is unavailable'
      )
  }

  async inspect(bytes: Uint8Array): Promise<LegacyCheckpointInspection> {
    const snapshot = controlSnapshot(bytes)
    await this.requireSupport()
    const wire = parse(
      wireInspection,
      await this.rpc.inspectLegacyCheckpointV1({
        controlFile: snapshot.controlFile,
      })
    )
    if (wire.controlDigest !== snapshot.sourceDigest)
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Legacy checkpoint digest mismatch'
      )
    return parse(legacyCheckpointInspectionSchema, {
      type: wire.kind === 'bittorrent' ? 'bt' : 'http',
      totalBytes: wire.totalLength,
      pieceBytes: wire.pieceLength,
      infoHash: wire.infoHash || null,
      sourceDigest: wire.controlDigest,
      completedBytes: wire.completedLength,
      uploadedBytes: wire.uploadLength,
      ranges: wire.ranges,
    })
  }

  async import(
    input: LegacyCheckpointImport
  ): Promise<LegacyCheckpointReceipt> {
    const request = parse(
      legacyCheckpointImportSchema,
      input,
      ErrorCode.InvalidSelection
    )
    const snapshot = controlSnapshot(request.controlFile)
    if (snapshot.sourceDigest !== request.sourceDigest)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'Legacy checkpoint source changed'
      )
    checkPath(request.targetPath)
    for (const file of request.files) checkPath(file.path)
    const wire: Aria2LegacyCheckpointImport = {
      token: request.token,
      gid: request.engineTaskId,
      controlFile: snapshot.controlFile,
      controlDigest: snapshot.sourceDigest,
      targetPath: request.targetPath,
      expected: {
        kind: request.expected.type === 'bt' ? 'bittorrent' : 'http',
        totalLength: String(request.expected.totalBytes),
        pieceLength: String(request.expected.pieceBytes),
        infoHash: request.expected.infoHash ?? '',
      },
      files: request.files.map((file) => ({
        ...file,
        offset: String(file.offset),
        length: String(file.length),
      })),
    }
    if (Buffer.byteLength(JSON.stringify(wire)) > MAX_REQUEST_BYTES)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'Legacy checkpoint request exceeds the app limit'
      )
    await this.requireSupport()
    // Never retry this mutation here: a lost response requires durable token
    // reconciliation by the caller before any subsequent activation.
    const result = receipt(
      await this.rpc.importLegacyCheckpointV1(wire),
      request
    )
    if (
      result.engineTaskId !== request.engineTaskId ||
      result.sourceDigest !== request.sourceDigest
    )
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Legacy checkpoint receipt does not match the request'
      )
    return result
  }

  async reconcile(
    input: LegacyCheckpointReconcile
  ): Promise<LegacyCheckpointReconciliation> {
    const request = parse(
      legacyCheckpointReconcileSchema,
      input,
      ErrorCode.InvalidSelection
    )
    checkPath(request.targetPath)
    await this.requireSupport()
    const result = await this.rpc.reconcileLegacyCheckpointV1(request)
    const absent = wireAbsent.safeParse(result)
    if (absent.success) {
      if (
        absent.data.token !== request.token ||
        absent.data.targetPath !== request.targetPath
      )
        throw new AppError(
          ErrorCode.EngineProtocolError,
          'Legacy checkpoint reconciliation identity mismatch'
        )
      return { ...request, status: 'absent' }
    }
    return receipt(result, request)
  }
}
