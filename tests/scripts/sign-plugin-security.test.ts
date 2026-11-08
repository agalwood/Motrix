// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto'
import { verifySecurityPolicy } from '@core/plugin/security/policy-verifier'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node publishing entrypoint is a JavaScript module.
import { signPluginSecurityPolicy } from '../../scripts/sign-plugin-security.mjs'

describe('offline security-policy publisher', () => {
  it('produces host-verifiable envelopes and refuses accidental rollback or removal', () => {
    const keys = generateKeyPairSync('ed25519')
    const pem = keys.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()
    const publicPem = keys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString()
    const policy = {
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      advisories: [
        {
          id: 'MTX-TEST-1',
          status: 'active',
          reason: 'malware',
          affected: [{ kind: 'plugin', pluginId: 'example.test' }],
        },
      ],
    }
    const envelope = signPluginSecurityPolicy(policy, pem)
    expect(verifySecurityPolicy(envelope, [publicPem])).toEqual(policy)
    expect(() => signPluginSecurityPolicy(policy, pem, envelope)).toThrow(
      'revision'
    )
    expect(() =>
      signPluginSecurityPolicy(
        { ...policy, revision: 2, advisories: [] },
        pem,
        envelope
      )
    ).toThrow('withdrawal')
    const withdrawn = {
      ...policy,
      revision: 2,
      advisories: policy.advisories.map((entry) => ({
        ...entry,
        status: 'withdrawn',
      })),
    }
    expect(
      verifySecurityPolicy(signPluginSecurityPolicy(withdrawn, pem, envelope), [
        publicPem,
      ])
    ).toEqual(withdrawn)
    const rotated = generateKeyPairSync('ed25519')
    const rotatedPrivate = rotated.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()
    const rotatedPublic = rotated.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString()
    expect(() =>
      signPluginSecurityPolicy(withdrawn, rotatedPrivate, envelope)
    ).toThrow('signature')
    const rotatedEnvelope = signPluginSecurityPolicy(
      withdrawn,
      rotatedPrivate,
      envelope,
      publicPem
    )
    expect(
      verifySecurityPolicy(rotatedEnvelope, [publicPem, rotatedPublic])
    ).toEqual(withdrawn)
  })
})
