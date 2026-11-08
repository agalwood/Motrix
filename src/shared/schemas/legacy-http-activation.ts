import { z } from 'zod'
import { directResourceValidatorSchema } from './direct-replay-recipe'
import {
  legacyCheckpointFileSchema,
  legacyCheckpointMetadataSchema,
} from './legacy-checkpoint'

/** Safe recovery identity only; HTTP credentials stay in the original profile. */
export const legacyHttpActivationSchema = z
  .object({
    version: z.literal(1),
    stage: z.enum([
      'import-uncertain',
      'checkpoint',
      'create-uncertain',
      'bound',
      'resume-uncertain',
      'active',
    ]),
    token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    engineTaskId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .refine((value) => !/^0+$/.test(value)),
    targetPath: z.string().min(1).max(4096),
    saveDir: z.string().min(1).max(4096),
    rootIdentity: z.string().min(1),
    controlBackupPath: z.string().min(1),
    controlIdentity: z.string().min(1),
    controlDigest: z.string().regex(/^[a-f0-9]{64}$/),
    uriDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expected: legacyCheckpointMetadataSchema.refine(
      (value) => value.type === 'http' && value.infoHash === null
    ),
    files: z.tuple([legacyCheckpointFileSchema]),
    completedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    retainedContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resourceValidator: directResourceValidatorSchema.options[0],
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.files[0].path !== value.targetPath ||
      value.files[0].offset !== 0 ||
      value.files[0].length !== value.expected.totalBytes ||
      value.completedBytes > value.expected.totalBytes ||
      value.resourceValidator.contentLength !== value.expected.totalBytes ||
      (value.stage === 'resume-uncertain' && !value.retainedContentDigest)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'HTTP checkpoint identity mismatch',
      })
  })
export type LegacyHttpActivation = z.infer<typeof legacyHttpActivationSchema>
export const legacyHttpAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    directory: z.string(),
  })
  .strict()
