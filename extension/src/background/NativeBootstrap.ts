import { extensionBrowser as browser } from '@/shared/browser'
/**
 * Native Messaging bootstrap. Connects to the Motrix native host shim,
 * which reads endpoint.json (or launches Motrix if needed) and reports
 * back the local WebSocket port plus a one-shot pairing nonce. The NM
 * channel exists only for this handoff — once we know port + nonce, we
 * disconnect and use WebSocket for all subsequent traffic.
 *
 * Wire shape (local native-host contract), now one of two request shapes the host's
 * `parse_host_request` accepts side by side (`packages/native-host/src/lib.rs`):
 *
 *   { action: 'start', allowLaunch }                                  (v1, legacy)
 *   { action: 'bootstrap', protocolVersion: 1, bindingPub, allowLaunch } (§9.1)
 *
 * Both replies look like:
 *   { action: 'requestPair', protocolVersion: <int>, port: <number>,
 *     nonce: <string | null>, nmTicket?: <object> }
 *
 * The host serializes `protocolVersion` on *every* `requestPair` reply
 * regardless of which request shape triggered it
 * (`ResolveResult::request_pair`/`request_pair_with_ticket` in
 * `packages/native-host/src/resolve.rs`), and omits `nmTicket` entirely
 * rather than sending it `null` — a ticket is only ever minted for a
 * `bootstrap` request whose caller identity and `endpoint.json` inputs are
 * all trusted (§9.1/§9.2), so a `start` request never gets one.
 *
 * `nonce` is null if the host failed to fetch a fresh nonce from
 * /nonce. Bootstrap still surfaces the port — the caller (ConnectionManager)
 * decides whether to attempt /pair (needs a non-null nonce) or an
 * authenticated MBP1 reconnect (uses a stored credential).
 */

import {
  BINDING_PUB_BYTES,
  BOOTSTRAP_TIMEOUT_MS,
  type BootstrapProvider,
  type DiscoverOptions,
  NATIVE_HOST_NAME,
  NativeBootstrapError,
  type NativeBootstrapResult,
  parseBootstrapResponse,
} from '@/background/BootstrapProvider'
import { log } from '@/background/log'
import { buildBootstrapRequest } from '@/background/mbp1/ticket-bootstrap'
import { getBuildBrowser } from '@/shared/browserKind'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

// Preserve imports used by existing Chromium/Firefox callers.
export {
  type DiscoverOptions,
  NativeBootstrapError,
  type NativeBootstrapResult,
} from '@/background/BootstrapProvider'

export interface NativeBootstrapOptions {
  hostName?: string
  timeoutMs?: number
}

interface NMPort {
  postMessage(msg: unknown): void
  disconnect(): void
  onMessage: { addListener(fn: (m: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

export class NativeBootstrap implements BootstrapProvider {
  private readonly opts: NativeBootstrapOptions
  constructor(opts: NativeBootstrapOptions = {}) {
    this.opts = opts
  }

  async discover(opts: DiscoverOptions = {}): Promise<NativeBootstrapResult> {
    const hostName = this.opts.hostName ?? NATIVE_HOST_NAME
    const timeoutMs = this.opts.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS
    const allowLaunch = opts.allowLaunch === true

    // Checked before ever touching Native Messaging: the host's answer to a
    // wrong-length `bindingPub` is silence (parse_host_request returns None
    // and the process exits without a reply), which is indistinguishable
    // from "Motrix is not installed" — a diagnosis this project protects
    // deliberately. Fail with something diagnosable instead.
    if (
      opts.bindingPub !== undefined &&
      opts.bindingPub.length !== BINDING_PUB_BYTES
    ) {
      throw new NativeBootstrapError(
        `bindingPub must be exactly ${BINDING_PUB_BYTES} bytes, got ${opts.bindingPub.length}`,
        'invalid-binding-pub'
      )
    }

    if (getBuildBrowser() === 'safari' || !hasNativeMessagingSupport()) {
      throw new NativeBootstrapError(
        'Native Messaging is unavailable on this browser; configure a Motrix Server instead',
        'unsupported'
      )
    }

    // DEBUG: spawns a fresh native host process (which may relaunch
    // Motrix). TODO(remove-after-rootcause).
    log.info(`[NM] connectNative(${hostName}) allowLaunch=${allowLaunch}`)
    const port = browser.runtime.connectNative(hostName) as unknown as NMPort

    return new Promise<NativeBootstrapResult>((resolve, reject) => {
      let settled = false
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          port.disconnect()
        } catch {
          // best-effort; host may already be gone
        }
        action()
      }

      const timer = setTimeout(() => {
        settle(() =>
          reject(new NativeBootstrapError('NM bootstrap timeout', 'timeout'))
        )
      }, timeoutMs)

      port.onMessage.addListener((rawMsg: unknown) => {
        if (settled) return
        try {
          const result = parseBootstrapResponse(rawMsg)
          log.info(`[NM] recv action=requestPair port=${result.wsPort}`)
          settle(() => resolve(result))
        } catch (error) {
          log.info(
            `[NM] recv error=${error instanceof NativeBootstrapError ? error.code : 'malformed'}`
          )
          settle(() => reject(error))
        }
      })

      port.onDisconnect.addListener(() => {
        const lastErr = browser.runtime.lastError?.message
        log.info(`[NM] onDisconnect lastError=${lastErr ?? 'none'}`)
        settle(() =>
          reject(
            new NativeBootstrapError(
              `NM host disconnected${lastErr ? `: ${lastErr}` : ''}`,
              'disconnect'
            )
          )
        )
      })

      const request =
        opts.bindingPub === undefined
          ? { action: 'start' as const, allowLaunch }
          : buildBootstrapRequest(opts.bindingPub, allowLaunch)

      try {
        port.postMessage(request)
      } catch (error) {
        settle(() =>
          reject(
            new NativeBootstrapError(
              `NM start failed: ${(error as Error).message ?? String(error)}`,
              'disconnect'
            )
          )
        )
      }
    })
  }
}
