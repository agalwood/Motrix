import { describe, expect, it } from 'vitest'
import { isSqliteCorruptionDiagnostic } from './aria2-sqlite-recovery'

describe('isSqliteCorruptionDiagnostic', () => {
  it.each([
    'database disk image is malformed',
    'sqlite error SQLITE_CORRUPT while reading task table',
    'SQLITE_NOTADB: file is encrypted or is not a database',
    'malformed database schema (task)',
  ])('accepts a proven corruption diagnostic: %s', (diagnostic) => {
    expect(isSqliteCorruptionDiagnostic(diagnostic)).toBe(true)
  })

  it.each([
    'database is locked',
    'attempt to write a readonly database',
    'disk I/O error',
    'database or disk is full',
    'connection refused',
  ])('rejects a non-corruption failure: %s', (diagnostic) => {
    expect(isSqliteCorruptionDiagnostic(diagnostic)).toBe(false)
  })
})
