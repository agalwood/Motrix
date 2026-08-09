import fs from 'node:fs/promises'
import path from 'node:path'
import type { Browser, ClientIdentity } from '@shared/protocol/bridge'
import writeFileAtomic from 'write-file-atomic'
import type { PairedClient, PairingStore } from './pairing-service'

/**
 * Plaintext pairing persistence. One JSON document (array of pairings) at the
 * userData top level, e.g. `<userData>/pairing.json` — sibling of
 * `tracker.json`. Mirrors `TrackerStore`; no encryption (the token is also
 * stored plaintext on the extension side, so app-side encryption adds no real
 * protection and triggers the macOS Keychain prompt).
 *
 * On load, legacy (Spec 1/2) flat extension records `{ extensionId, browser,
 * token, name, … }` are migrated forward to the `ClientIdentity`-keyed
 * `PairedClient` shape `{ identity: { kind:'extension', browser, extensionId },
 * … }` so a pre-7a `pairing.json` keeps working.
 */
export class FilePairingStore implements PairingStore {
  constructor(private filePath: string) {}

  async load(): Promise<PairedClient[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((rec) => migrateRecord(rec))
        .filter((c): c is PairedClient => c !== null)
    } catch {
      return []
    }
  }

  async save(list: PairedClient[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // Atomic: writes to a temp file, fsyncs, renames over the target — a crash
    // mid-write leaves the previous pairing.json intact.
    //
    // Owner-only (0600): pairing.json holds bearer tokens — extension AND
    // device-code cli/agent tokens (the latter authorize remote /mdxp writes +
    // SSE), so it must be as protected as endpoint.json / credentials.json. The
    // renamed atomic file gets `mode`; the explicit chmod enforces 0600 even on
    // a pre-existing, looser file.
    await writeFileAtomic(this.filePath, JSON.stringify(list, null, 2), {
      mode: 0o600,
    })
    await fs.chmod(this.filePath, 0o600)
  }
}

/** Normalize one on-disk record to a `PairedClient`, migrating legacy flat
 *  extension records. Returns null for unrecognized/incomplete records. */
function migrateRecord(rec: unknown): PairedClient | null {
  if (!rec || typeof rec !== 'object') return null
  const r = rec as Record<string, unknown>
  if (typeof r.token !== 'string') return null

  const base = {
    token: r.token,
    name: typeof r.name === 'string' ? r.name : '',
    pairedAt: typeof r.pairedAt === 'number' ? r.pairedAt : Date.now(),
    lastActiveAt: typeof r.lastActiveAt === 'number' ? r.lastActiveAt : null,
  }

  // Already the new ClientIdentity-keyed shape — validate the discriminant and
  // its required fields rather than trusting the on-disk object, so a partial
  // or corrupt record can never load as a malformed PairedClient. (Symmetric
  // with the legacy-record validation below: pairing.json is untrusted input.)
  if (isValidIdentity(r.identity)) {
    return { identity: r.identity, ...base }
  }

  // Legacy flat extension record → inject the extension identity.
  if (typeof r.extensionId === 'string' && typeof r.browser === 'string') {
    return {
      identity: {
        kind: 'extension',
        browser: r.browser as Browser,
        extensionId: r.extensionId,
      },
      ...base,
    }
  }

  return null
}

/** Structural guard for a persisted `ClientIdentity`: the `kind` discriminant
 *  plus the string fields that variant requires. Rejects arrays, null, and
 *  records with an unknown/missing `kind` or a missing id field. */
function isValidIdentity(v: unknown): v is ClientIdentity {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (o.kind === 'extension') {
    return typeof o.browser === 'string' && typeof o.extensionId === 'string'
  }
  if (o.kind === 'cli') {
    return typeof o.id === 'string'
  }
  return false
}
