import { z } from 'zod'

export const legacyReasonSchema = z.enum([
  'fresh-download-required',
  'verification-required',
  'metadata-required',
  'selection-required',
  'unsupported-options',
  'invalid-record',
  'unsafe-path',
  'already-imported',
  'deleted-import',
  'path-conflict',
  'changed-source',
  'not-selected',
  'stopped',
  'commit-failed',
])
export type LegacyReason = z.infer<typeof legacyReasonSchema>

export const legacyImportItemSchema = z.object({
  itemId: z.string().min(1).max(128),
  name: z.string().max(1024),
  type: z.enum(['http', 'bt', 'magnet', 'unknown']),
  selectable: z.boolean(),
  reason: legacyReasonSchema,
})
export type LegacyImportItem = z.infer<typeof legacyImportItemSchema>

export const legacyImportPreviewSchema = z.object({
  previewId: z.uuid(),
  sourceHandle: z.uuid(),
  sourceName: z.string(),
  items: z.array(legacyImportItemSchema).max(10000),
  running: z.boolean(),
  checkpointImportAvailable: z.boolean(),
  expiresAt: z.number(),
})
export type LegacyImportPreview = z.infer<typeof legacyImportPreviewSchema>

export const legacyImportSourceSchema = z.object({
  sourceHandle: z.uuid(),
  name: z.string(),
})
export type LegacyImportSource = z.infer<typeof legacyImportSourceSchema>

export const legacyImportReportSchema = z.object({
  runId: z.uuid(),
  stage: z.enum([
    'backing-up',
    'committing',
    'completed',
    'cancelled',
    'failed',
  ]),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  backupCreated: z.boolean(),
  items: z
    .array(
      legacyImportItemSchema.extend({
        outcome: z.enum(['imported', 'skipped', 'failed', 'unprocessed']),
        taskId: z.string().nullable(),
      })
    )
    .max(10000),
})
export type LegacyImportReport = z.infer<typeof legacyImportReportSchema>

export const legacyScanRequestSchema = z
  .object({ sourceHandle: z.uuid() })
  .strict()
export const legacyCommitRequestSchema = z
  .object({
    previewId: z.uuid(),
    itemIds: z.array(z.string().min(1).max(128)).min(1).max(10000),
  })
  .strict()
export const legacyRunRequestSchema = z.object({ runId: z.uuid() }).strict()
export const legacyTaskRequestSchema = z
  .object({ taskId: z.string().min(1).max(128) })
  .strict()

export const legacyTaskMetadataSchema = z
  .object({
    version: z.literal(1),
    sourceId: z.string(),
    itemKey: z.string(),
    activation: z.literal('inactive'),
    storagePolicy: z.literal('legacy-read-only'),
    reason: legacyReasonSchema,
    selectionKnown: z.boolean(),
    selectedFiles: z.array(z.number().int().nonnegative()).max(10000),
  })
  .strict()
export type LegacyTaskMetadata = z.infer<typeof legacyTaskMetadataSchema>
