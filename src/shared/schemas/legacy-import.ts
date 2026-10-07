import { z } from 'zod'

export const legacyImportNavigationSchema = z.object({
  detected: z.boolean(),
  invitationPending: z.boolean(),
})
export type LegacyImportNavigationState = z.infer<
  typeof legacyImportNavigationSchema
>

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
  // Display-only original directory; optional for reports saved by older builds.
  saveDir: z.string().max(4096).nullable().optional(),
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
  dataPath: z.string().min(1),
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
export const legacyMetadataRequestSchema = z
  .object({ previewId: z.uuid(), itemId: z.string().min(1).max(128) })
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
    activation: z.enum(['inactive', 'activating', 'active']),
    storagePolicy: z.enum(['legacy-read-only', 'legacy-bt-in-place']),
    reason: legacyReasonSchema,
    selectionKnown: z.boolean(),
    selectedFiles: z.array(z.number().int().nonnegative()).max(10000),
    origin: z
      .object({
        root: z.string(),
        identity: z.string(),
        sessionDigest: z.string().regex(/^[a-f0-9]{64}$/),
        torrentDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        profileFiles: z
          .array(
            z
              .object({
                relativePath: z.string(),
                digest: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict()
          )
          .max(3),
      })
      .strict()
      .optional(),
  })
  .strict()
export type LegacyTaskMetadata = z.infer<typeof legacyTaskMetadataSchema>
