import { z } from 'zod'

/** Additive response fields remain compatible with older desktop/server hosts. */
export const settingsUpdateResultSchema = z.object({
  saved: z.boolean(),
  requiresRestart: z.boolean().optional(),
  changedRestartKeys: z.array(z.string()).optional(),
  requiresAppRestart: z.boolean().optional(),
  changedAppRestartKeys: z.array(z.string()).optional(),
  protocolAssociationApplied: z.boolean().optional(),
  applicationFailed: z.boolean().optional(),
})

export type SettingsUpdateResult = z.infer<typeof settingsUpdateResultSchema>
