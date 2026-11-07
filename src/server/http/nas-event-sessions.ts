import { randomBytes } from 'node:crypto'
import type { WebEventRenewal } from '@shared/schemas/web-event-stream'
import { sameNasAccount } from '../platform/nas/client-authorization'
import type { NasIdentity } from '../platform/nas/identity'
import type { SessionSocket } from './operator-auth'

export const NAS_EVENT_AUTH_MS = 60_000
const RENEW_BEFORE_EXPIRY_MS = 15_000

interface Renewal {
  origin: string
  accept(principal: NasIdentity | undefined): boolean
}

export class NasEventSessions {
  private readonly pending = new Map<string, Renewal>()

  constructor(private readonly now: () => number) {}

  renew(
    challenge: string,
    origin: string,
    principal: NasIdentity | undefined
  ): boolean {
    const renewal = this.pending.get(challenge)
    if (!renewal || renewal.origin !== origin) return false
    this.pending.delete(challenge)
    return renewal.accept(principal)
  }

  bind(
    socket: SessionSocket,
    initialExpiry: number,
    owner: NasIdentity | undefined,
    renewalOrigin?: string
  ) {
    let expiresAt = initialExpiry
    let active = true
    let challenge: string | undefined
    let warning: NodeJS.Timeout | undefined
    let expiry: NodeJS.Timeout | undefined
    const eligible = () => active && !!owner && this.now() < expiresAt
    const disarm = () => {
      clearTimeout(warning)
      clearTimeout(expiry)
      if (challenge) this.pending.delete(challenge)
      challenge = undefined
    }
    const dispose = () => {
      active = false
      disarm()
    }
    const close = () => {
      if (!active) return
      dispose()
      socket.close(4401, 'Gateway reauthentication required')
    }
    const schedule = () => {
      disarm()
      const remaining = Math.max(0, expiresAt - this.now())
      expiry = setTimeout(close, remaining)
      expiry.unref()
      if (!renewalOrigin || !owner) return
      warning = setTimeout(
        () => {
          if (!eligible()) return close()
          challenge = randomBytes(24).toString('base64url')
          this.pending.set(challenge, {
            origin: renewalOrigin,
            accept: (principal) => {
              if (
                !eligible() ||
                !principal?.administrator ||
                !sameNasAccount(principal, owner)
              ) {
                close()
                return false
              }
              expiresAt = this.now() + NAS_EVENT_AUTH_MS
              schedule()
              return true
            },
          })
          const frame: WebEventRenewal = {
            type: 'session-renewal',
            version: 1,
            challenge,
          }
          try {
            socket.send(JSON.stringify(frame), (error) => {
              if (error) close()
            })
          } catch {
            close()
          }
        },
        Math.max(0, remaining - RENEW_BEFORE_EXPIRY_MS)
      )
      warning.unref()
    }
    schedule()
    return { eligible, dispose }
  }
}
