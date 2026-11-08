import { ed25519 } from '@noble/curves/ed25519.js'
import { concatBytes, enc, fromBase64Url } from './canonical'
import { nmTicketWireSchema } from './frames'
import { validateBindingPub } from './ticket-verify'
import { ticketDigest } from './transcript'

export function bindSafariResume(
  rt: Uint8Array,
  publicKey: string,
  nmTicket?: unknown
): Uint8Array {
  let digest: Uint8Array = new Uint8Array()
  if (nmTicket !== undefined) {
    const ticket = nmTicketWireSchema.parse(nmTicket)
    digest = ticketDigest({
      ...ticket,
      bindingPub: fromBase64Url(ticket.bindingPub),
      mac: fromBase64Url(ticket.mac),
    })
  }
  return concatBytes(
    rt,
    enc('MBP1/safari-resume/v1'),
    enc(fromBase64Url(publicKey)),
    enc(digest)
  )
}

export function verifySafariResume(
  publicKey: string,
  proof: string,
  s: Uint8Array,
  c: Uint8Array,
  rt: Uint8Array
): boolean {
  try {
    if (!validateBindingPub(fromBase64Url(publicKey))) return false
    return ed25519.verify(
      fromBase64Url(proof),
      concatBytes(enc('MBP1/safari-resume-proof/v1'), s, c, rt),
      fromBase64Url(publicKey),
      { zip215: false }
    )
  } catch {
    return false
  }
}
