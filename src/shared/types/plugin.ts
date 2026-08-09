// src/shared/types/plugin.ts
// Phase 1A DTO-only types. Manifest schema lives in @core/plugin/manifest/schema.ts.

export type PluginStatus =
  | 'inactive' // installed + enabled, VM not running
  | 'active' // VM running
  | 'disabled' // user-disabled or breaker-disabled
  | 'error' // last load/hook failed

export type PluginRuntime = 'electron' | 'server'

export type PluginSourceType =
  | 'github'
  | 'url'
  | 'local'
  | 'volume'
  | 'env'
  // Spec §7 L2418-2431 — plugin loaded from MOTRIX_PLUGIN_DEV_PATH. Bypasses
  // the installer/consent path; never written to _install.json.
  | 'dev'
  | 'builtin'
  // Builtin whose effective code comes from the signature-verified
  // <userData>/builtin-updates overlay rather than the read-only seed.
  | 'builtin-update'
  | 'registry'

export interface PluginSource {
  type: PluginSourceType
  url: string // normalized; see spec §8 source.url normalization rules
  bundleSha256?: string // hex digest of installed bundle; informational in 1A
  recordedAt: number // ms epoch of first install
}

export interface PluginManifest {
  manifestVersion: 1
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  license?: string
  icon?: string
  categories: ReadonlyArray<string>
  keywords?: ReadonlyArray<string>
  engines: { motrix: string; ffmpeg?: string }
  main: string
  requestedHeapMB?: number
  permissions: ReadonlyArray<string>
  optionalPermissions?: ReadonlyArray<string>
  hostPermissions?: ReadonlyArray<string>
  invokesCommands?: ReadonlyArray<string>
  activationEvents: ReadonlyArray<string>
  contributes: ManifestContributes
  l10n?: string
}

// Loose contributes shape for Core Runtime. Plan C/D/G tighten each inner schema.
export interface ManifestContributes {
  commands?: ReadonlyArray<{
    id: string
    title: string
    icon?: string
    public?: boolean
    // Plan D: bounded JSON Schema subset, validated by the Zod manifest
    // parser. Required when `public: true`. Compiled into Ajv validators
    // by SchemaCache at install time; never reaches the plugin VM.
    argsSchema?: unknown
    resultSchema?: unknown
  }>
  hooks?: Readonly<Record<string, { role?: string }>>
  configuration?: { title?: string; description?: string; schema: unknown }
  [forwardCompat: string]: unknown
}

// Bounded JSON Schema subset accepted by `contributes.configuration.schema`.
// Plan D / i18n-resolve walk these nodes recursively. Renderer's
// `jsonSchemaToZod` reads them too; both sides share this single definition.
export interface JsonSchemaNode {
  type?:
    | 'object'
    | 'array'
    | 'string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'null'
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  required?: string[]
  enum?: unknown[]
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  default?: unknown
  additionalProperties?: boolean | JsonSchemaNode
  // Plan D contributes — `secret: true` flags a string field as sensitive.
  secret?: boolean
  title?: string
  description?: string
}

// Persistent runtime state (mirrored from plugin_state table).
export interface PluginStateRecord {
  pluginId: string
  enabled: boolean
  status: PluginStatus
  lastError?: string
  errorCount: number
  installedAt: number
  lastActivatedAt?: number
}

// IPC list/detail DTOs. UI plan extends these.
export interface PluginListDTO {
  id: string
  name: string
  version: string
  description: string
  status: PluginStatus
  enabled: boolean
  permissions: ReadonlyArray<string>
  optionalPermissions: ReadonlyArray<string>
  source?: PluginSource
  errorCount: number
  lastError?: string
}

export interface PluginManifestDTO extends PluginManifest {
  // identical to PluginManifest at the wire — i18n %key% values already resolved
  // by the host before returning to renderer.
}

export interface CapabilityAvailability {
  available: boolean
}

// Per-plugin persisted user config (stored under AppSettings.plugins).
// Keyed by plugin id. Phase 1A keeps this opaque — Plan C tightens the schema.
export type PluginSettings = Record<string, Record<string, unknown>>

// Wire shape of a single log entry. Mirrored by `LogEntry` in
// @core/plugin/capabilities/interface — kept in @shared/ so the renderer can
// type the GetPluginLogs query result and the `event:pluginLog:<id>` payload.
export interface PluginLogEntry {
  ts: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  msg: string
  [key: string]: unknown
}
