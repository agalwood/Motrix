import type { DownloadSubmitParams } from '@motrix/mdxp'
import { z } from 'zod'
import { directorySelectionSchema } from '@/shared/downloadDirectories'
import { sanitizeFilename } from '@/shared/manualTask'

const headerValue = z
  .string()
  .max(8192)
  .refine((value) => !/[\r\n\0]/.test(value))
// Referer is an HTTP header, not a download resource. Local pages and IP
// literals are valid sources; z.httpUrl() additionally requires a domain name.
const refererUrl = z.url({ protocol: /^https?$/ })
const reserved =
  /^(host|connection|content-length|transfer-encoding|upgrade|proxy-connection|keep-alive|te|trailer|user-agent|referer|cookie|authorization)$/i

export function parseExtraHeaders(
  value: string
): Record<string, string> | null {
  const result: Record<string, string> = {}
  const names = new Set<string>()
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue
    const colon = line.indexOf(':')
    const name = line.slice(0, colon).trim()
    const content = line.slice(colon + 1).trim()
    if (
      colon < 1 ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
      reserved.test(name) ||
      names.has(name.toLowerCase()) ||
      !headerValue.safeParse(content).success
    )
      return null
    names.add(name.toLowerCase())
    result[name] = content
  }
  return result
}

// Drafts may contain an unfinished header line or URL. Validate their shape
// while editing, then apply protocol validation only at submission.
export const taskOptionsDraftSchema = z.object({
  directory: directorySelectionSchema.optional(),
  filename: z.string().max(255),
  userAgent: z.string().max(8192),
  referer: z.string().max(8192),
  cookie: z.string().max(8192),
  authorization: z.string().max(8192),
  extraHeaders: z.string().max(16384),
  useBrowserCookies: z.boolean(),
})

export const taskOptionsSchema = taskOptionsDraftSchema.extend({
  userAgent: headerValue,
  referer: headerValue.refine(
    (value) => !value || refererUrl.safeParse(value).success
  ),
  cookie: headerValue,
  authorization: headerValue,
  extraHeaders: z
    .string()
    .max(16384)
    .refine((value) => parseExtraHeaders(value) !== null),
})

export type TaskOptions = z.infer<typeof taskOptionsSchema>

export function defaultTaskOptions(userAgent: string): TaskOptions {
  return {
    filename: '',
    userAgent,
    referer: '',
    cookie: '',
    authorization: '',
    extraHeaders: '',
    useBrowserCookies: false,
  }
}

/** Apply only fields supported by download/submit, after boundary validation. */
export function applyTaskOptions(
  params: DownloadSubmitParams,
  options: TaskOptions
): DownloadSubmitParams {
  const result = structuredClone(params)
  if (options.directory) result.saveDir = options.directory.path
  else delete result.saveDir
  if (options.filename.trim())
    result.meta.suggestedFilename = sanitizeFilename(
      options.filename,
      'download'
    )
  if (result.selection.kind === 'direct') {
    const primary = result.selection.primary
    const headers = parseExtraHeaders(options.extraHeaders) ?? {}
    for (const [name, value] of Object.entries({
      'User-Agent': options.userAgent,
      Referer: options.referer,
      Cookie: options.cookie,
      Authorization: options.authorization,
    })) {
      if (value) headers[name] = value
    }
    primary.headers = headers
    if (!options.useBrowserCookies || options.cookie) primary.cookies = []
  }
  return result
}
