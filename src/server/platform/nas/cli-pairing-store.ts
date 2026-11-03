import {
  type AuthenticatedBridgeClient,
  cliCredentialFingerprint,
} from '@core/bridge/client-authorization'
import type { PairedClient, PairingStore } from '@core/bridge/pairing-service'
import { z } from 'zod'
import type { NasClientBindings } from './client-authorization'
import {
  currentNasApprover,
  type NasIdentity,
  type NasPlatform,
  nasIdentitySchema,
} from './identity'
import type { NasPairingStorage } from './pairing-file'

const clientSchema = z
  .object({
    identity: z
      .object({ kind: z.literal('cli'), id: z.string().min(1).max(256) })
      .strict(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    name: z.string().max(1024),
    pairedAt: z.number().int().nonnegative().safe(),
    lastActiveAt: z.number().int().nonnegative().safe().nullable(),
  })
  .strict()
const rowSchema = z
  .object({ client: clientSchema, owner: nasIdentitySchema })
  .strict()
const documentSchema = z
  .object({ version: z.literal(1), clients: z.array(rowSchema).max(4096) })
  .strict()
type Row = z.infer<typeof rowSchema>

/** Credentials and their NAS owner commit in one atomic document. PairingService
 * serializes saves and publishes a token only after this store succeeds. */
export class NasCliPairingStore implements PairingStore, NasClientBindings {
  private rows = new Map<string, Row>()
  constructor(
    private readonly platform: NasPlatform,
    private readonly storage: NasPairingStorage
  ) {}

  private index(rows: Row[]): Map<string, Row> {
    const index = new Map<string, Row>()
    const identities = new Set<string>()
    for (const row of rows) {
      const fingerprint = cliCredentialFingerprint(row.client.token)
      if (
        row.owner.platform !== this.platform ||
        !row.owner.administrator ||
        index.has(fingerprint) ||
        identities.has(row.client.identity.id)
      )
        throw new Error('Invalid NAS pairing ownership')
      identities.add(row.client.identity.id)
      index.set(fingerprint, row)
    }
    return index
  }

  async load(): Promise<PairedClient[]> {
    this.rows.clear()
    // A malformed/unbound legacy document is not silently converted into an
    // administrator delegation. The caller must repair it or pair again.
    const value = await this.storage.read()
    const clients =
      value === null ? [] : documentSchema.parse(JSON.parse(value)).clients
    this.rows = this.index(clients)
    return clients.map((row) => ({
      ...row.client,
      identity: { ...row.client.identity },
    }))
  }

  async save(list: PairedClient[]): Promise<void> {
    const actor = currentNasApprover()
    const rows = list.map((value) => {
      const client = clientSchema.parse(value)
      const existing = this.rows.get(cliCredentialFingerprint(client.token))
      if (existing && existing.client.identity.id !== client.identity.id)
        throw new Error('NAS credential identity changed')
      const owner = existing?.owner ?? actor
      if (!owner?.administrator || owner.platform !== this.platform)
        throw new Error('NAS administrator approval required')
      return rowSchema.parse({ client, owner })
    })
    const document = documentSchema.parse({ version: 1, clients: rows })
    const index = this.index(document.clients)
    await this.storage.write(JSON.stringify(document))
    this.rows = index
  }

  ownerOf(client: AuthenticatedBridgeClient): NasIdentity | undefined {
    if (
      client.identity.kind !== 'cli' ||
      client.credential.kind !== 'paired-cli'
    )
      return undefined
    const row = this.rows.get(client.credential.fingerprint)
    return row?.client.identity.id === client.identity.id
      ? row.owner
      : undefined
  }
}
