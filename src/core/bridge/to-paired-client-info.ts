import type { PairedClientInfo } from '@shared/protocol/bridge'
import type { ExtensionPairingProjection } from './extension-pairing-projection'
import type { PairedClient } from './pairing-service'

/**
 * Map an internal pairing record to the renderer-facing DTO. Crucially this
 * DROPS `token` (a secret that must never reach the renderer); surfaces the
 * identity `kind` + its id (extension id or cli id) and, for an extension, the
 * `browser`.
 */
export function toPairedClientInfo(
  p: PairedClient | ExtensionPairingProjection
): PairedClientInfo {
  const base = {
    name: 'name' in p ? p.name : '',
    pairedAt: p.pairedAt,
    lastActiveAt: p.lastActiveAt,
  }
  if (p.identity.kind === 'extension') {
    if (!('identityTrust' in p) || !('status' in p)) {
      throw new Error('token-backed extension projection rejected')
    }
    return {
      kind: 'extension',
      id: p.identity.extensionId,
      browser: p.identity.browser,
      identityTrust: p.identityTrust,
      status: p.status,
      ...base,
    }
  }
  return { kind: 'cli', id: p.identity.id, ...base }
}
