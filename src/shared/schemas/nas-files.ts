import { z } from 'zod'

export const nasTaskActionSchema = z
  .object({
    taskId: z.string().min(1).max(128),
    action: z.enum(['open', 'reveal']),
  })
  .strict()
export const nasFileActionResultSchema = z
  .object({
    kind: z.enum(['download', 'file-manager']),
    url: z.string().min(1).max(16384).startsWith('/'),
  })
  .strict()
export const nasTorrentPathSchema = z
  .object({ path: z.string().min(1).max(4096) })
  .strict()
export const NAS_FILE_API = '/api/nas'

/** DSM's launchParam is a nested form-encoded string, not JSON. No SynoToken
 * is embedded: the DSM desktop authenticates with its own existing cookie. */
export function synologyFileStationUrl(canonical: string): string {
  if (
    !/^\/volume[1-9]\d*\/[^/]+(?:\/.*)?$/.test(canonical) ||
    /\p{Cc}/u.test(canonical) ||
    canonical
      .split('/')
      .slice(1)
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid DSM output path')
  const virtual = canonical.replace(/^\/volume[1-9]\d*/, '')
  return `/?${new URLSearchParams({ launchApp: 'SYNO.SDS.App.FileStation3.Instance', launchParam: `openfile=${encodeURIComponent(`${virtual}/`)}` })}`
}
