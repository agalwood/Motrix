import {
  ErrorCodes,
  type InitializeParams,
  type InitializeResult,
  makeMdxpError,
} from '@motrix/mdxp'
import type { MdxpSessionContext } from '../mdxp-session-context'

export interface InitializeHandlerDeps {
  motrixVersion: string
  runtime: 'electron' | 'server'
  ffmpegAvailable: boolean
  /** Read lazily so capabilities match the methods actually registered. */
  supportsTaskReveal: () => boolean
}

/**
 * `motrix/initialize` request handler — a capabilities exchange and nothing
 * more.
 *
 * MBP1 authenticates *below* MDXP (docs/bridge-pairing-protocol.md §4, §6, §8):
 * by the time a frame reaches this handler the connection has completed either
 * the first-pair PAKE or the reconnect challenge–response, and the wiring has
 * already marked it authorized. So there is no pairing decision to make here,
 * no token to mint — extensions never receive a `pairToken` again — and no
 * branch on how the connection arrived. Device-code (`cli`) pairing keeps its
 * own independent mint in `DeviceCodeService`.
 *
 * What remains is one consistency assertion: a Chromium client must re-assert
 * the extension id its verified `Origin` already proved. Both `kind` checks
 * around it fail CLOSED rather than skipping that assertion, so a future
 * non-extension principal can never reach it against an absent field.
 *
 * Throws MdxpError-shaped objects with `code` matching MDXP error conventions.
 * vscode-jsonrpc auto-maps thrown values to JSON-RPC error responses.
 */
export function createInitializeHandler(
  deps: InitializeHandlerDeps
): (
  params: InitializeParams,
  ctx: MdxpSessionContext
) => Promise<InitializeResult> {
  return async (params, ctx) => {
    // Params are validated by the dispatcher before reaching here.
    if (params.client.kind !== 'extension') {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        `unsupported client kind: ${params.client.kind}`
      )
    }
    if (ctx.identity.kind !== 'extension') {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        `unsupported session kind: ${ctx.identity.kind}`
      )
    }
    // §5: on Chromium the session's `extensionId` is the verified `Origin`
    // host, which IS the extension id, so a disagreeing `params.client` is a
    // client inconsistent with its own transport. On Firefox the session id is
    // the `moz-extension://<UUID>` host, which cannot be mapped to the Gecko id
    // the client reports — the same asymmetry `pair-session.ts` applies to
    // `claimedExtensionId` — so there is nothing to compare, and comparing
    // would reject every legitimate Firefox session.
    if (
      ctx.identity.browser === 'chromium' &&
      params.client.extensionId !== ctx.identity.extensionId
    ) {
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        `extensionId mismatch: params=${params.client.extensionId}, session=${ctx.identity.extensionId}`
      )
    }
    return buildResult(deps)
  }
}

function buildResult(deps: InitializeHandlerDeps): InitializeResult {
  return {
    protocolVersion: '1.0',
    server: {
      name: 'motrix',
      version: deps.motrixVersion,
      runtime: deps.runtime,
    },
    capabilities: {
      ffmpegAvailable: deps.ffmpegAvailable,
      selectionKinds: deps.ffmpegAvailable
        ? ['direct', 'hls', 'dash', 'mux']
        : ['direct'],
      progress: true,
      cancellation: true,
      taskReveal: deps.supportsTaskReveal(),
    },
    serverAdapters: [],
  }
}
