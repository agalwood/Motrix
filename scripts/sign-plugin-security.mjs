#!/usr/bin/env node
// Run with: node --import tsx scripts/sign-plugin-security.mjs --input policy.json
// --key /secure/signing.pem --output signed.json [--previous previous-signed.json]
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  assertPolicyTransition,
  verifySecurityPolicy,
} from '../src/core/plugin/security/policy-verifier.ts'
import { PLUGIN_SECURITY_SIGNATURE_CONTEXT } from '../src/shared/plugin-security-trust.ts'
import { PluginSecurityPolicySchema } from '../src/shared/schemas/plugin-security.ts'

export function signPluginSecurityPolicy(
  input,
  privateKeyPem,
  previousEnvelope,
  previousPublicKeyPem
) {
  const policy = PluginSecurityPolicySchema.parse(input)
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error('An Ed25519 key is required')
  const publicKey = createPublicKey(key)
    .export({ format: 'pem', type: 'spki' })
    .toString()
  if (previousEnvelope) {
    const previous = verifySecurityPolicy(previousEnvelope, [
      previousPublicKeyPem ?? publicKey,
    ])
    if (policy.revision <= previous.revision)
      throw new Error('Publication requires a new revision')
    assertPolicyTransition(previous, policy)
  }
  const now = Date.now()
  if (
    Date.parse(policy.issuedAt) > now + 5 * 60_000 ||
    Date.parse(policy.expiresAt) <= now
  )
    throw new Error('Cannot publish an expired or future policy')
  const payload = Buffer.from(JSON.stringify(policy))
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(PLUGIN_SECURITY_SIGNATURE_CONTEXT), payload]),
    key
  )
  const envelope = JSON.stringify({
    payload: payload.toString('base64'),
    signatures: [signature.toString('base64')],
  })
  verifySecurityPolicy(envelope, [publicKey])
  return `${envelope}\n`
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      key: { type: 'string' },
      output: { type: 'string' },
      previous: { type: 'string' },
      'previous-public-key': { type: 'string' },
    },
  })
  if (!values.input || !values.key || !values.output)
    throw new Error('--input, --key and --output are required')
  const envelope = signPluginSecurityPolicy(
    JSON.parse(await readFile(values.input, 'utf8')),
    await readFile(values.key, 'utf8'),
    values.previous ? await readFile(values.previous, 'utf8') : undefined,
    values['previous-public-key']
      ? await readFile(values['previous-public-key'], 'utf8')
      : undefined
  )
  // Never overwrite an existing publication artifact or print key material.
  await writeFile(values.output, envelope, { flag: 'wx', mode: 0o600 })
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
