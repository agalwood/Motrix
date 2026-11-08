import { z } from 'zod'

// App limits leave room for the JSON envelope on engines using a 2 MiB RPC limit.
// The native codec may support larger snapshots without the app admitting them.
export const MAX_LEGACY_CHECKPOINT_BYTES = 1024 * 1024
export const MAX_LEGACY_CHECKPOINT_RANGES = 100000
const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identityValue = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const token = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/)
const engineTaskId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((v) => !/^0+$/.test(v))
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) =>
    [...v].every(
      (char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127
    )
  )

export const legacyCheckpointMetadataSchema = z
  .object({
    type: z.enum(['http', 'bt']),
    totalBytes: byteCount,
    pieceBytes: byteCount.min(1).max(2147483647),
    infoHash: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.type === 'bt') !== (value.infoHash !== null))
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint content identity does not match its type',
      })
  })
export const legacyCheckpointInspectionSchema = legacyCheckpointMetadataSchema
  .safeExtend({
    sourceDigest: digest,
    completedBytes: byteCount,
    uploadedBytes: byteCount,
    ranges: z
      .array(z.object({ offset: byteCount, length: byteCount.min(1) }).strict())
      .max(MAX_LEGACY_CHECKPOINT_RANGES),
  })
  .superRefine((value, ctx) => {
    let end = 0
    let completed = 0
    for (const range of value.ranges) {
      if (
        range.offset < end ||
        range.length > value.totalBytes - range.offset
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Checkpoint ranges overlap or exceed the payload',
        })
        return
      }
      end = range.offset + range.length
      completed += range.length
    }
    if (completed !== value.completedBytes)
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint progress does not match its ranges',
      })
  })
export type LegacyCheckpointInspection = z.infer<
  typeof legacyCheckpointInspectionSchema
>

export const legacyCheckpointFileSchema = z
  .object({
    path: filePath,
    offset: byteCount,
    length: byteCount,
    identity: z
      .object({
        device: identityValue,
        inode: identityValue,
        size: identityValue,
        mtimeNs: identityValue,
        ctimeNs: identityValue,
      })
      .strict(),
  })
  .strict()
export type LegacyCheckpointFile = z.infer<typeof legacyCheckpointFileSchema>

export const legacyCheckpointImportSchema = z
  .object({
    token,
    engineTaskId,
    targetPath: filePath,
    controlFile: z
      .instanceof(Uint8Array)
      .refine(
        (v) => v.byteLength > 0 && v.byteLength <= MAX_LEGACY_CHECKPOINT_BYTES
      ),
    sourceDigest: digest,
    expected: legacyCheckpointMetadataSchema,
    files: z.array(legacyCheckpointFileSchema).min(1).max(10000),
  })
  .strict()
  .superRefine((value, ctx) => {
    let offset = 0
    const paths = new Set<string>()
    for (const file of value.files) {
      if (
        file.offset !== offset ||
        paths.has(file.path) ||
        file.length > value.expected.totalBytes - offset
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Checkpoint file mapping is incomplete or overlaps',
        })
        return
      }
      paths.add(file.path)
      offset += file.length
    }
    if (
      offset !== value.expected.totalBytes ||
      (value.expected.type === 'http' &&
        (value.files.length !== 1 || value.files[0].path !== value.targetPath))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Checkpoint file mapping does not match its metadata',
      })
  })
export type LegacyCheckpointImport = z.infer<
  typeof legacyCheckpointImportSchema
>

export const legacyCheckpointReconcileSchema = z
  .object({ token, targetPath: filePath })
  .strict()
export type LegacyCheckpointReconcile = z.infer<
  typeof legacyCheckpointReconcileSchema
>
export const legacyCheckpointReceiptSchema =
  legacyCheckpointReconcileSchema.extend({
    status: z.enum(['created', 'consumed']),
    engineTaskId,
    sourceDigest: digest,
  })
export type LegacyCheckpointReceipt = z.infer<
  typeof legacyCheckpointReceiptSchema
>
export type LegacyCheckpointReconciliation =
  | LegacyCheckpointReceipt
  | (LegacyCheckpointReconcile & { status: 'absent' })
