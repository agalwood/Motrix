#!/usr/bin/env node
import { createPublicKey } from 'node:crypto'
import { verifySecurityPolicy } from '../src/core/plugin/security/policy-verifier.ts'
import { BUILTIN_SIGNING_PUBKEYS } from '../src/shared/builtin-signing.ts'
import { PLUGIN_SECURITY_TRUST } from '../src/shared/plugin-security-trust.ts'

const trust = PLUGIN_SECURITY_TRUST
if (trust.publicKeys.length === 0) {
  console.log(
    'Plugin security policy is not provisioned; synchronization is dormant.'
  )
  if (process.argv.includes('--require-configured')) process.exitCode = 1
} else {
  const fingerprint = (pem) =>
    createPublicKey(pem)
      .export({ format: 'der', type: 'spki' })
      .toString('base64')
  const packageKeys = new Set(BUILTIN_SIGNING_PUBKEYS.map(fingerprint))
  if (trust.publicKeys.some((key) => packageKeys.has(fingerprint(key))))
    throw new Error('Security and package signing keys must be independent')
  if (!trust.baseline) throw new Error('A signed policy baseline is required')
  const url = new URL(trust.url)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('A static public HTTPS feed is required')
  const policy = verifySecurityPolicy(trust.baseline, trust.publicKeys)
  if (Date.parse(policy.expiresAt) <= Date.now())
    throw new Error('Refresh the signed baseline before release')
  console.log(
    `Plugin security trust verified; baseline revision ${policy.revision}.`
  )
}
