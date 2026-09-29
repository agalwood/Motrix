import { z } from 'zod'

const urls = z.array(z.string().min(1).max(8192)).max(10000)
export const taskTrackerOwnershipSchema = z.object({
  engineGid: z.string().min(1),
  revision: z.number().int().nonnegative(),
  original: urls,
  manual: urls,
  managed: urls,
  excluded: urls,
  isPrivate: z.boolean().nullable(),
})
export const taskTrackerStateSchema = taskTrackerOwnershipSchema.extend({
  lastError: z
    .object({
      phase: z.enum(['pause', 'write', 'resume', 'recovery']),
      at: z.number().finite().nonnegative(),
    })
    .optional(),
  pending: z
    .object({
      before: urls,
      after: urls,
      next: taskTrackerOwnershipSchema,
      resumeRequired: z.boolean(),
    })
    .nullable()
    .default(null),
})
export const taskTrackerRequestSchema = z.object({
  taskId: z.string().min(1),
  engineGid: z.string().min(1),
})
export const taskTrackerApplySchema = taskTrackerRequestSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})
export const taskTrackerEditSchema = taskTrackerRequestSchema.extend({
  trackers: urls,
})
export const taskTrackerPlanSchema = taskTrackerRequestSchema.extend({
  fingerprint: z.string(),
  added: urls,
  removed: urls,
  retained: urls,
  original: urls,
  excluded: urls,
  requiresPause: z.boolean(),
  protected: z.boolean(),
})
export type TaskTrackerOwnership = z.infer<typeof taskTrackerOwnershipSchema>
export type TaskTrackerState = z.infer<typeof taskTrackerStateSchema>
export type TaskTrackerPlan = z.infer<typeof taskTrackerPlanSchema>
