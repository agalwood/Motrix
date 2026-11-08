import { AppError, ErrorCode } from '@shared/errors'

/** Release the response on every bounded-read failure, including stream errors. */
export async function readPluginResponse(
  response: Response,
  limit = 5 * 1024 * 1024
): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.package_too_large'
    )
  }
  if (!response.body)
    throw new AppError(
      ErrorCode.PluginManifestInvalid,
      'plugin.install.url_download_failed: empty body'
    )
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit)
        throw new AppError(
          ErrorCode.PluginManifestInvalid,
          'plugin.install.package_too_large'
        )
      chunks.push(value)
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}
