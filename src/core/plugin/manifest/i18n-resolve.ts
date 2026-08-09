import type {
  JsonSchemaNode,
  ManifestContributes,
  PluginManifest,
} from '@shared/types/plugin'
import { PluginManifestInvalid } from './errors'

export type ManifestLocaleDict = Record<string, string>

/**
 * Flatten a parsed locale JSON into a dotted-key dict so nested entries
 * ({ nav: { title: 'X' } } → { 'nav.title': 'X' }) match the dotted %key%
 * placeholders resolveOne already supports (PLACEHOLDER_RE allows '.').
 * Non-string leaves are dropped.
 */
export function flattenLocaleDict(
  obj: Record<string, unknown>,
  prefix = ''
): ManifestLocaleDict {
  const out: ManifestLocaleDict = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else if (v && typeof v === 'object') {
      Object.assign(out, flattenLocaleDict(v as Record<string, unknown>, key))
    }
  }
  return out
}

export interface ResolveOptions {
  currentDict: ManifestLocaleDict
  fallbackDict: ManifestLocaleDict // en-US — required
}

const PLACEHOLDER_RE = /^%([\w.-]+)%$/
const PARTIAL_PLACEHOLDER_RE = /%[\w.-]+%/

function resolveOne(value: string, opts: ResolveOptions): string {
  const m = PLACEHOLDER_RE.exec(value)
  if (!m) {
    if (PARTIAL_PLACEHOLDER_RE.test(value)) {
      throw new PluginManifestInvalid(
        'plugin.manifest.i18n.mixed_placeholder',
        `manifest field "${value}" mixes literal and %key% — whole-field placeholders only`
      )
    }
    return value
  }
  const key = m[1]
  return opts.currentDict[key] ?? opts.fallbackDict[key] ?? value
}

function walkSchemaNode(
  node: JsonSchemaNode,
  opts: ResolveOptions
): JsonSchemaNode {
  const out: JsonSchemaNode = { ...node }
  if (typeof node.title === 'string') out.title = resolveOne(node.title, opts)
  if (typeof node.description === 'string') {
    out.description = resolveOne(node.description, opts)
  }
  if (node.properties) {
    const props: Record<string, JsonSchemaNode> = {}
    for (const [k, v] of Object.entries(node.properties)) {
      props[k] = walkSchemaNode(v, opts)
    }
    out.properties = props
  }
  if (node.items) out.items = walkSchemaNode(node.items, opts)
  return out
}

function walkContributes(
  c: ManifestContributes,
  opts: ResolveOptions
): ManifestContributes {
  const out: ManifestContributes = { ...c }
  if (c.commands) {
    out.commands = c.commands.map((cmd) =>
      typeof cmd.title === 'string'
        ? { ...cmd, title: resolveOne(cmd.title, opts) }
        : cmd
    )
  }
  if (c.configuration) {
    const cfg = { ...c.configuration }
    if (typeof cfg.title === 'string') cfg.title = resolveOne(cfg.title, opts)
    if (typeof cfg.description === 'string') {
      cfg.description = resolveOne(cfg.description, opts)
    }
    if (cfg.schema && typeof cfg.schema === 'object') {
      cfg.schema = walkSchemaNode(cfg.schema as JsonSchemaNode, opts)
    }
    out.configuration = cfg
  }
  return out
}

const TOP_LEVEL_RESOLVABLE_FIELDS = ['name', 'description'] as const

export function resolveManifestI18n(
  manifest: PluginManifest,
  opts: ResolveOptions
): PluginManifest {
  const out: PluginManifest = { ...manifest }
  for (const f of TOP_LEVEL_RESOLVABLE_FIELDS) {
    const v = manifest[f]
    if (typeof v === 'string') {
      ;(out as unknown as Record<string, unknown>)[f] = resolveOne(v, opts)
    }
  }
  out.contributes = walkContributes(manifest.contributes, opts)
  return out
}
