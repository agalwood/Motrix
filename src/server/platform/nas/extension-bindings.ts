import type { AuthenticatedBridgeClient } from '@core/bridge/client-authorization'
import {
  type Mbp1CredentialStore,
  type ProvisionalCredentialBinding,
  transportIdentityForPrincipal,
} from '@core/bridge/credential-store'
import type { PairCredentialIssuer } from '@core/bridge/mbp1/pair-session'
import { BrowserSchema } from '@shared/protocol/bridge'
import { z } from 'zod'
import {
  type NasAccountAuthority,
  type NasClientBindings,
  resolveNasAdministrator,
  sameNasAccount,
} from './client-authorization'
import {
  currentNasApprover,
  type NasIdentity,
  nasIdentitySchema,
} from './identity'
import type { NasPairingStorage } from './pairing-file'

const audienceSchema = z
  .object({
    browser: BrowserSchema,
    verifiedOrigin: z.string().min(1).max(512),
    pairingNonce: z.string().min(1).max(256),
  })
  .strict()
  .readonly()
export type NasExtensionAudience = z.infer<typeof audienceSchema>
interface ApprovalRecord {
  readonly owner: NasIdentity
  readonly audience: NasExtensionAudience
}

const rowSchema = z
  .object({
    credentialId: z.string().min(1).max(128),
    authorizationEpoch: z.uuid(),
    owner: nasIdentitySchema,
  })
  .strict()
const documentSchema = z
  .object({ version: z.literal(1), bindings: z.array(rowSchema).max(16384) })
  .strict()
type Row = z.infer<typeof rowSchema>
const approvalBrand: unique symbol = Symbol('nas-extension-approval')
/** An in-memory capability retained by a claimed operator prompt, never sent
 * to a client or written to disk. Only this store can issue or recognize it. */
export interface NasExtensionApproval {
  readonly [approvalBrand]: true
}
const denied = () => new Error('NAS extension approval unavailable')

/** The owner row is durable BEFORE the MBP1 store can publish its provisional.
 * Orphan owner rows are harmless; a credential whose owner is missing is never
 * rebound or inferred from the next administrator to open the application. */
export class NasExtensionBindings implements NasClientBindings {
  private rows = new Map<string, Row>()
  private readonly approvals = new WeakMap<
    NasExtensionApproval,
    ApprovalRecord
  >()

  constructor(
    private readonly credentials: Mbp1CredentialStore,
    private readonly accounts: NasAccountAuthority,
    private readonly storage: NasPairingStorage
  ) {}

  async load(): Promise<void> {
    this.rows.clear()
    const input = await this.storage.read()
    const rows =
      input === null ? [] : documentSchema.parse(JSON.parse(input)).bindings
    const index = new Map<string, Row>()
    for (const row of rows) {
      if (
        !row.owner.administrator ||
        row.owner.platform !== this.accounts.platform ||
        index.has(row.credentialId)
      )
        throw denied()
      index.set(row.credentialId, row)
    }
    this.rows = index
  }

  async approve(audience: NasExtensionAudience): Promise<NasExtensionApproval> {
    const parsedAudience = audienceSchema.parse(audience)
    const actor = currentNasApprover()
    if (!actor) throw denied()
    const current = await resolveNasAdministrator(this.accounts, actor)
    const approval: NasExtensionApproval = Object.freeze({
      [approvalBrand]: true as const,
    })
    this.approvals.set(
      approval,
      Object.freeze({ owner: current, audience: parsedAudience })
    )
    return approval
  }

  release(approval: NasExtensionApproval): void {
    this.approvals.delete(approval)
  }

  /** Used by a claimed-code endpoint to verify the requesting operator again. */
  async approvedByCurrentOperator(
    approval: NasExtensionApproval
  ): Promise<boolean> {
    const claim = this.approvals.get(approval)
    const actor = currentNasApprover()
    if (!claim || !actor) return false
    const current = await resolveNasAdministrator(this.accounts, actor)
    return (
      this.approvals.get(approval) === claim &&
      sameNasAccount(claim.owner, current)
    )
  }

  issuer(
    approval: NasExtensionApproval,
    audience: NasExtensionAudience
  ): PairCredentialIssuer {
    const claim = this.approvals.get(approval)
    if (
      !claim ||
      claim.audience.browser !== audience.browser ||
      claim.audience.verifiedOrigin !== audience.verifiedOrigin ||
      claim.audience.pairingNonce !== audience.pairingNonce
    )
      throw denied()
    const offered = new Set<string>()
    return {
      offerProvisional: async (principal, identity) => {
        if (
          principal.browser !== claim.audience.browser ||
          principal.verifiedOrigin !== claim.audience.verifiedOrigin
        )
          throw denied()
        const result = await this.credentials.offerProvisional(
          principal,
          identity,
          (metadata) => this.bindOffer(approval, metadata)
        )
        offered.add(result.credentialId)
        return result
      },
      commitFromPair: (credentialId) =>
        this.credentials.commitFromPair(credentialId, async () => {
          if (!offered.has(credentialId)) throw denied()
          const owner = await this.validateApproval(approval)
          const row = this.rows.get(credentialId)
          const credential = this.credentials.findForAuth(credentialId)
          if (
            !row ||
            !credential ||
            credential.authorizationEpoch !== row.authorizationEpoch ||
            !sameNasAccount(row.owner, owner)
          )
            throw denied()
        }),
    }
  }

  private async validateApproval(
    approval: NasExtensionApproval
  ): Promise<NasIdentity> {
    const claim = this.approvals.get(approval)
    if (!claim) throw denied()
    const current = await resolveNasAdministrator(this.accounts, claim.owner)
    if (
      this.approvals.get(approval) !== claim ||
      !sameNasAccount(claim.owner, current)
    )
      throw denied()
    return claim.owner
  }

  ownerOf(client: AuthenticatedBridgeClient): NasIdentity | undefined {
    if (
      client.identity.kind !== 'extension' ||
      client.credential.kind !== 'extension'
    )
      return undefined
    const reference = client.credential
    const row = this.rows.get(reference.credentialId)
    const current = this.credentials.findForAuth(reference.credentialId)
    const identity = current && transportIdentityForPrincipal(current.principal)
    if (
      !row ||
      !current ||
      row.authorizationEpoch !== reference.authorizationEpoch ||
      current.authorizationEpoch !== reference.authorizationEpoch ||
      identity?.browser !== client.identity.browser ||
      identity.extensionId !== client.identity.extensionId
    )
      return undefined
    return row.owner
  }

  private async bindOffer(
    approval: NasExtensionApproval,
    metadata: ProvisionalCredentialBinding
  ): Promise<void> {
    const owner = await this.validateApproval(approval)
    const existing = this.rows.get(metadata.credentialId)
    if (metadata.reused) {
      if (
        !existing ||
        existing.authorizationEpoch !== metadata.authorizationEpoch ||
        !sameNasAccount(existing.owner, owner)
      )
        throw denied()
      return
    }
    if (existing) throw denied()
    const row = rowSchema.parse({
      credentialId: metadata.credentialId,
      authorizationEpoch: metadata.authorizationEpoch,
      owner,
    })
    // The callback holds the credential mutation queue. Only old, absent or
    // expired credential generations can be removed from this owner document.
    const retained = [...this.rows.values()].filter(
      (entry) =>
        this.credentials.findForAuth(entry.credentialId)?.authorizationEpoch ===
        entry.authorizationEpoch
    )
    const document = documentSchema.parse({
      version: 1,
      bindings: [...retained, row],
    })
    await this.storage.write(JSON.stringify(document))
    this.rows = new Map(
      document.bindings.map((entry) => [entry.credentialId, entry])
    )
    // A prompt may expire while its owner row is being saved. That orphan is
    // safe; the store must not publish a credential after its claim was released.
    if (this.approvals.get(approval)?.owner !== owner) throw denied()
  }
}
