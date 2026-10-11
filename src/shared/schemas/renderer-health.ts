import { z } from 'zod'

export const rendererGenerationSchema = z.string().uuid()
export const rendererSurfaceSchema = z.enum([
  'boot',
  'app',
  'route-error',
  'fatal-fallback',
  'missing',
])
export const rendererCapabilitySchema = z.enum([
  'navigation',
  'add-task-hydration',
])

export const rendererRecoveryStringsSchema = z.object({
  title: z.string(),
  description: z.string(),
  recovering: z.string(),
  recover: z.string(),
  diagnostics: z.string(),
  downloads: z.string(),
  failed: z.string(),
  restored: z.string(),
})

export const rendererSessionSchema = z.object({
  generation: rendererGenerationSchema,
  windowId: z.enum(['main', 'add-task', 'onboarding']),
  route: z.string().max(2048).optional(),
  recovered: z.boolean(),
  submissionNeedsReview: z.boolean(),
  strings: rendererRecoveryStringsSchema,
})

export const rendererSurfaceReportSchema = z.object({
  generation: rendererGenerationSchema,
  surface: rendererSurfaceSchema,
  capabilities: z.array(rendererCapabilitySchema).max(2),
  documentVisible: z.boolean(),
  route: z.string().max(2048).optional(),
})

export const rendererProbeSchema = z.object({
  generation: rendererGenerationSchema,
  challengeId: z.string().uuid(),
})

export const rendererProbeReplySchema = rendererProbeSchema.extend({
  surface: rendererSurfaceSchema,
  rootPresent: z.boolean(),
  documentVisible: z.boolean(),
})

export const rendererFailureSchema = z.object({
  generation: rendererGenerationSchema,
  scope: z.enum(['bootstrap', 'root', 'route', 'async']),
  errorCode: z.enum([
    'load-failed',
    'boot-timeout',
    'render-failed',
    'unexpected-error',
  ]),
})

export const rendererRecoveryRequestSchema = z.object({
  generation: rendererGenerationSchema,
})

export type RendererSurface = z.infer<typeof rendererSurfaceSchema>
export type RendererCapability = z.infer<typeof rendererCapabilitySchema>
export type RendererSession = z.infer<typeof rendererSessionSchema>
export type RendererSurfaceReport = z.infer<typeof rendererSurfaceReportSchema>
export type RendererProbeReply = z.infer<typeof rendererProbeReplySchema>
export type RendererFailure = z.infer<typeof rendererFailureSchema>
export type RendererRecoveryStrings = z.infer<
  typeof rendererRecoveryStringsSchema
>
