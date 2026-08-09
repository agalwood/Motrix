/**
 * Maximum mapping lifetime accepted from gateway responses (RFC 6887 §8.5,
 * RFC 6886 §3.5). Both PCP and NAT-PMP codecs clamp received TTL to this
 * value. Distinct from the application-layer 7200s cap in settings validators
 * which limits what the *client* requests.
 *
 * Lives in a dedicated leaf module (not the codecs barrel) so individual
 * codec files can import it directly without a module → own-barrel cycle.
 */
export const PROTOCOL_MAX_LIFETIME_SECONDS = 86400
