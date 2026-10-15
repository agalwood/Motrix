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
import {
  type BootstrapRequest,
  buildBootstrapRequest,
  generateBindingKeypair,
} from '@/background/mbp1/ticket-bootstrap'
import { extensionBrowser as browser } from '@/shared/browser'

export interface SafariNativeRuntime {
  getManifest(): { permissions?: readonly string[] }
  sendNativeMessage?: (
    application: string,
    message: BootstrapRequest
  ) => Promise<unknown>
}

export interface SafariBootstrapOptions {
  timeoutMs?: number
  runtime?: SafariNativeRuntime
}

// NativeMessageRouter, SafariWebExtensionHandler and BootstrapIPCCodec emit
// only these fixed codes. Never propagate native diagnostics or arbitrary
// response text into a user-facing error or log through this adapter.
const SAFARI_HOST_ERRORS: ReadonlySet<string> = new Set([
  'malformed-message',
  'message-too-large',
  'invalid-request',
  'unsupported-action',
  'unsupported-version',
  'bootstrap-unavailable',
  'bootstrap-timeout',
  'bootstrap-cancelled',
  'invalid-response',
  'ipc-timeout',
  'ipc-unavailable',
  'launch-denied',
])

/**
 * One request to the containing Safari app extension. A temporary extension
 * without nativeMessaging permission
 * must never be treated as supported merely because the API is present.
 */
export class SafariBootstrap implements BootstrapProvider {
  constructor(private readonly opts: SafariBootstrapOptions = {}) {}

  async discover(opts: DiscoverOptions = {}): Promise<NativeBootstrapResult> {
    if (
      opts.bindingPub !== undefined &&
      (!(opts.bindingPub instanceof Uint8Array) ||
        opts.bindingPub.length !== BINDING_PUB_BYTES)
    ) {
      throw new NativeBootstrapError(
        `Safari bootstrap requires bindingPub of exactly ${BINDING_PUB_BYTES} bytes`,
        'invalid-binding-pub'
      )
    }

    const runtime = this.opts.runtime ?? browser.runtime
    let declaredPermission = false
    try {
      declaredPermission =
        runtime.getManifest().permissions?.includes('nativeMessaging') === true
    } catch {
      // A missing manifest/runtime cannot establish native availability.
    }
    if (
      !declaredPermission ||
      typeof runtime.sendNativeMessage !== 'function'
    ) {
      throw new NativeBootstrapError(
        'Safari Native Messaging requires a packaged extension with nativeMessaging permission',
        'unsupported'
      )
    }

    // Reconnect discovery needs an endpoint, not a new pairing identity.
    // The native wire contract still requires a fresh public key. Destroy
    // the unused private half immediately and do not return its ticket.
    let bindingPub = opts.bindingPub
    const pairingKeyProvided = bindingPub !== undefined
    if (bindingPub === undefined) {
      const disposable = generateBindingKeypair()
      bindingPub = disposable.pub
      disposable.priv.fill(0)
    }
    const request = buildBootstrapRequest(bindingPub, opts.allowLaunch === true)
    const sendNativeMessage = runtime.sendNativeMessage.bind(runtime)
    return new Promise<NativeBootstrapResult>((resolve, reject) => {
      let settled = false
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => {
        settle(() =>
          reject(new NativeBootstrapError('NM bootstrap timeout', 'timeout'))
        )
      }, this.opts.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS)
      const unavailable = (): void => {
        settle(() =>
          reject(
            new NativeBootstrapError(
              'Safari native app is unavailable',
              'native-unavailable'
            )
          )
        )
      }

      try {
        // Safari ignores the application name and routes to its containing
        // app extension. Keep the shared host name for the API contract.
        sendNativeMessage(NATIVE_HOST_NAME, request).then((raw) => {
          if (settled) return
          try {
            const result = parseBootstrapResponse(raw, {
              expectedProtocolVersion: 1,
              allowedHostErrors: SAFARI_HOST_ERRORS,
            })
            settle(() =>
              resolve(
                pairingKeyProvided ? result : { ...result, nmTicket: null }
              )
            )
          } catch (error) {
            settle(() => reject(error))
          }
        }, unavailable)
      } catch {
        unavailable()
      }
    })
  }
}
