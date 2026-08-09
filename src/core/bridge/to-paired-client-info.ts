import type { PairedClientInfo } from '@shared/protocol/bridge'
import type { PairedClient } from './pairing-service'

/**
 * Map an internal pairing record to the renderer-facing DTO. Crucially this
 * DROPS `token` (a secret that must never reach the renderer); surfaces the
 * identity `kind` + its id (extension id or cli id) and, for an extension, the
 * `browser`.
 */
export function toPairedClientInfo(p: PairedClient): PairedClientInfo {
  const base = {
    name: p.name,
    pairedAt: p.pairedAt,
    lastActiveAt: p.lastActiveAt,
  }
  if (p.identity.kind === 'extension') {
    return {
      kind: 'extension',
      id: p.identity.extensionId,
      browser: p.identity.browser,
      ...base,
    }
  }
  return { kind: 'cli', id: p.identity.id, ...base }
}
