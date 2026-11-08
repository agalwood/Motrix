import { z } from 'zod'
import {
  legacyCheckpointFileSchema,
  legacyCheckpointMetadataSchema,
} from './legacy-checkpoint'

/** Durable user authorization and recovery identity, never an engine add request. */
export const legacyBtActivationSchema = z
  .object({
    version: z.literal(1),
    stage: z.enum([
      'import-uncertain',
      'checkpoint',
      'create-uncertain',
      'bound',
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
    controlDigest: z.string().regex(/^[a-f0-9]{64}$/),
    torrentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expected: legacyCheckpointMetadataSchema,
    files: z.array(legacyCheckpointFileSchema).min(1).max(10000),
    selectedFiles: z.array(z.number().int().nonnegative()).min(1).max(10000),
    trackers: z.array(z.string()).max(10000),
    isPrivate: z.boolean(),
  })
  .strict()
export type LegacyBtActivation = z.infer<typeof legacyBtActivationSchema>
export const legacyBtAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    directory: z.string(),
  })
  .strict()
