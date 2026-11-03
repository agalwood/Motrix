import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\P{Cc}+$/u)

/** Platform account IDs are opaque, even when a vendor currently uses a UID.
 * Structural validation does not authenticate a user: only a trusted platform
 * session or a revalidated client binding may supply this identity. */
export const nasIdentitySchema = z
  .object({
    platform: z.enum(['fnos', 'synology', 'qnap']),
    userId: identifier,
    username: identifier,
    administrator: z.boolean(),
    /** Opaque vendor account generation; for example it changes on password
     * replacement or account recreation. It is never a NAS session secret. */
    accountRevision: identifier.optional(),
  })
  .strict()
  .readonly()

export type NasIdentity = z.infer<typeof nasIdentitySchema>
export type NasPlatform = NasIdentity['platform']

const user = new AsyncLocalStorage<{
  identity: NasIdentity
  source: 'gateway' | 'operation'
}>()

export function currentNasUser(): NasIdentity | undefined {
  return user.getStore()?.identity
}

/** Only the trusted gateway adapter and its revalidated approval handler may
 * establish an operator context. A paired client must never inherit it. */
export function runAsNasGatewayUser<T>(
  identity: NasIdentity,
  operation: () => T
): T {
  return user.run(
    { identity: nasIdentitySchema.parse(identity), source: 'gateway' },
    operation
  )
}

export function currentNasApprover(): NasIdentity | undefined {
  const context = user.getStore()
  return context?.source === 'gateway' ? context.identity : undefined
}

/** File checks and paired-client operations carry identity without permission
 * to approve new credentials, even when nested inside a gateway request. */
export function runAsNasUser<T>(identity: NasIdentity, operation: () => T): T {
  return user.run(
    { identity: nasIdentitySchema.parse(identity), source: 'operation' },
    operation
  )
}
