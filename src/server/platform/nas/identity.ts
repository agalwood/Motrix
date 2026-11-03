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
  })
  .strict()
  .readonly()

export type NasIdentity = z.infer<typeof nasIdentitySchema>
export type NasPlatform = NasIdentity['platform']

const user = new AsyncLocalStorage<NasIdentity>()

export function currentNasUser(): NasIdentity | undefined {
  return user.getStore()
}

/** Keep concurrent gateway and paired-client operations in separate contexts. */
export function runAsNasUser<T>(identity: NasIdentity, operation: () => T): T {
  return user.run(nasIdentitySchema.parse(identity), operation)
}
