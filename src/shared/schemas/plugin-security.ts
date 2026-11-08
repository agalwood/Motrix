import { compareSemver } from '@shared/semver'
import { z } from 'zod'

export const PLUGIN_SECURITY_INTERVAL_MS = 12 * 60 * 60 * 1000
export const PLUGIN_SECURITY_FRESHNESS_MS = 24 * 60 * 60 * 1000
export const PLUGIN_SECURITY_MAX_BYTES = 256 * 1024

// Bounds use SemVer precedence, including prereleases, with no implicit
// prerelease exclusion or host-version normalization.
const version = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
  )
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const pluginId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/)
const advisoryId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z0-9-]+$/)

const versionSelector = z
  .object({
    kind: z.literal('plugin'),
    pluginId,
    fromInclusive: version.optional(),
    beforeExclusive: version.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.fromInclusive ||
      !value.beforeExclusive ||
      compareSemver(value.fromInclusive, value.beforeExclusive) < 0,
    'Version bounds must describe a nonempty interval'
  )

export const PluginSecuritySelectorSchema = z.discriminatedUnion('kind', [
  versionSelector,
  z.object({ kind: z.literal('archive'), sha256 }).strict(),
])

export const PluginSecurityAdvisorySchema = z
  .object({
    id: advisoryId,
    status: z.enum(['active', 'withdrawn']),
    reason: z.enum(['malware', 'vulnerability', 'compromised']),
    affected: z.array(PluginSecuritySelectorSchema).min(1).max(100),
    fixedVersion: version.optional(),
    // Rendered as a link, never fetched or executed by the host.
    url: z
      .string()
      .max(512)
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          url.hostname === 'motrix.app' &&
          !url.username &&
          !url.password &&
          !url.port
        )
      })
      .optional(),
  })
  .strict()

export const PluginSecurityPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    advisories: z.array(PluginSecurityAdvisorySchema).max(1000),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const issued = Date.parse(policy.issuedAt)
    const expires = Date.parse(policy.expiresAt)
    if (expires <= issued || expires - issued > 14 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({
        code: 'custom',
        message: 'Policy lifetime must be at most 14 days',
      })
    }
    if (
      new Set(policy.advisories.map((entry) => entry.id)).size !==
      policy.advisories.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate advisory ID' })
    }
  })

// The signature covers the exact decoded UTF-8 payload bytes, with a domain
// separator. No JSON canonicalization and no trust in HTTP validators.
export const PluginSecurityEnvelopeSchema = z
  .object({
    payload: z
      .string()
      .min(1)
      .max(PLUGIN_SECURITY_MAX_BYTES)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    signatures: z
      .array(
        z
          .string()
          .length(88)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      )
      .min(1)
      .max(4),
  })
  .strict()

export const PluginSecurityDecisionSchema = z
  .object({
    blocked: z.literal(true),
    reason: z.enum([
      'malware',
      'vulnerability',
      'compromised',
      'unavailable',
      'pending',
    ]),
    advisoryIds: z.array(advisoryId),
    fixedVersion: version.optional(),
    url: z.string().optional(),
  })
  .strict()

export type PluginSecurityPolicy = z.infer<typeof PluginSecurityPolicySchema>
export type PluginSecurityEnvelope = z.infer<
  typeof PluginSecurityEnvelopeSchema
>
export type PluginSecurityDecision = z.infer<
  typeof PluginSecurityDecisionSchema
>

export interface PluginSecurityIdentity {
  pluginId: string
  version: string
  archiveSha256?: string
}
