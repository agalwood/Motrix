export interface NativeBootstrapResult {
  wsPort: number
  /** One-shot pair nonce from /nonce. `null` if host fetch failed. */
  nonce: string | null
  /** Opaque attestation ticket; the server validates its contents. */
  nmTicket: unknown | null
  protocolVersion: number
}

export interface DiscoverOptions {
  allowLaunch?: boolean
  /**
   * The ephemeral binding public key, exactly 32 raw bytes. Chromium and
   * Firefox retain a ticketless legacy request when omitted. Safari supplies
   * a disposable key for endpoint-only discovery and discards its ticket;
   * pairing callers must supply the public half of their retained keypair.
   */
  bindingPub?: Uint8Array
}

export interface BootstrapProvider {
  discover(opts?: DiscoverOptions): Promise<NativeBootstrapResult>
}

export class NativeBootstrapError extends Error {
  public readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'NativeBootstrapError'
    this.code = code
  }
}

export const NATIVE_HOST_NAME = 'app.motrix.bridge'
export const BOOTSTRAP_TIMEOUT_MS = 20_000
export const BINDING_PUB_BYTES = 32
const MAX_NONCE_LENGTH = 512

/**
 * Parse the shared native-host handoff without interpreting the ticket.
 * Older Chromium/Firefox hosts omit the version on error replies; Safari's
 * app extension requires a known version and a fixed set of error codes.
 */
export function parseBootstrapResponse(
  raw: unknown,
  opts: {
    expectedProtocolVersion?: number
    allowedHostErrors?: ReadonlySet<string>
  } = {}
): NativeBootstrapResult {
  const malformed = (): never => {
    throw new NativeBootstrapError('malformed NM response', 'malformed')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return malformed()
  }
  const msg = raw as Record<string, unknown>
  if (
    opts.expectedProtocolVersion !== undefined &&
    msg.protocolVersion !== opts.expectedProtocolVersion
  ) {
    return malformed()
  }
  if (msg.error !== undefined) {
    if (
      opts.allowedHostErrors !== undefined &&
      (typeof msg.error !== 'string' || !opts.allowedHostErrors.has(msg.error))
    ) {
      return malformed()
    }
    throw new NativeBootstrapError(
      String(msg.error),
      `host-error:${String(msg.error)}`
    )
  }
  const validPort =
    typeof msg.port === 'number' &&
    Number.isInteger(msg.port) &&
    msg.port >= 1 &&
    msg.port <= 65_535
  const validNonce =
    msg.nonce === undefined ||
    msg.nonce === null ||
    (typeof msg.nonce === 'string' &&
      msg.nonce.length > 0 &&
      msg.nonce.length <= MAX_NONCE_LENGTH)
  const validProtocolVersion =
    typeof msg.protocolVersion === 'number' &&
    Number.isInteger(msg.protocolVersion) &&
    msg.protocolVersion >= 0
  // Missing/null tickets preserve the existing ticketless fallback. An
  // object is otherwise opaque; cryptographic validation belongs to MBP1.
  const validNmTicket =
    msg.nmTicket === undefined ||
    msg.nmTicket === null ||
    (typeof msg.nmTicket === 'object' && !Array.isArray(msg.nmTicket))
  if (
    msg.action !== 'requestPair' ||
    !validPort ||
    !validNonce ||
    !validProtocolVersion ||
    !validNmTicket
  ) {
    return malformed()
  }
  return {
    wsPort: msg.port as number,
    nonce: typeof msg.nonce === 'string' ? msg.nonce : null,
    nmTicket: msg.nmTicket ?? null,
    protocolVersion: msg.protocolVersion as number,
  }
}
