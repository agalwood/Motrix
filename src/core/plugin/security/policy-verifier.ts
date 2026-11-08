import { createPublicKey, verify } from 'node:crypto'
import { PLUGIN_SECURITY_SIGNATURE_CONTEXT } from '@shared/plugin-security-trust'
import {
  PLUGIN_SECURITY_MAX_BYTES,
  PluginSecurityEnvelopeSchema,
  type PluginSecurityIdentity,
  type PluginSecurityPolicy,
  PluginSecurityPolicySchema,
} from '@shared/schemas/plugin-security'
import { compareSemver } from '@shared/semver'

export function verifySecurityPolicy(
  raw: string,
  publicKeys: readonly string[]
): PluginSecurityPolicy {
  if (Buffer.byteLength(raw) > PLUGIN_SECURITY_MAX_BYTES)
    throw new Error('Security policy exceeds size limit')
  const envelope = PluginSecurityEnvelopeSchema.parse(JSON.parse(raw))
  const payload = Buffer.from(envelope.payload, 'base64')
  if (payload.toString('base64') !== envelope.payload)
    throw new Error('Noncanonical policy payload')
  const bytes = Buffer.concat([
    Buffer.from(PLUGIN_SECURITY_SIGNATURE_CONTEXT),
    payload,
  ])
  const valid = publicKeys.some((pem) => {
    const key = createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') return false
    return envelope.signatures.some((signature) => {
      const decoded = Buffer.from(signature, 'base64')
      return (
        decoded.length === 64 &&
        decoded.toString('base64') === signature &&
        verify(null, bytes, key, decoded)
      )
    })
  })
  if (!valid) throw new Error('Untrusted security policy signature')
  return PluginSecurityPolicySchema.parse(JSON.parse(payload.toString('utf8')))
}

export function assertPolicyTransition(
  previous: PluginSecurityPolicy | undefined,
  next: PluginSecurityPolicy
): void {
  if (!previous) return
  if (next.revision < previous.revision)
    throw new Error('Security policy rollback')
  if (
    next.revision === previous.revision &&
    JSON.stringify(next) !== JSON.stringify(previous)
  ) {
    throw new Error('Security policy revision reused')
  }
  if (Date.parse(next.issuedAt) < Date.parse(previous.issuedAt))
    throw new Error('Security policy timestamp rollback')
  const entries = new Map(next.advisories.map((entry) => [entry.id, entry]))
  for (const advisory of previous.advisories) {
    const replacement = entries.get(advisory.id)
    // Removing or narrowing an existing rule cannot silently release it.
    // Withdraw it explicitly and issue a new ID for a corrected selector.
    if (
      !replacement ||
      JSON.stringify(replacement.affected) !== JSON.stringify(advisory.affected)
    ) {
      throw new Error(
        'Security advisory removed or narrowed without withdrawal'
      )
    }
  }
}

export function matchingAdvisories(
  policy: PluginSecurityPolicy,
  identity: PluginSecurityIdentity
) {
  return policy.advisories.filter(
    (advisory) =>
      advisory.status === 'active' &&
      advisory.affected.some((selector) => {
        if (selector.kind === 'archive')
          return identity.archiveSha256 === selector.sha256
        return (
          identity.pluginId === selector.pluginId &&
          (!selector.fromInclusive ||
            compareSemver(identity.version, selector.fromInclusive) >= 0) &&
          (!selector.beforeExclusive ||
            compareSemver(identity.version, selector.beforeExclusive) < 0)
        )
      })
  )
}
