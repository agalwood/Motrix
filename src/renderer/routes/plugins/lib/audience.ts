import type { PluginListDTO } from '@shared/types/plugin'
import type { GrantsMap } from '@shared/types/plugin-install'
import type { TFunction } from 'i18next'

export type { GrantState, GrantsMap } from '@shared/types/plugin-install'

export type AudienceTone = 'safe' | 'review' | 'optional' | 'off'

export interface Audience {
  tone: AudienceTone
  toneLabel: string
  plain: string
  heroHeadline: string
  primaryAction: PrimaryAction
}

export type PrimaryActionKind =
  | 'settings'
  | 'open'
  | 'reviewAccess'
  | 'viewIssue'
  | 'grantAccess'
  | 'turnOn'

export interface PrimaryAction {
  kind: PrimaryActionKind
  label: string
}

export interface ColorTone {
  bg: string
  text: string
}

const AUDIENCE_TONE_MAP: Record<AudienceTone, ColorTone> = {
  safe: { bg: 'bg-green-100', text: 'text-green-700' },
  review: { bg: 'bg-amber-100', text: 'text-amber-700' },
  optional: { bg: 'bg-blue-100', text: 'text-blue-700' },
  off: { bg: 'bg-slate-100', text: 'text-slate-600' },
}

export function getAudienceTone(tone: AudienceTone): ColorTone {
  return AUDIENCE_TONE_MAP[tone]
}

const AVATAR_PALETTE: ReadonlyArray<ColorTone> = [
  { bg: 'bg-blue-100', text: 'text-blue-700' },
  { bg: 'bg-green-100', text: 'text-green-700' },
  { bg: 'bg-purple-100', text: 'text-purple-700' },
  { bg: 'bg-pink-100', text: 'text-pink-700' },
  { bg: 'bg-teal-100', text: 'text-teal-700' },
  { bg: 'bg-indigo-100', text: 'text-indigo-700' },
]

export function avatarToneFor(id: string): ColorTone {
  let h = 0
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

const BROAD_HOST_PATTERNS = new Set([
  '*://*/*',
  'http://*/*',
  'https://*/*',
  '<all_urls>',
])

export function isBroadHostAccess(
  hostPermissions: ReadonlyArray<string> | undefined
): boolean {
  if (!hostPermissions || hostPermissions.length === 0) return false
  return hostPermissions.some((h) => BROAD_HOST_PATTERNS.has(h))
}

interface PermAudience {
  strong: string
  plain: string
  tone: AudienceTone
  toneLabel: string
}

const PERMISSION_AUDIENCE: Record<
  string,
  { tone: AudienceTone; toneLabelKey: string }
> = {
  http: {
    tone: 'review',
    toneLabelKey: 'plugins.permission.accessTone.websiteAccess',
  },
  'http.cookies': {
    tone: 'review',
    toneLabelKey: 'plugins.permission.accessTone.websiteAccess',
  },
  ffmpeg: {
    tone: 'optional',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  notify: {
    tone: 'off',
    toneLabelKey: 'plugins.permission.accessTone.offByDefault',
  },
  'fs.task.read': {
    tone: 'optional',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  'fs.task.write': {
    tone: 'review',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  'fs.storage': {
    tone: 'optional',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  storage: {
    tone: 'optional',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  notifications: {
    tone: 'off',
    toneLabelKey: 'plugins.permission.accessTone.offByDefault',
  },
  network: {
    tone: 'review',
    toneLabelKey: 'plugins.permission.accessTone.websiteAccess',
  },
  'tasks:read': {
    tone: 'optional',
    toneLabelKey: 'plugins.permission.accessTone.required',
  },
  'tasks:write': {
    tone: 'review',
    toneLabelKey: 'plugins.permission.accessTone.websiteAccess',
  },
}

export function permissionAudience(name: string, t: TFunction): PermAudience {
  const known = PERMISSION_AUDIENCE[name]
  if (known) {
    return {
      strong: t(`plugins.permission.${name}.strong`),
      plain: t(`plugins.permission.${name}.plain`),
      tone: known.tone,
      toneLabel: t(known.toneLabelKey),
    }
  }
  if (name.startsWith('host:')) {
    return {
      strong: t('plugins.permission.network.strong'),
      plain: t('plugins.permission.network.plain'),
      tone: 'review',
      toneLabel: t('plugins.permission.accessTone.websiteAccess'),
    }
  }
  return {
    strong: name,
    plain: t('plugins.permission.unknown.plain'),
    tone: 'review',
    toneLabel: t('plugins.permission.accessTone.websiteAccess'),
  }
}

export function summarizeAccess(
  hostPermissions: ReadonlyArray<string> | undefined,
  t: TFunction
): string {
  if (!hostPermissions || hostPermissions.length === 0) {
    return t('plugins.detail.accessNone')
  }
  if (isBroadHostAccess(hostPermissions)) {
    return t('plugins.detail.accessBroad')
  }
  return t('plugins.detail.accessHosts', { count: hostPermissions.length })
}

export function summarizeHealth(plugin: PluginListDTO, t: TFunction): string {
  if (!plugin.enabled) return t('plugins.detail.hero.off')
  if (plugin.errorCount === 0) return t('plugins.detail.healthOk')
  return t('plugins.detail.healthIssues', { count: plugin.errorCount })
}

const SENTENCE_BOUNDARY = /[.。!?！？]/

export function truncateOneLine(description: string, max: number = 90): string {
  if (!description) return ''
  const trimmed = description.trim()
  const match = trimmed.match(SENTENCE_BOUNDARY)
  if (match && match.index !== undefined) {
    const candidate = trimmed.slice(0, match.index + 1)
    if (candidate.length <= max) return candidate
  }
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max)
}

function deriveTone(
  plugin: PluginListDTO,
  hostPermissions: ReadonlyArray<string> | undefined,
  grants: GrantsMap | undefined
): AudienceTone {
  if (!plugin.enabled) return 'off'
  if (plugin.errorCount > 0) return 'review'
  if (plugin.status === 'disabled') return 'review'
  if (isBroadHostAccess(hostPermissions)) return 'review'
  const optionalUngranted = plugin.optionalPermissions.some(
    (p) => grants?.[p] !== 'granted'
  )
  if (optionalUngranted) return 'optional'
  return 'safe'
}

function plainKeyFor(tone: AudienceTone, errored: boolean): string {
  if (tone === 'review' && errored) return 'plugins.card.plain.reviewError'
  if (tone === 'review') return 'plugins.card.plain.reviewBroadHost'
  if (tone === 'optional') return 'plugins.card.plain.optional'
  if (tone === 'off') return 'plugins.card.plain.off'
  return 'plugins.card.plain.safe'
}

function heroFor(tone: AudienceTone, errored: boolean): string {
  if (tone === 'review' && errored) return 'plugins.detail.hero.attention'
  if (tone === 'review') return 'plugins.detail.hero.review'
  if (tone === 'optional') return 'plugins.detail.hero.optional'
  if (tone === 'off') return 'plugins.detail.hero.off'
  return 'plugins.detail.hero.ready'
}

function primaryFor(
  tone: AudienceTone,
  errored: boolean,
  hasSchema: boolean,
  t: TFunction
): PrimaryAction {
  if (tone === 'review' && errored) {
    return {
      kind: 'viewIssue',
      label: t('plugins.card.primaryAction.viewIssue'),
    }
  }
  if (tone === 'review') {
    return {
      kind: 'reviewAccess',
      label: t('plugins.card.primaryAction.reviewAccess'),
    }
  }
  if (tone === 'optional') {
    return {
      kind: 'grantAccess',
      label: t('plugins.card.primaryAction.grantAccess'),
    }
  }
  if (tone === 'off') {
    return { kind: 'turnOn', label: t('plugins.card.primaryAction.turnOn') }
  }
  if (hasSchema) {
    return {
      kind: 'settings',
      label: t('plugins.card.primaryAction.settings'),
    }
  }
  return { kind: 'open', label: t('plugins.card.primaryAction.open') }
}

export function computePluginAudience(
  plugin: PluginListDTO,
  hostPermissions: ReadonlyArray<string> | undefined,
  t: TFunction,
  grants: GrantsMap | undefined,
  hasSettingsSchema: boolean = false
): Audience {
  const errored = plugin.errorCount > 0
  const tone = deriveTone(plugin, hostPermissions, grants)
  return {
    tone,
    toneLabel: t(`plugins.tone.${tone}`),
    plain: t(plainKeyFor(tone, errored)),
    heroHeadline: t(heroFor(tone, errored)),
    primaryAction: primaryFor(tone, errored, hasSettingsSchema, t),
  }
}

export function abbreviatePluginName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '??'
  const tokens = trimmed.split(/[\s\-_./]+/).filter(Boolean)
  if (tokens.length >= 2) {
    return (tokens[0].charAt(0) + tokens[1].charAt(0)).toUpperCase()
  }
  const sole = tokens[0]
  if (!sole) return '??'
  if (sole.length >= 2) return sole.slice(0, 2).toUpperCase()
  return `${sole}?`.toUpperCase()
}
