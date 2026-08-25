/** SQLite diagnostics that prove the persistence file itself is malformed. */
const SQLITE_CORRUPTION_PATTERNS = [
  /SQLITE_CORRUPT/i,
  /SQLITE_NOTADB/i,
  /database disk image is malformed/i,
  /file is not a database/i,
  /malformed database schema/i,
  /database corruption/i,
] as const

/**
 * Keep fallback deliberately narrow. Permission, lock, disk-full and generic
 * I/O failures must remain visible instead of being misreported as corruption.
 */
export function isSqliteCorruptionDiagnostic(diagnostic: string): boolean {
  return SQLITE_CORRUPTION_PATTERNS.some((pattern) => pattern.test(diagnostic))
}
