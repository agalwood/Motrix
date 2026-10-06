/**
 * Build-time security-policy trust. Keep these keys independent of package
 * signing keys. Production provisioning must supply the public keys and a
 * signed baseline before enabling the feed; runtime overrides are forbidden.
 * No production signing key or endpoint has been provisioned in this build.
 */
export const PLUGIN_SECURITY_TRUST: {
  url: string
  publicKeys: readonly string[]
  baseline: string | null
} = {
  url: 'https://dl.motrix.app/security/plugins-v1.json',
  publicKeys: [],
  baseline: null,
}

export const PLUGIN_SECURITY_SIGNATURE_CONTEXT = 'motrix-plugin-security-v1\n'
