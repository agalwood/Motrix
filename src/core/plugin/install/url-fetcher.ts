import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AppError, ErrorCode } from '@shared/errors'
import { Agent, interceptors, request } from 'undici'

const MAX_REDIRECTS = 5

async function cancelBody(body: unknown): Promise<void> {
  const responseBody = body as {
    destroy?: (error?: Error) => unknown
    cancel?: (reason?: unknown) => Promise<void>
    once?: (event: 'error', listener: () => void) => unknown
  }
  try {
    if (typeof responseBody.destroy === 'function') {
      // Undici BodyReadable reports an intentional destroy as an asynchronous
      // RequestAbortedError. Install the listener before destroy so cleanup of
      // a non-200/partial response cannot become an uncaught process error.
      responseBody.once?.('error', () => undefined)
      responseBody.destroy()
      return
    }
    if (typeof responseBody.cancel === 'function') {
      await responseBody.cancel()
    }
  } catch {
    // Preserve the download error when response cancellation also fails.
  }
}

/** Download a URL-sourced plugin package and release every owned socket. */
export async function downloadUrlMoext(
  url: string,
  destFile: string
): Promise<void> {
  const agent = new Agent()
  let body: unknown

  try {
    const dispatcher = agent.compose(
      interceptors.redirect({ maxRedirections: MAX_REDIRECTS })
    )
    const response = await request(url, { dispatcher })
    body = response.body
    if (response.statusCode !== 200) {
      await cancelBody(body)
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        `plugin.install.url_download_failed: ${response.statusCode}`
      )
    }

    await mkdir(path.dirname(destFile), { recursive: true })
    await pipeline(response.body, createWriteStream(destFile, { mode: 0o600 }))
    body = undefined
  } catch (cause) {
    await cancelBody(body)
    await rm(destFile, { force: true }).catch(() => undefined)
    throw cause
  } finally {
    // The interceptor wrapper delegates to this Agent. Destroy the owner, not
    // an implementation-detail wrapper whose lifecycle differs by Undici ABI.
    await agent.destroy().catch(() => undefined)
  }
}
