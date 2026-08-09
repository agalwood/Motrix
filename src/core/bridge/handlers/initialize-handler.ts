import {
  ErrorCodes,
  type InitializeParams,
  type InitializeResult,
  makeMdxpError,
} from '@motrix/mdxp'
import type { MdxpSessionContext } from '../mdxp-session-context'
import type { PairingService } from '../pairing-service'
import type { TrustedExtensionRegistry } from '../trusted-extension-registry'
import type { PairDecision, PairRequestArgs } from '../web-socket-bridge-server'

export interface InitializeHandlerDeps {
  motrixVersion: string
  ffmpegAvailable: boolean
  pairing: PairingService
  registry: TrustedExtensionRegistry
  onPairRequest: (args: PairRequestArgs) => Promise<PairDecision>
}

/**
 * `motrix/initialize` request handler. Behaves differently depending
 * on whether the connection came in via `/pair` (`pairArgs != null`)
 * or `/v1` (`pairArgs === null`).
 *
 * - first-pair: trigger PairingDialog, on allow mint token, on deny
 *   throw `-32003 Permission denied`
 * - reconnect: validate params extensionId matches session, return
 *   capabilities without a new token
 *
 * Throws MdxpError-shaped objects with `code` matching MDXP error
 * conventions. vscode-jsonrpc auto-maps thrown values to JSON-RPC
 * error responses.
 */
export function createInitializeHandler(
  deps: InitializeHandlerDeps
): (
  params: InitializeParams,
  ctx: MdxpSessionContext
) => Promise<InitializeResult> {
  return async (params, ctx) => {
    // Params are validated by the dispatcher before reaching here.
    if (ctx.pendingPair === null) {
      // Reconnect (/v1): the client must re-assert the SAME identity the paired
      // token was issued for. v1 only admits extension reconnect, so fail CLOSED
      // for any other kind rather than skipping the identity check — skipping
      // would be a latent fail-open auth gate the moment a later spec issues
      // cli/agent tokens. That later spec generalizes this to per-kind identity
      // matching when it admits non-extension clients.
      if (params.client.kind !== 'extension') {
        throw makeMdxpError(
          ErrorCodes.InvalidParams,
          `unsupported client kind for reconnect: ${params.client.kind}`
        )
      }
      // The /v1 route only ever creates extension sessions, but the handler
      // must not assume it: fail CLOSED for any other session-identity kind so
      // a future cli/agent session can never bypass the extensionId match by
      // comparing against an absent field.
      if (ctx.identity.kind !== 'extension') {
        throw makeMdxpError(
          ErrorCodes.InvalidParams,
          `unsupported session kind for reconnect: ${ctx.identity.kind}`
        )
      }
      if (params.client.extensionId !== ctx.identity.extensionId) {
        throw makeMdxpError(
          ErrorCodes.InvalidParams,
          `extensionId mismatch: params=${params.client.extensionId}, session=${ctx.identity.extensionId}`
        )
      }
      // A /v1 reconnect is authorized at upgrade (its token was verified),
      // but assert it here too so the invariant holds at the one gate.
      ctx.markAuthorized()
      return buildResult(deps, undefined)
    }

    const decision = await deps.onPairRequest(ctx.pendingPair)
    if (decision.decision === 'deny') {
      throw makeMdxpError(ErrorCodes.PermissionDenied, 'User denied pairing', {
        appCode: 'pair.denied',
      })
    }

    const paired = await deps.pairing.issueToken(
      {
        kind: 'extension',
        browser: ctx.pendingPair.browser,
        extensionId: ctx.pendingPair.extensionId,
      },
      ctx.pendingPair.extensionName
    )
    // Pairing approved and token minted: this /pair connection may now drive
    // control-plane / download methods. Until this point it was unauthorized.
    ctx.markAuthorized()
    return buildResult(deps, paired.token)
  }
}

function buildResult(
  deps: InitializeHandlerDeps,
  pairToken: string | undefined
): InitializeResult {
  return {
    protocolVersion: '1.0',
    server: {
      name: 'motrix',
      version: deps.motrixVersion,
      runtime: 'electron',
    },
    capabilities: {
      ffmpegAvailable: deps.ffmpegAvailable,
      selectionKinds: deps.ffmpegAvailable
        ? ['direct', 'hls', 'dash', 'mux']
        : ['direct'],
      progress: true,
      cancellation: true,
    },
    serverAdapters: [],
    ...(pairToken !== undefined ? { pairToken } : {}),
  }
}
