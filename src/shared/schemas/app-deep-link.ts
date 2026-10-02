import { z } from 'zod'

export const MAX_APP_DEEP_LINK_BYTES = 64 * 1024
export const MAX_PENDING_PROTOCOL_URLS = 32

export const appDeepLinkNoticeSchema = z.enum([
  'deprecatedScheme',
  'deprecatedCommand',
  'unsupportedCommand',
  'unsupportedParameters',
  'invalidLink',
  'invalidSource',
  'waitingMerged',
  'stoppedSplit',
  'invalidStatus',
])
export type AppDeepLinkNotice = z.infer<typeof appDeepLinkNoticeSchema>

export const appDeepLinkRouteSchema = z.enum([
  '/downloads/all',
  '/downloads/active',
  '/downloads/completed',
  '/downloads/error',
  '/settings',
  '/settings/about',
])
export type AppDeepLinkRoute = z.infer<typeof appDeepLinkRouteSchema>

export const taskDeepLinkIdSchema = z.string().min(1).max(1024).regex(/^\S+$/u)

// External links can only navigate or prefill a draft. There is deliberately
// no task mutation, installation, filesystem, or arbitrary IPC intent.
export type AppDeepLinkIntent =
  | { kind: 'show' }
  | { kind: 'navigate'; route: AppDeepLinkRoute; notice?: AppDeepLinkNotice }
  | { kind: 'draft'; mode: 'links' | 'torrent'; url?: string }
  | { kind: 'plugin'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'rejected'; notice: AppDeepLinkNotice }
