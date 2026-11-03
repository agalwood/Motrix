import type {
  AuthenticatedBridgeClient,
  BridgeClientAuthorization,
} from '@core/bridge/client-authorization'
import { ErrorCodes, makeMdxpError } from '@motrix/mdxp'
import {
  type NasIdentity,
  type NasPlatform,
  nasIdentitySchema,
  runAsNasUser,
} from './identity'

/** Implemented by the vendor adapter using current authoritative account data.
 * Returning a previously cached gateway claim is not account revalidation. */
export interface NasAccountAuthority {
  readonly platform: NasPlatform
  resolve(
    identity: NasIdentity,
    signal: AbortSignal
  ): Promise<NasIdentity | null>
}

export interface NasClientBindings {
  ownerOf(client: AuthenticatedBridgeClient): NasIdentity | undefined
}

export function sameNasAccount(a: NasIdentity, b: NasIdentity): boolean {
  return (
    a.platform === b.platform &&
    a.userId === b.userId &&
    a.username === b.username &&
    a.accountRevision === b.accountRevision
  )
}

const denied = () =>
  makeMdxpError(
    ErrorCodes.PermissionDenied,
    'NAS client authorization unavailable'
  )

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
    throw new Error('Invalid NAS account lookup timeout')
}

/** Refresh an authenticated gateway identity before issuing credentials. The
 * adapter may add an account generation, but cannot switch the approving user. */
export async function resolveNasAdministrator(
  accounts: NasAccountAuthority,
  identity: NasIdentity,
  timeoutMs = 5000
): Promise<NasIdentity> {
  validateTimeout(timeoutMs)
  if (!identity.administrator || identity.platform !== accounts.platform)
    throw denied()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(denied())
      }, timeoutMs)
    })
    const result = await Promise.race([
      accounts.resolve(identity, controller.signal),
      deadline,
    ])
    const current = nasIdentitySchema.parse(result)
    if (
      !current.administrator ||
      current.platform !== identity.platform ||
      current.userId !== identity.userId ||
      current.username !== identity.username
    )
      throw denied()
    return current
  } catch {
    throw denied()
  } finally {
    clearTimeout(timeout)
  }
}

export class NasClientAuthorization implements BridgeClientAuthorization {
  constructor(
    private readonly bindings: NasClientBindings,
    private readonly accounts: NasAccountAuthority,
    private readonly timeoutMs = 5000
  ) {
    validateTimeout(timeoutMs)
  }

  async run<T>(
    client: AuthenticatedBridgeClient,
    operation: () => Promise<T>
  ): Promise<T> {
    const bound = this.bindings.ownerOf(client)
    if (!bound) throw denied()
    const current = await resolveNasAdministrator(
      this.accounts,
      bound,
      this.timeoutMs
    )
    if (!sameNasAccount(bound, current)) throw denied()
    // Revoke/rotation may have completed while the vendor lookup was pending.
    const latest = this.bindings.ownerOf(client)
    if (!latest?.administrator || !sameNasAccount(bound, latest)) throw denied()
    return runAsNasUser(current, operation)
  }
}
