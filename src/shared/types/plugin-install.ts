// DTOs for the plugin install / upgrade / uninstall pipeline (Plan E).
//
// `InstallRecord` is the durable record (`_install.json`) Motrix writes to a
// plugin directory after a successful install. It captures (1) provenance —
// where the plugin came from — and (2) `consentSnapshot`, the trust surface
// the user (or operator) already agreed to. On upgrade, a fresh manifest is
// diffed against `consentSnapshot` to compute what changed; only a non-empty
// diff triggers a re-consent flow.
//
// `TrustSurfaceDiff` lists every dimension along which an upgrade can broaden
// the trust surface. Anything in here being non-empty means consent is needed.
//
// `ConsentPayload` is what the renderer dialog (Plan F) consumes — the
// human-readable explanation plus the raw diff for cosmetics.

export const INSTALL_SOURCE_TYPES = [
  'github',
  'url',
  'local',
  'volume',
  'env',
  'builtin',
  'registry',
] as const

export type InstallSourceType = (typeof INSTALL_SOURCE_TYPES)[number]

export type GrantState = 'granted' | 'denied'
export type GrantsMap = Record<string, GrantState>

export interface InstallRecordSource {
  type: InstallSourceType
  url: string
  bundleSha256: string
  recordedAt: number
}

export interface ConsentSnapshot {
  permissions: ReadonlyArray<string>
  optionalPermissions: ReadonlyArray<string>
  invokesCommands: ReadonlyArray<string>
  /** commandId → sha256(JSON.stringify({ argsSchema, resultSchema })) */
  publicCommands: Record<string, string>
  requestedHeapMB: number
  enginesMotrix: string
  hostPermissions: ReadonlyArray<string>
}

export interface InstallRecord {
  version: 1
  pluginId: string
  source: InstallRecordSource
  /** optionalPermission name → state at last consent confirmation */
  grants: GrantsMap
  consentSnapshot: ConsentSnapshot
}

export interface TrustSurfaceDiff {
  permissionsAdded: ReadonlyArray<string>
  optionalPermissionsAdded: ReadonlyArray<string>
  invokesCommandsAdded: ReadonlyArray<string>
  /** commands newly exposed as public OR previously absent */
  publicCommandsAdded: ReadonlyArray<string>
  publicCommandsSchemaChanged: ReadonlyArray<string>
  hostPermissionsAdded: ReadonlyArray<string>
  requestedHeapMBIncreased: { from: number; to: number } | null
  enginesMotrixMajorChange: { from: string; to: string } | null
  sourceUrlChanged: { from: string; to: string } | null
}

export interface ConsentPayloadManifest {
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
}

export interface ConsentPayloadPermission {
  name: string
  description: string
}

export interface ConsentPayloadHostPermission {
  pattern: string
  broad: boolean
}

export interface ConsentPayloadInvokesCommand {
  commandId: string
  calleeInstalled: boolean
  calleeTitle?: string
}

export interface ConsentPayloadPublicCommand {
  id: string
  title: string
}

export interface ConsentPayloadTrustSurface {
  permissions: ReadonlyArray<ConsentPayloadPermission>
  optionalPermissions: ReadonlyArray<ConsentPayloadPermission>
  hostPermissions: ReadonlyArray<ConsentPayloadHostPermission>
  invokesCommands: ReadonlyArray<ConsentPayloadInvokesCommand>
  publicCommandsExposed: ReadonlyArray<ConsentPayloadPublicCommand>
  requestedHeapMB?: number
  enginesMotrix: string
  /** Always `true` in Phase 1A — there is no signing yet. */
  notVerified: true
}

export interface ConsentPayloadFfmpegRuntime {
  available: boolean
  version?: string
  /** undefined when requiredByPlugin === 'none'; boolean otherwise */
  satisfiesRange?: boolean
  requiredByPlugin: 'required' | 'optional' | 'none'
}

export interface ConsentPayload {
  manifest: ConsentPayloadManifest
  source: InstallRecordSource
  trustSurface: ConsentPayloadTrustSurface
  /** `null` for a fresh install; non-null for an upgrade */
  diff: TrustSurfaceDiff | null
  ffmpegRuntime: ConsentPayloadFfmpegRuntime
}
