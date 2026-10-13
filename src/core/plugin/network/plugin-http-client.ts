import type { Socket } from 'node:net'
import { decideAria2ProxyRoute } from '@core/proxy/aria2-proxy-routing'
import { proxyToUrl } from '@core/proxy/serializers'
import type { PluginNetworkFailure } from '@shared/schemas/plugin-network'
import type { ProxySettings } from '@shared/types/settings'
import {
  Agent,
  buildConnector,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
} from 'undici'
import { networkFailure, PluginNetworkError } from './plugin-network-error'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const REQUEST_TIMEOUT_MS = 60_000

/** Host-owned GET transport, independent of aria2 and Electron session policy. */
export class PluginHttpClient {
  private readonly active = new Map<AbortController, Promise<void>>()
  private closed = false

  constructor(private readonly getSettings: () => ProxySettings) {}

  readonly fetch: typeof fetch = async (input, init) => {
    if (
      !(typeof input === 'string' || input instanceof URL) ||
      (init?.method && init.method !== 'GET') ||
      init?.body
    ) {
      throw new TypeError('Unsupported plugin network request')
    }
    let url = new URL(String(input))
    const settings = structuredClone(this.getSettings())
    const proxied = settings.enabled && settings.scopes.plugins
    const context: Omit<PluginNetworkFailure, 'reason'> = {
      route: 'direct',
      targetHost: url.hostname,
    }
    const controller = new AbortController()
    const abort = () => controller.abort(init?.signal?.reason)
    init?.signal?.addEventListener('abort', abort, { once: true })
    if (init?.signal?.aborted) abort()
    if (this.closed) controller.abort()
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Plugin request timed out', 'TimeoutError')
        ),
      REQUEST_TIMEOUT_MS
    )
    timer.unref?.()
    // A request owns its dispatchers. Settings changes affect the next
    // request, never an active stream or the engine/Tracker network policy.
    const socksSockets = new Set<Socket>()
    let disposed = false
    const direct = new Agent()
    let proxy: ProxyAgent | Socks5ProxyAgent | undefined
    let cleanupPromise: Promise<void> | undefined
    let release!: () => void
    const finished = new Promise<void>((resolve) => {
      release = resolve
    })
    this.active.set(controller, finished)
    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        clearTimeout(timer)
        init?.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', onAbort)
        disposed = true
        for (const socket of socksSockets)
          socket.destroy(
            new DOMException('Plugin request closed', 'AbortError')
          )
        await Promise.allSettled([direct.destroy(), proxy?.destroy()])
        this.active.delete(controller)
        release()
      })()
      return cleanupPromise
    }
    const failure = (error: unknown) =>
      new PluginNetworkError(
        networkFailure(
          controller.signal.aborted ? controller.signal.reason : error,
          context
        )
      )
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const onAbort = () => {
      bodyController?.error(failure(controller.signal.reason))
      bodyController = undefined
      void cleanup()
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      controller.signal.throwIfAborted()
      if (proxied) context.proxyEndpoint = new URL(proxyToUrl(settings)).host
      const headers = new Headers(init?.headers)
      headers.delete('proxy-authorization')
      for (let redirects = 0; ; redirects++) {
        controller.signal.throwIfAborted()
        context.targetHost = url.hostname
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new TypeError('Invalid plugin request URL')
        }
        const route = proxied
          ? decideAria2ProxyRoute(url, settings.bypass.join(','))
          : 'direct'
        if (route === 'unsupported')
          throw new TypeError('Unsupported plugin proxy route')
        context.route = route
        if (route === 'proxy' && !proxy) {
          const endpoint = new URL(proxyToUrl(settings))
          if (settings.protocol === 'socks5') {
            const baseConnect = buildConnector({})
            const connect: typeof baseConnect = (options, callback) => {
              const hostname = options.hostname.replace(/^\[|\]$/g, '')
              baseConnect(
                { ...options, hostname, host: hostname },
                (error, socket) => {
                  if (error || !socket) {
                    callback(error ?? new Error('Missing proxy socket'), null)
                    return
                  }
                  if (disposed) {
                    socket.destroy()
                    callback(
                      new DOMException('Plugin request closed', 'AbortError'),
                      null
                    )
                    return
                  }
                  // Undici does not own this socket until SOCKS negotiation
                  // finishes. Retain it so abort also closes a stalled greeting.
                  socksSockets.add(socket)
                  socket.once('close', () => socksSockets.delete(socket))
                  callback(null, socket)
                }
              )
            }
            proxy = new Socks5ProxyAgent(endpoint, { connect })
          } else proxy = new ProxyAgent(endpoint.toString())
        }
        // The current Undici SOCKS connector treats bracketed IPv6 targets
        // as DNS names. Fail closed instead of silently changing the route.
        if (
          route === 'proxy' &&
          settings.protocol === 'socks5' &&
          url.hostname.startsWith('[')
        ) {
          throw new TypeError('Unsupported IPv6 SOCKS target')
        }
        const response = await undiciFetch(url, {
          method: 'GET',
          headers: Object.fromEntries(headers),
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'omit',
          dispatcher: route === 'proxy' ? proxy : direct,
        })
        if (REDIRECTS.has(response.status) && init?.redirect !== 'manual') {
          await response.body?.cancel()
          if (init?.redirect === 'error' || redirects >= 5)
            throw new TypeError('Plugin redirect rejected')
          const location = response.headers.get('location')
          if (!location) throw new TypeError('Missing plugin redirect location')
          const next = new URL(location, url)
          if (url.protocol === 'https:' && next.protocol !== 'https:')
            throw new TypeError('Plugin redirect protocol downgrade')
          if (url.origin !== next.origin) {
            headers.delete('authorization')
            headers.delete('cookie')
          }
          url = next
          continue
        }
        if (
          !response.ok &&
          response.status !== 304 &&
          !REDIRECTS.has(response.status)
        ) {
          await response.body?.cancel()
          throw new PluginNetworkError({
            ...context,
            reason:
              response.status === 407 && route === 'proxy'
                ? 'proxyAuth'
                : 'http',
            status: response.status,
          })
        }
        const responseInit = {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        }
        if (!response.body) {
          await cleanup()
          return new Response(null, responseInit)
        }
        const reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            bodyController = streamController
          },
          async pull(streamController) {
            try {
              const { done, value } = await reader.read()
              if (!bodyController) return
              if (done) {
                bodyController = undefined
                streamController.close()
                await cleanup()
              } else streamController.enqueue(value)
            } catch (error) {
              if (bodyController) {
                bodyController = undefined
                streamController.error(failure(error))
              }
              await cleanup()
            }
          },
          async cancel() {
            bodyController = undefined
            await Promise.allSettled([reader.cancel(), cleanup()])
          },
        })
        return new Response(body, responseInit)
      }
    } catch (error) {
      await cleanup()
      throw failure(error)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.active.values()]
    for (const controller of this.active.keys()) controller.abort()
    await Promise.all(pending)
  }
}
