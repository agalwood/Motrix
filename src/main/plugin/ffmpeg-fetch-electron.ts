import type { EventEmitter } from 'node:events'
import { net } from 'electron'

const MAX_QUEUED_BYTES = 8 * 1024 * 1024

/**
 * Electron fetch rejects manual redirects instead of exposing their Location.
 * Return each redirect without following it so the core can validate every hop.
 */
export const fetchFfmpegAsset: typeof fetch = async (input, init) => {
  if (
    !(typeof input === 'string' || input instanceof URL) ||
    init?.redirect !== 'manual' ||
    init.credentials !== 'omit' ||
    (init.method !== undefined && init.method !== 'GET') ||
    init.body !== undefined ||
    init.headers !== undefined
  )
    throw new Error('Unsupported FFmpeg download request')
  const signal = init.signal
  signal?.throwIfAborted()
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({
      url: String(input),
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      useSessionCookies: false,
      bypassCustomProtocolHandlers: true,
      cache: 'no-store',
    })
    let settled = false
    let finished = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const cleanups: (() => void)[] = []
    const finish = () => {
      finished = true
      signal?.removeEventListener('abort', abort)
      for (const cleanup of cleanups) cleanup()
    }
    const fail = () => {
      if (finished) return
      finish()
      const error = new Error('FFmpeg network request failed')
      if (controller) controller.error(error)
      if (!settled) {
        settled = true
        reject(error)
      }
      request.abort()
    }
    const abort = () => fail()
    signal?.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.on('abort', fail)
    cleanups.push(() => {
      request.off('abort', fail)
    })
    // ClientRequest is an auto-destroyed Writable, not the response stream.
    // Its early close is normal; response close before end is truncation.
    const redirected = (
      status: number,
      _method: string,
      redirectUrl: string
    ) => {
      if (finished || settled) return
      try {
        const response = new Response(null, {
          status,
          headers: { location: redirectUrl },
        })
        settled = true
        finish()
        resolve(response)
        // Never call followRedirect: the next URL has not passed core policy yet.
        request.abort()
      } catch {
        fail()
      }
    }
    request.on('redirect', redirected)
    cleanups.push(() => request.off('redirect', redirected))
    const received = (response: Electron.IncomingMessage) => {
      if (finished || settled) return
      try {
        // Installed typings omit close, but the actual IncomingMessage extends Readable.
        const responseEvents = response as Electron.IncomingMessage &
          Pick<EventEmitter, 'on' | 'off'>
        const headers = new Headers()
        for (const name of ['content-length', 'content-type', 'location']) {
          const value = response.headers[name]
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const body = new ReadableStream<Uint8Array>(
          {
            start(streamController) {
              controller = streamController
              // Electron requires end to be registered before data.
              const ended = () => {
                if (finished) return
                finish()
                streamController.close()
              }
              response.on('end', ended)
              response.on('error', fail)
              response.on('aborted', fail)
              responseEvents.on('close', fail)
              const data = (chunk: Buffer) => {
                if (finished) return
                if (
                  chunk.length > MAX_QUEUED_BYTES ||
                  (streamController.desiredSize ?? 0) - chunk.length < 0
                ) {
                  fail()
                  return
                }
                streamController.enqueue(new Uint8Array(chunk))
              }
              response.on('data', data)
              // Keep only the harmless error sink for late Chromium errors.
              cleanups.push(() => {
                response.off('end', ended)
                response.off('aborted', fail)
                responseEvents.off('close', fail)
                response.off('data', data)
              })
            },
            cancel() {
              finish()
              request.abort()
            },
          },
          new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES })
        )
        const result = new Response(body, {
          status: response.statusCode,
          headers,
        })
        settled = true
        resolve(result)
      } catch {
        fail()
      }
    }
    request.on('response', received)
    cleanups.push(() => request.off('response', received))
    // An abort can race between the initial check and listener registration.
    if (signal?.aborted) abort()
    else {
      try {
        request.end()
      } catch {
        fail()
      }
    }
  })
}
