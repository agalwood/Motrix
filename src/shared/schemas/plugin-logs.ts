import { z } from 'zod'

export const PLUGIN_LOG_VERBOSE_TTL_MS = 60 * 60 * 1000

export const PluginLogRequestSchema = z.object({
  pluginId: z.string().min(1),
})
export const PluginLogVerboseRequestSchema = PluginLogRequestSchema.extend({
  verbose: z.boolean(),
})
export const PluginLogStateSchema = z.object({
  verbose: z.boolean(),
  expiresAt: z.number().nullable(),
})
export type PluginLogState = z.infer<typeof PluginLogStateSchema>
