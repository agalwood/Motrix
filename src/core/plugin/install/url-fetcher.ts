import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppError, ErrorCode } from '@shared/errors'
import { readPluginResponse } from './read-plugin-response'

/** Download through the host-owned transport, bounded before writing to disk. */
export async function downloadUrlMoext(
  url: string,
  destFile: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(url, { redirect: 'follow' })
  try {
    if (!response.ok) {
      throw new AppError(
        ErrorCode.PluginManifestInvalid,
        `plugin.install.url_download_failed: ${response.status}`
      )
    }
    const bytes = await readPluginResponse(response)
    await mkdir(path.dirname(destFile), { recursive: true })
    await writeFile(destFile, bytes, { mode: 0o600 })
  } catch (cause) {
    await response.body?.cancel().catch(() => undefined)
    await rm(destFile, { force: true }).catch(() => undefined)
    throw cause
  }
}
