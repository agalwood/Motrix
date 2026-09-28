import { z } from 'zod'

export const appImageNativeHostActionSchema = z.enum([
  'enable',
  'repair',
  'remove',
])
export const appImageNativeHostIssueSchema = z.enum([
  'conflict',
  'permissions',
  'invalid',
  'sourceChanged',
  'missing',
  'io',
])
export const appImageNativeHostViewSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(false) }),
  z.object({
    supported: z.literal(true),
    enabled: z.boolean(),
    consent: z.enum(['unset', 'accepted', 'declined']),
    target: z.string(),
    currentTarget: z.boolean(),
    healthy: z.boolean(),
    issue: appImageNativeHostIssueSchema.nullable(),
  }),
])
export type AppImageNativeHostView = z.infer<
  typeof appImageNativeHostViewSchema
>
export type AppImageNativeHostIssue = z.infer<
  typeof appImageNativeHostIssueSchema
>
