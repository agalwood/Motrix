import { join } from 'node:path'
import type { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { loadOrCreateBridgeInstanceId } from '@core/bridge/bridge-identity'
import {
  type CommittedExtensionCredentialWitness,
  Mbp1CredentialStore,
} from '@core/bridge/credential-store'
import {
  createExtensionIdentityResolver,
  type ExtensionIdentityResolver,
} from '@core/bridge/extension-identity-resolver'
import { ExtensionPairingProjectionService } from '@core/bridge/extension-pairing-projection'
import { FileExtensionPairingProjectionStore } from '@core/bridge/file-extension-pairing-projection-store'
import type {
  ExtensionRevocationLease,
  WebSocketBridgeServer,
} from '@core/bridge/web-socket-bridge-server'
import { AsyncWorkTracker } from '@core/inspector-activity/async-work-tracker'
import type {
  ClientIdentity,
  ResolvePairParams,
  ResolvePairResult,
} from '@shared/protocol/bridge'
import { ServerExtensionPairingPromptAdapter } from './extension-pairing-prompt-adapter'

const CREDENTIAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000

function identityMatchesWitness(
  identity: ClientIdentity & { kind: 'extension' },
  witness: CommittedExtensionCredentialWitness
): boolean {
  return (
    witness.identity.browser === identity.browser &&
    witness.identity.extensionId === identity.extensionId
  )
}

export interface ServerExtensionMbp1RuntimeOptions {
  readonly dataDir: string
  readonly bus: BridgeEventBus
  readonly publicAuthority: string
  readonly credentialSweepIntervalMs?: number
}

/**
 * Durable Server-shell half of Extension MBP1. It intentionally owns no public
 * route policy: bootstrap can prepare/reconcile this runtime while the four
 * routes remain closed, then the remote-surface composition root must open all
 * routes as one separately-reviewed bundle.
 */
export class ServerExtensionMbp1Runtime {
  readonly instanceId: string
  readonly credentials: Mbp1CredentialStore
  readonly extensionPairings: ExtensionPairingProjectionService
  readonly prompts: ServerExtensionPairingPromptAdapter
  readonly identityResolver: ExtensionIdentityResolver

  private readonly asyncWork = new AsyncWorkTracker()
  private readonly sweepTimer: NodeJS.Timeout
  private server: WebSocketBridgeServer | null = null

  private constructor(
    private readonly bus: BridgeEventBus,
    state: {
      instanceId: string
      credentials: Mbp1CredentialStore
      extensionPairings: ExtensionPairingProjectionService
      prompts: ServerExtensionPairingPromptAdapter
      identityResolver: ExtensionIdentityResolver
      credentialSweepIntervalMs: number
    }
  ) {
    this.instanceId = state.instanceId
    this.credentials = state.credentials
    this.extensionPairings = state.extensionPairings
    this.prompts = state.prompts
    this.identityResolver = state.identityResolver
    this.sweepTimer = setInterval(
      () => void this.credentials.sweepExpiredProvisionals(),
      state.credentialSweepIntervalMs
    )
    this.sweepTimer.unref()
  }

  static async load(
    options: ServerExtensionMbp1RuntimeOptions
  ): Promise<ServerExtensionMbp1Runtime> {
    const credentials = await Mbp1CredentialStore.load(
      join(options.dataDir, 'mbp1-credentials.json')
    )
    const extensionPairings = new ExtensionPairingProjectionService(
      new FileExtensionPairingProjectionStore(
        join(options.dataDir, 'extension-pairings.json')
      )
    )
    await extensionPairings.load()
    return new ServerExtensionMbp1Runtime(options.bus, {
      instanceId: await loadOrCreateBridgeInstanceId(
        join(options.dataDir, 'server-instance-id')
      ),
      credentials,
      extensionPairings,
      prompts: new ServerExtensionPairingPromptAdapter(options.bus, {
        publicAuthority: options.publicAuthority,
      }),
      identityResolver: createExtensionIdentityResolver({
        environment: 'production',
        developmentEntries: [],
      }),
      credentialSweepIntervalMs:
        options.credentialSweepIntervalMs ?? CREDENTIAL_SWEEP_INTERVAL_MS,
    })
  }

  attachServer(server: WebSocketBridgeServer): void {
    if (this.server !== null)
      throw new Error('server MBP1 runtime already attached')
    this.server = server
  }

  async recoverBeforeListen(): Promise<void> {
    const server = this.requireServer()
    for (const pending of this.extensionPairings
      .list()
      .filter((record) => record.status === 'cleanup-pending')) {
      const serverLease = server.beginExtensionRevocation(pending.identity)
      const projectionLease =
        await this.extensionPairings.prepareIdentityCleanup(pending.identity)
      try {
        await server.deleteExtensionAuthorization(serverLease, 'user-revoked')
        const absenceWitness =
          await this.credentials.issueExtensionIdentityAbsenceWitness(
            pending.identity.browser,
            pending.identity.extensionId
          )
        await this.extensionPairings.completeCleanup(
          projectionLease,
          absenceWitness
        )
        server.completeExtensionRevocation(serverLease)
      } catch {
        server.retainFailedExtensionRevocation(serverLease)
        throw new Error('extension revocation recovery failed')
      }
    }
    await this.extensionPairings.reconcileCommitted(
      await this.credentials.issueCommittedExtensionSnapshot()
    )
  }

  onAuthenticated(
    identity: ClientIdentity & { kind: 'extension' },
    credentialId: string
  ): void {
    const server = this.requireServer()
    try {
      void this.asyncWork
        .run(async () => {
          const witness =
            await this.credentials.issueCommittedExtensionWitness(credentialId)
          if (!identityMatchesWitness(identity, witness)) {
            throw new Error('authenticated extension identity mismatch')
          }
          await this.extensionPairings.recordAuthenticated(witness, Date.now())
          this.bus.emitPaired({ identity })
        })
        .catch(() => this.quarantineProjectionFailure(server, identity))
    } catch {
      this.quarantineProjectionFailure(server, identity)
    }
  }

  settleExtensionPrompt(
    params: Extract<ResolvePairParams, { kind: 'extension' }>
  ): ResolvePairResult {
    return this.prompts.settle(params)
  }

  async revoke(
    identity: ClientIdentity & { kind: 'extension' }
  ): Promise<void> {
    const server = this.requireServer()
    const serverLease = server.beginExtensionRevocation(identity)
    let markerPersisted = false
    try {
      const cleanupLease =
        await this.extensionPairings.prepareIdentityCleanup(identity)
      markerPersisted = true
      await server.deleteExtensionAuthorization(serverLease, 'user-revoked')
      const absenceWitness =
        await this.credentials.issueExtensionIdentityAbsenceWitness(
          identity.browser,
          identity.extensionId
        )
      await this.extensionPairings.completeCleanup(cleanupLease, absenceWitness)
      server.completeExtensionRevocation(serverLease)
      this.bus.emitRevoked({ identity })
    } catch {
      server.retainFailedExtensionRevocation(serverLease)
      this.bus.emitError({
        code: markerPersisted
          ? 'extensionRevocationIncomplete'
          : 'extensionRevocationMarkerFailed',
        message: markerPersisted
          ? 'Extension revocation is incomplete; access remains closed and startup will retry it.'
          : 'Extension revocation could not be recorded; access is closed for this run, but restart may restore the old credential.',
      })
      throw new Error('extension revocation incomplete')
    }
  }

  async stopAndDrain(): Promise<void> {
    clearInterval(this.sweepTimer)
    await this.asyncWork.stopAndDrain()
    await this.prompts.dispose()
    await this.extensionPairings.stopAndDrain()
  }

  private quarantineProjectionFailure(
    server: WebSocketBridgeServer,
    identity: ClientIdentity & { kind: 'extension' }
  ): void {
    try {
      const lease: ExtensionRevocationLease =
        server.beginExtensionRevocation(identity)
      server.retainFailedExtensionRevocation(lease)
    } catch {
      // The fixed operator signal below remains the observable failure.
    }
    this.bus.emitError({
      code: 'extensionProjectionDegraded',
      message:
        'Extension pairing state could not be updated; access is closed until startup repair.',
    })
  }

  private requireServer(): WebSocketBridgeServer {
    if (this.server === null)
      throw new Error('server MBP1 runtime is not attached')
    return this.server
  }
}
