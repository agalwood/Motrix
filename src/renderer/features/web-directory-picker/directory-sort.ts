import type { ListServerDirectoriesResult } from '@shared/schemas/server-directory'
import { z } from 'zod'

export const DirectorySortSchema = z
  .object({
    by: z.enum(['name', 'modified']),
    direction: z.enum(['asc', 'desc']),
  })
  .strict()
export type DirectorySort = z.infer<typeof DirectorySortSchema>
export const DEFAULT_DIRECTORY_SORT: DirectorySort = {
  by: 'name',
  direction: 'asc',
}
export const DIRECTORY_SORT_STORAGE_KEY = 'motrix.web-directory-picker.sort.v1'
const StoredSortSchema = DirectorySortSchema.extend({
  version: z.literal(1),
}).strict()

/** A failed storage write must not undo the current page's choice on reopen. */
export class DirectorySortPreferences {
  private current?: DirectorySort

  constructor(
    private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'> = () =>
      window.localStorage
  ) {}

  get(): DirectorySort {
    if (this.current) return this.current
    try {
      const value = StoredSortSchema.safeParse(
        JSON.parse(this.storage().getItem(DIRECTORY_SORT_STORAGE_KEY) ?? 'null')
      )
      if (value.success) {
        const { by, direction } = value.data
        this.current = { by, direction }
        return this.current
      }
    } catch {
      // Private mode or denied storage still supports page-local preferences.
    }
    this.current = { ...DEFAULT_DIRECTORY_SORT }
    return this.current
  }

  set(sort: DirectorySort) {
    const parsed = DirectorySortSchema.safeParse(sort)
    if (!parsed.success) return
    this.current = parsed.data
    try {
      this.storage().setItem(
        DIRECTORY_SORT_STORAGE_KEY,
        JSON.stringify({ version: 1, ...parsed.data })
      )
    } catch {
      // The in-memory choice stays authoritative until this page closes.
    }
  }
}

export const directorySortPreferences = new DirectorySortPreferences()

type Entry = Extract<
  ListServerDirectoriesResult,
  { ok: true }
>['value']['entries'][number]
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareName = (a: Entry, b: Entry) =>
  names.compare(a.name, b.name) ||
  ordinal(a.name, b.name) ||
  ordinal(a.path, b.path)

/** Sort a copy; cached host responses and entry identities stay untouched. */
export function sortDirectoryEntries(
  entries: Entry[],
  sort: DirectorySort
): Entry[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    if (sort.by === 'name') return direction * compareName(a, b)
    const aTime = a.modifiedAt
    const bTime = b.modifiedAt
    if (aTime === undefined) return bTime === undefined ? compareName(a, b) : 1
    if (bTime === undefined) return -1
    return (
      direction * (aTime < bTime ? -1 : aTime > bTime ? 1 : 0) ||
      compareName(a, b)
    )
  })
}
