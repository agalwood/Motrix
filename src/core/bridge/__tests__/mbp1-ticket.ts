// Mints §9.2 NM attestation tickets for the transport tests, exactly as the
// native-messaging host would: the ticket key derives from `localToken`, which
// the test harness shares with the server under test.
//
// Composed from the production `mbp1/` primitives (`deriveTicketKey`,
// `ticketMacInput`) rather than a re-derived MAC input, so a change to either
// breaks here instead of silently agreeing with itself.
//
// Test-only. Nothing in `src/` imports this.

import { randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { Browser } from '@shared/protocol/bridge'
import { hmacSha256, toBase64Url } from '../mbp1/canonical'
import { deriveTicketKey, ticketMacInput } from '../mbp1/ticket-verify'
import type { ClientTicket } from './mbp1-client'

const TICKET_VERSION = 1
const TICKET_PURPOSE = 'mbp1-attestation'
const TICKET_PROTOCOL_VERSION = 1

/** Comfortably inside §9.2's 60 s remaining-lifetime bound. */
const DEFAULT_REMAINING_SECONDS = 30

/**
 * A `Buffer` is NOT accepted by `@noble` here. The suite runs under vitest's
 * jsdom environment, whose `Uint8Array` comes from a different realm than the
 * one `node:buffer` builds its `Buffer` prototype chain from, so noble's
 * `isBytes` (`a instanceof Uint8Array`) answers `false` for every `Buffer` and
 * reports the perfectly-shaped key as `got type=object`. Every byte string
 * crossing into a noble call must therefore be a real `Uint8Array`.
 */
function toBytes(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf)
}

export function mintTicket(opts: {
  localToken: string
  serverGeneration: string
  browser: Browser
  callerId: string
  /** Overrides `v`, `purpose`, or `protocolVersion` for the format rows. */
  overrides?: Partial<{
    v: number
    purpose: string
    protocolVersion: number
    exp: number
  }>
}): ClientTicket {
  const bindingPriv = toBytes(randomBytes(32))
  const bindingPub = ed25519.getPublicKey(bindingPriv)
  const fields = {
    v: opts.overrides?.v ?? TICKET_VERSION,
    purpose: opts.overrides?.purpose ?? TICKET_PURPOSE,
    protocolVersion: opts.overrides?.protocolVersion ?? TICKET_PROTOCOL_VERSION,
    serverGeneration: opts.serverGeneration,
    browser: opts.browser,
    callerId: opts.callerId,
    exp:
      opts.overrides?.exp ??
      Math.floor(Date.now() / 1000) + DEFAULT_REMAINING_SECONDS,
  }
  const mac = hmacSha256(
    deriveTicketKey(opts.localToken),
    ticketMacInput({ ...fields, bindingPub })
  )

  return {
    wire: {
      ...fields,
      bindingPub: toBase64Url(bindingPub),
      mac: toBase64Url(mac),
    },
    bindingKeyB64: toBase64Url(bindingPub),
    sign: (message) => ed25519.sign(toBytes(message), bindingPriv),
  }
}
