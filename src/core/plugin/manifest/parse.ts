// src/core/plugin/manifest/parse.ts

import { PluginEngineVersionTooOld, PluginManifestInvalid } from './errors'
import {
  type HookRole,
  isReservedPublisher,
  ManifestSchema,
  type ManifestZodOutput,
} from './schema'

const KNOWN_CONTRIBUTES_KEYS = ['commands', 'hooks', 'configuration'] as const
const TYPO_DISTANCE_THRESHOLD = 2

// Spec §2 L331-345 — Phase 1A activation event vocabulary. Unknown tokens
// outside this set are forward-compat warnings, NOT errors (Phase 1B can
// introduce onSettingsOpen / onTaskComplete / onTaskError on existing v2.x
// hosts without making old hosts reject the new manifest).
const KNOWN_ACTIVATION_EVENT_LITERALS = new Set(['*', 'onStartup'])
const KNOWN_ACTIVATION_EVENT_PREFIXES = [
  'onCommand:',
  'onTaskType:',
  'onProtocol:',
] as const

function isKnownActivationEvent(token: string): boolean {
  if (KNOWN_ACTIVATION_EVENT_LITERALS.has(token)) return true
  return KNOWN_ACTIVATION_EVENT_PREFIXES.some(
    (p) => token.startsWith(p) && token.length > p.length
  )
}

export interface ParseManifestOptions {
  hostVersion: string
  // Builtins ship inside the app bundle and are allowed to claim reserved
  // publishers (motrix.*); community plugins discovered or installed at
  // runtime always default to 'community'.
  origin?: 'community' | 'builtin'
}

export interface ManifestWarning {
  code: 'unknown-contributes-key' | 'unknown-activation-event'
  key: string
}

export interface ParseResult {
  manifest: ManifestZodOutput
  warnings: ManifestWarning[]
}

export function semverSatisfies(version: string, range: string): boolean {
  if (range.trim() === '*') return true
  const v = parseVer(version)
  const clauses = range.trim().split(/\s+/)
  for (const c of clauses) {
    if (!testClause(v, c)) return false
  }
  return true
}

function parseVer(s: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s)
  if (!m)
    throw new PluginManifestInvalid(
      'plugin.manifest.host_version_unparseable',
      `unparseable host version: ${s}`
    )
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function testClause(v: [number, number, number], clause: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)/.exec(clause)
  if (!m)
    throw new PluginManifestInvalid(
      'plugin.manifest.engines_unparseable',
      `unparseable range clause: ${clause}`
    )
  const op = m[1] ?? '='
  const r: [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])]
  const cmp = cmpVer(v, r)
  switch (op) {
    case '>=':
      return cmp >= 0
    case '<=':
      return cmp <= 0
    case '>':
      return cmp > 0
    case '<':
      return cmp < 0
    case '=':
      return cmp === 0
    case '^':
      return v[0] === r[0] && cmp >= 0
    case '~':
      return v[0] === r[0] && v[1] === r[1] && cmp >= 0
    default:
      return false
  }
}

function cmpVer(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}

export function parseManifest(
  raw: string,
  opts: ParseManifestOptions
): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new PluginManifestInvalid(
      'plugin.manifest.invalid',
      `manifest is not valid JSON: ${(e as Error).message}`
    )
  }

  // Step 1: Read engines.motrix BEFORE strict schema validation.
  const enginesMotrix =
    typeof parsed === 'object' &&
    parsed !== null &&
    'engines' in parsed &&
    typeof (parsed as { engines: unknown }).engines === 'object' &&
    (parsed as { engines: { motrix?: unknown } }).engines !== null
      ? (parsed as { engines: { motrix?: unknown } }).engines.motrix
      : undefined
  if (typeof enginesMotrix === 'string') {
    if (!semverSatisfies(opts.hostVersion, enginesMotrix)) {
      throw new PluginEngineVersionTooOld(enginesMotrix, opts.hostVersion)
    }
  }

  // Step 2: Apply strict schema validation.
  const result = ManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new PluginManifestInvalid(
      'plugin.manifest.invalid',
      'manifest failed schema validation',
      result.error.issues
    )
  }

  // Step 3: Enforce reserved-publisher invariant. Community plugins must not
  // claim a reserved publisher (motrix.*, verified.*, official.*, system.*).
  // Built-ins shipped inside the app bundle are exempt — they originate from
  // <resourcesDir>/builtin-plugins/ and the registry passes origin='builtin'.
  const origin = opts.origin ?? 'community'
  if (origin !== 'builtin' && isReservedPublisher(result.data.id)) {
    throw new PluginManifestInvalid(
      'plugin.manifest.id_reserved_publisher',
      `publisher name is reserved: "${result.data.id}"`,
      { manifestId: result.data.id }
    )
  }

  // Step 4: Enforce command-id namespace invariant — every contributed
  // command id must start with `<manifest.id>.` so cross-plugin invocations
  // can rely on the publisher prefix for routing/auth.
  const manifestId = result.data.id
  const commands = result.data.contributes.commands
  if (Array.isArray(commands)) {
    for (const cmd of commands) {
      if (!cmd.id.startsWith(`${manifestId}.`)) {
        throw new PluginManifestInvalid(
          'plugin.manifest.command.id_out_of_namespace',
          `contributes.commands[].id "${cmd.id}" must start with "${manifestId}."`,
          { commandId: cmd.id, manifestId }
        )
      }
    }
  }

  // Step 5: Typo detection vs forward-compat passthrough for contributes keys.
  const warnings: ManifestWarning[] = []
  const typos: Array<{ key: string; suggestion: string }> = []
  for (const k of Object.keys(result.data.contributes)) {
    if ((KNOWN_CONTRIBUTES_KEYS as readonly string[]).includes(k)) continue
    let bestKey = ''
    let bestDist = Infinity
    for (const cand of KNOWN_CONTRIBUTES_KEYS) {
      const d = levenshtein(k, cand)
      if (d < bestDist) {
        bestDist = d
        bestKey = cand
      }
    }
    if (bestDist > 0 && bestDist <= TYPO_DISTANCE_THRESHOLD) {
      typos.push({ key: k, suggestion: bestKey })
    } else {
      warnings.push({ code: 'unknown-contributes-key', key: k })
    }
  }
  if (typos.length > 0) {
    throw new PluginManifestInvalid(
      'plugin.manifest.contributes_key_typo',
      typos
        .map(
          (t) =>
            `"contributes.${t.key}" is unknown; did you mean "${t.suggestion}"?`
        )
        .join('\n'),
      typos
    )
  }

  // Step 6: Hook-driven invariants — both the role-eligibility rules
  // (spec §2 L569-577) and the host-permissions requirement (spec §2 L308-314
  // / §9.5 I29) need cross-field state (origin, categories, hostPermissions)
  // not available inside ManifestSchema, AND benefit from a specific error
  // code that the generic schema-wrapper at Step 2 would otherwise flatten.
  const hooks = result.data.contributes.hooks
  if (hooks && Object.keys(hooks).length > 0) {
    const hp = result.data.hostPermissions ?? []
    if (hp.length === 0) {
      throw new PluginManifestInvalid(
        'plugin.manifest.host_permissions_required_for_hooks',
        'declared hooks require at least one hostPermissions entry',
        { declaredHooks: Object.keys(hooks) }
      )
    }
  }
  if (hooks) {
    const categories = new Set(result.data.categories)
    for (const [hookName, entry] of Object.entries(hooks)) {
      if (!entry) continue
      const role = entry.role as HookRole
      if (role === 'pre-resolve' && origin !== 'builtin') {
        throw new PluginManifestInvalid(
          'plugin.manifest.role.requires_builtin',
          `contributes.hooks.${hookName}.role "pre-resolve" is reserved for built-in plugins`,
          { hook: hookName, role, origin }
        )
      }
      if (role === 'resolve' && !categories.has('site-resolver')) {
        throw new PluginManifestInvalid(
          'plugin.manifest.role.requires_category',
          `contributes.hooks.${hookName}.role "resolve" requires "site-resolver" in categories`,
          { hook: hookName, role, requiredCategory: 'site-resolver' }
        )
      }
      if (role === 'post-process' && !categories.has('post-action')) {
        throw new PluginManifestInvalid(
          'plugin.manifest.role.requires_category',
          `contributes.hooks.${hookName}.role "post-process" requires "post-action" in categories`,
          { hook: hookName, role, requiredCategory: 'post-action' }
        )
      }
    }
  }

  // Step 7: Unknown activation events — forward-compat warning, NOT error
  // (spec §2 L343). v2.5 plugins declaring `onSettingsOpen` install fine on
  // v2.0 hosts; they just won't activate on that token.
  for (const token of result.data.activationEvents) {
    if (!isKnownActivationEvent(token)) {
      warnings.push({ code: 'unknown-activation-event', key: token })
    }
  }

  return { manifest: result.data, warnings }
}
