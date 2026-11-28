import type Database from 'better-sqlite3'
export function durableSqliteWrite<T>(
  db: Database.Database,
  run: () => T,
  owner: string,
  immediate = false
): T {
  if (db.inTransaction)
    throw new Error(`${owner} durability requires an outermost transaction`)
  const previous = db.pragma('synchronous', { simple: true }) as number
  // Keep stronger caller settings; change this connection only, outside a
  // transaction. No awaits or unrelated writes can enter this sync boundary.
  const previousFull =
    process.platform === 'darwin'
      ? (db.pragma('fullfsync', { simple: true }) as number)
      : undefined
  try {
    // SQLite's FULL synchronous level alone uses fsync on macOS. The WAL
    // must reach stable storage before a mutation on a separate download disk.
    if (previousFull === 0) db.pragma('fullfsync = ON')
    if (previous < 2) db.pragma('synchronous = FULL')
    const transaction = db.transaction(run)
    return immediate ? transaction.immediate() : transaction()
  } finally {
    if (previous < 2) db.pragma(`synchronous = ${previous}`)
    if (previousFull === 0) db.pragma('fullfsync = OFF')
  }
}
