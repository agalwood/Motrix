import { access, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { Aria2RpcClient } from './aria2-rpc-client'
import { isNotFoundError } from './error-utils'

const gidSchema = z.string().regex(/^[0-9a-f]{16}$/)
const journalSchema = z
  .object({
    version: z.literal(1),
    source: z.string(),
    resume: z.array(gidSchema),
  })
  .strict()

export interface PreparedEngineStartup {
  args: string[]
  reconcile: (isStopping: () => boolean) => Promise<void>
}

export interface EngineStartupGuard {
  prepare(args: readonly string[]): Promise<PreparedEngineStartup | null>
}

function argument(args: readonly string[], name: string): string | undefined {
  return args
    .findLast((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

/** Reads only identity and original run intent; never exports URL/options. */
export function parseSessionRunIntent(text: string): Map<string, boolean> {
  const result = new Map<string, boolean>()
  let inEntry = false
  let gid: string | undefined
  let paused = false
  const finish = () => {
    if (!inEntry) return
    if (!gid || result.has(gid))
      throw new Error(
        'Ambiguous engine session identity during completed-task recovery'
      )
    result.set(gid, !paused)
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      finish()
      inEntry = true
      gid = undefined
      paused = false
      continue
    }
    const option = line.trim()
    if (option.startsWith('gid=')) {
      const parsed = gidSchema.safeParse(option.slice(4))
      if (!parsed.success || gid)
        throw new Error(
          'Invalid engine session identity during completed-task recovery'
        )
      gid = parsed.data
    }
    if (option.startsWith('pause=')) {
      // An explicit false overrides --pause=true while loading the session.
      // Our serializer omits false. Fail closed for unsupported custom input.
      if (option !== 'pause=true')
        throw new Error('Engine session overrides the startup pause barrier')
      paused = true
    }
  }
  finish()
  return result
}

async function readRunIntent(
  source: string,
  sqlite: boolean,
  needsGuard: (gids: readonly string[]) => boolean
): Promise<Map<string, boolean>> {
  if (!sqlite) {
    try {
      const text = await readFile(source, 'utf8')
      const gids = [...text.matchAll(/^\s+gid=([0-9a-f]{16})\s*$/gm)].map(
        (match) => match[1]
      )
      return needsGuard(gids) ? parseSessionRunIntent(text) : new Map()
    } catch (error) {
      if (missing(error)) return new Map()
      throw error
    }
  }
  // The supervisor has already checked that its managed RPC port is unused.
  // Read through SQLite (including WAL), never edit another engine's tables.
  try {
    await access(source)
  } catch (error) {
    if (missing(error)) return new Map()
    throw error
  }
  const db = new Database(source, { readonly: true, fileMustExist: true })
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task'"
        )
        .get()
    )
      return new Map()
    const rows = db
      .prepare(
        'SELECT gid, state, serialized FROM task ORDER BY queue_position'
      )
      .all() as Array<{ gid: string; state: string; serialized: string }>
    if (!needsGuard(rows.map((row) => row.gid))) return new Map()
    const result = new Map<string, boolean>()
    for (const row of rows) {
      const parsed = parseSessionRunIntent(row.serialized)
      if (
        parsed.size !== 1 ||
        !parsed.has(row.gid) ||
        !['waiting', 'paused'].includes(row.state) ||
        result.has(row.gid)
      ) {
        throw new Error('Unsupported persisted engine run intent')
      }
      result.set(
        row.gid,
        row.state !== 'paused' && parsed.get(row.gid) === true
      )
    }
    return result
  } finally {
    db.close()
  }
}

/**
 * A targeted startup barrier for durable completed GIDs. Other downloads keep
 * the engine's original run intent, including engine-only and paused tasks.
 * A small durable journal preserves that intent if a paused boot is interrupted.
 */
export class CompletedTaskStartupGuard implements EngineStartupGuard {
  constructor(
    private readonly deps: {
      completedGids: () => ReadonlySet<string>
      rpc: Pick<
        Aria2RpcClient,
        'tellStatus' | 'forceRemove' | 'unpause' | 'changeGlobalOption'
      >
      removeResult: (gid: string) => Promise<void>
    }
  ) {}

  async prepare(
    args: readonly string[]
  ): Promise<PreparedEngineStartup | null> {
    const sessionPath = argument(args, 'save-session')
    if (!sessionPath) return null
    const sqlite = argument(args, 'enable-sqlite3-persistence') === 'true'
    const sourcePath = sqlite
      ? argument(args, 'sqlite3-db-path')
      : argument(args, 'input-file')
    if (!sourcePath) return null
    const source = path.resolve(sourcePath)
    const journalPath = `${sessionPath}.completed-recovery.json`
    let previous: z.infer<typeof journalSchema> | null = null
    try {
      previous = journalSchema.parse(
        JSON.parse(await readFile(journalPath, 'utf8'))
      )
      if (previous.source !== source)
        throw new Error(
          'Completed-task recovery journal belongs to a different engine session'
        )
    } catch (error) {
      if (!missing(error)) throw error
    }
    const completed = this.deps.completedGids()
    if (!previous && completed.size === 0) return null
    const intent = await readRunIntent(
      source,
      sqlite,
      (gids) => previous !== null || gids.some((gid) => completed.has(gid))
    )
    const targets = [...intent.keys()].filter((gid) => completed.has(gid))
    if (!previous && targets.length === 0) return null
    const resume = previous
      ? previous.resume.filter((gid) => intent.has(gid))
      : [...intent].filter(([, run]) => run).map(([gid]) => gid)
    await writeFileAtomic(
      journalPath,
      JSON.stringify({ version: 1, source, resume }),
      { mode: 0o600 }
    )

    return {
      args: [
        ...args.filter((value) => !value.startsWith('--pause=')),
        '--pause=true',
      ],
      reconcile: async (isStopping) => {
        for (const gid of targets) {
          if (isStopping()) return
          let state: string | undefined
          try {
            state = (await this.deps.rpc.tellStatus(gid)).status
          } catch (error) {
            if (!isNotFoundError(error)) throw error
          }
          if (state && !['complete', 'error', 'removed'].includes(state)) {
            try {
              await this.deps.rpc.forceRemove(gid)
            } catch (error) {
              if (!isNotFoundError(error)) throw error
            }
          }
          await this.deps.removeResult(gid)
        }
        // Do not release any remaining task if even one required purge failed.
        if (isStopping()) return
        await this.deps.rpc.changeGlobalOption({ pause: 'false' })
        const completedNow = this.deps.completedGids()
        for (const gid of resume) {
          if (isStopping()) return
          if (completedNow.has(gid)) continue
          try {
            if ((await this.deps.rpc.tellStatus(gid)).status === 'paused')
              await this.deps.rpc.unpause(gid)
          } catch (error) {
            if (!isNotFoundError(error)) throw error
          }
        }
        if (!isStopping()) await unlink(journalPath)
      },
    }
  }
}
