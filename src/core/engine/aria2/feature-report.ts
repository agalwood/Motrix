import {
  type EngineFeatureReport,
  FEATURE_SQLITE3_PERSISTENCE,
} from '@shared/types/engine'

// aria2 gained --bt-seed-unverified and --bt-save-metadata in 1.37.0.
const BT_FEATURES_MIN_VERSION = '1.37.0'

/** Official aria2's per-task connection ceiling. */
export const STANDARD_ARIA2_CONNECTION_LIMIT = 16

/**
 * Identify the Motrix fork from the pre-spawn `aria2c --version` report.
 * Both markers are required: the version suffix establishes lineage and the
 * feature token confirms the fork-only persistence capability is present.
 */
export function isMotrixFork(
  report: Pick<EngineFeatureReport, 'version' | 'hasSqlitePersistence'>
): boolean {
  return (
    /^\d+\.\d+\.\d+-motrix\.\d+$/i.test(report.version) &&
    report.hasSqlitePersistence
  )
}

/**
 * Single source for turning an aria2 (version, enabled-features) pair into an
 * EngineFeatureReport. Both the process-probe path (Aria2ProcessManager,
 * parsing `aria2c --version`) and the RPC-connect path (Aria2Adapter, reading
 * aria2.getVersion) build the report through here.
 *
 * Previously each built the report inline and they had drifted: the connect
 * path derived the BT flags from the version while the probe path hardcoded
 * them false — and EngineSupervisor stores the probe-path report (the one both
 * shells serve), so the version-derived flags never reached consumers.
 */
export function buildFeatureReport(
  version: string,
  features: string[]
): EngineFeatureReport {
  const btSupported = semverGte(version, BT_FEATURES_MIN_VERSION)
  return {
    version,
    features,
    hasSqlitePersistence: features.includes(FEATURE_SQLITE3_PERSISTENCE),
    hasBtSeedUnverified: btSupported,
    hasBtSaveMetadata: btSupported,
    // Move-storage is an option aria2 does not support yet; flipped on in
    // Feature B once the custom engine lands.
    hasMoveStorage: false,
  }
}

/** Lenient dotted-version >= compare; unparseable components fail to false. */
export function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10))
  const pb = b.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (Number.isNaN(ai) || Number.isNaN(bi)) return false
    if (ai > bi) return true
    if (ai < bi) return false
  }
  return true
}

/**
 * Whether this engine's `removeDownloadResult` semantics make a not-found
 * reply trustworthy as "durably absent". The motrix fork gained that
 * contract in 1.37.0-motrix.3: earlier fork builds resolve gids through the
 * live registry only, so history evicted from the in-memory window — and,
 * on .2, a FAILED sqlite3 delete — both surface as "GID is not found" while
 * the durable row survives. A lineage that advertises SQLite3-Persistence
 * but does not parse as a motrix fork is distrusted for the same reason.
 * Callers should consult this only when sqlite3 persistence is active;
 * without it there is no durable row a not-found could be hiding.
 */
export function hasDurableRemoveSemantics(version: string): boolean {
  const match = /^(\d+\.\d+\.\d+)-motrix\.(\d+)$/.exec(version)
  if (!match) return false
  const [, base, patch] = match
  if (!semverGte(base, '1.37.0')) return false
  if (base === '1.37.0') return Number.parseInt(patch, 10) >= 3
  return true
}
