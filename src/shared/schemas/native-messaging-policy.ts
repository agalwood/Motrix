import { z } from 'zod'

// This is the host's registration policy, not evidence that a browser has
// discovered or connected to the application.
export const NativeMessagingRegistrationPolicySchema = z.discriminatedUnion(
  'mode',
  [
    z.object({ mode: z.literal('managed') }).strict(),
    z.object({ mode: z.literal('external') }).strict(),
    z
      .object({
        mode: z.literal('unsupported'),
        reason: z.enum(['windows-package', 'server']),
      })
      .strict(),
  ]
)

export type NativeMessagingRegistrationPolicy = z.infer<
  typeof NativeMessagingRegistrationPolicySchema
>
