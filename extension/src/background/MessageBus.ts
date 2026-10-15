import { type Browser, extensionBrowser as browser } from '@/shared/browser'
import {
  type Envelope,
  type ErrorResponse,
  isErrorResponse,
  type MessageKind,
  type MessageRequest,
  type MessageResponse,
} from '@/shared/messages'

type AnySender = Browser.runtime.MessageSender

export type MessageBusHandler<K extends MessageKind> = (
  payload: MessageRequest<K>,
  sender: AnySender
) => Promise<MessageResponse<K>>

export interface MessageBusOptions {
  /**
   * A service-worker startup barrier. The listener is still attached
   * synchronously (required by MV3), but no known message can reach a handler
   * until durable startup recovery has either completed or failed closed.
   */
  beforeDispatch?: () => Promise<void>
}

/**
 * Routes typed Envelope messages from popup/options/content scripts to
 * handlers registered in the background SW. Handlers may be async; the
 * bus enforces an "async response" sentinel by always returning true
 * from the chrome.runtime.onMessage callback.
 */
export class MessageBus {
  private readonly handlers = new Map<
    MessageKind,
    MessageBusHandler<MessageKind>
  >()

  private readonly beforeDispatch: () => Promise<void>

  constructor(options: MessageBusOptions = {}) {
    this.beforeDispatch = options.beforeDispatch ?? (() => Promise.resolve())
  }

  on<K extends MessageKind>(kind: K, handler: MessageBusHandler<K>): void {
    this.handlers.set(
      kind,
      handler as unknown as MessageBusHandler<MessageKind>
    )
  }

  /** Call once at background startup. */
  attach(): void {
    browser.runtime.onMessage.addListener(
      (rawMsg: unknown, sender, sendResponse) => {
        const env = rawMsg as Envelope | undefined
        if (!env || typeof env.kind !== 'string') {
          sendResponse({ error: 'invalid envelope' } satisfies ErrorResponse)
          return true
        }
        const handler = this.handlers.get(env.kind)
        if (!handler) {
          sendResponse({
            error: `no handler for ${env.kind}`,
          } satisfies ErrorResponse)
          return true
        }
        Promise.resolve()
          .then(() => this.beforeDispatch())
          .then(() => handler(env.payload, sender as AnySender))
          .then((res) => sendResponse(res))
          .catch((e: unknown) =>
            sendResponse({
              error: e instanceof Error ? e.message : 'handler failed',
            } satisfies ErrorResponse)
          )
        return true // async response
      }
    )
  }
}

/**
 * Client-side helper. popup/options use this to call into background;
 * the response type is statically inferred from the message kind.
 */
export async function send<K extends MessageKind>(
  kind: K,
  payload: MessageRequest<K>
): Promise<MessageResponse<K>> {
  const env: Envelope<K> = { kind, payload }
  const response = (await browser.runtime.sendMessage(env)) as
    | MessageResponse<K>
    | ErrorResponse
  if (isErrorResponse(response)) throw new Error(response.error)
  return response
}
