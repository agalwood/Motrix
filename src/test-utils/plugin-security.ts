import { generateKeyPairSync, sign } from 'node:crypto'
import { PLUGIN_SECURITY_SIGNATURE_CONTEXT } from '@shared/plugin-security-trust'
import type { PluginSecurityPolicy } from '@shared/schemas/plugin-security'

export function securityFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    trust: {
      url: 'https://security.example.test/plugins-v1.json',
      publicKeys: [publicPem],
      baseline: null,
    },
    policy: (
      now: number,
      patch: Partial<PluginSecurityPolicy> = {}
    ): PluginSecurityPolicy => ({
      schemaVersion: 1,
      revision: 1,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
      advisories: [
        {
          id: 'MTX-TEST-1',
          status: 'active',
          reason: 'malware',
          affected: [
            {
              kind: 'plugin',
              pluginId: 'alice.demo',
              beforeExclusive: '2.0.0',
            },
          ],
        },
      ],
      ...patch,
    }),
    sign: (policy: unknown): string => {
      const payload = Buffer.from(JSON.stringify(policy))
      const signature = sign(
        null,
        Buffer.concat([
          Buffer.from(PLUGIN_SECURITY_SIGNATURE_CONTEXT),
          payload,
        ]),
        privateKey
      )
      return JSON.stringify({
        payload: payload.toString('base64'),
        signatures: [signature.toString('base64')],
      })
    },
  }
}
