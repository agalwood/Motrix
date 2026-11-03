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
    a.username === b.username
  )
}

export class NasClientAuthorization implements BridgeClientAuthorization {
  constructor(
    private readonly bindings: NasClientBindings,
    private readonly accounts: NasAccountAuthority,
    private readonly timeoutMs = 5000
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000)
      throw new Error('Invalid NAS account lookup timeout')
  }

  async run<T>(
    client: AuthenticatedBridgeClient,
    operation: () => Promise<T>
  ): Promise<T> {
    const denied = () =>
      makeMdxpError(
        ErrorCodes.PermissionDenied,
        'NAS client authorization unavailable'
      )
    const bound = this.bindings.ownerOf(client)
    if (!bound?.administrator || bound.platform !== this.accounts.platform)
      throw denied()
    let current: NasIdentity | null
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new Error('NAS account lookup timed out'))
        }, this.timeoutMs)
      })
      const result = await Promise.race([
        this.accounts.resolve(bound, controller.signal),
        deadline,
      ])
      current = result === null ? null : nasIdentitySchema.parse(result)
    } catch {
      throw denied()
    } finally {
      clearTimeout(timeout)
    }
    if (!current?.administrator || !sameNasAccount(bound, current))
      throw denied()
    // Revoke/rotation may have completed while the vendor lookup was pending.
    const latest = this.bindings.ownerOf(client)
    if (!latest?.administrator || !sameNasAccount(bound, latest)) throw denied()
    return runAsNasUser(current, operation)
  }
}
