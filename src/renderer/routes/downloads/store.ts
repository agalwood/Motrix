import { createSelectionStore } from '@renderer/components/desktop-kit/selection/create-selection-store'
import type { DownloadTask } from '@shared/types/task'
import { create } from 'zustand'
import {
  DEFAULT_TASK_SORT,
  nextTaskSort,
  type TaskSort,
  type TaskSortColumn,
  TaskSortSchema,
} from './sort'

/**
 * Module-level singleton selection store for the Downloads page.
 *
 * Shared by the list, task actions, and inspector. Inspector visibility is
 * an independent view preference; selection never implicitly opens it.
 */
export const useDownloadsSelection = createSelectionStore<DownloadTask>(
  (t) => t.id
)

const DOWNLOADS_SORT_STORAGE_KEY = 'motrix.downloads.sort'

function readSavedSort(): TaskSort {
  try {
    const saved = localStorage.getItem(DOWNLOADS_SORT_STORAGE_KEY)
    return saved === null ? null : TaskSortSchema.parse(JSON.parse(saved))
  } catch {
    // Missing storage or an outdated/invalid preference uses the default.
    return null
  }
}

function saveSort(sort: TaskSort): void {
  try {
    if (sort === null) localStorage.removeItem(DOWNLOADS_SORT_STORAGE_KEY)
    else localStorage.setItem(DOWNLOADS_SORT_STORAGE_KEY, JSON.stringify(sort))
  } catch {
    // Keep in-memory sorting usable when browser storage is unavailable.
  }
}

interface DownloadsSortState {
  sort: TaskSort
  toggleSort: (column: TaskSortColumn) => void
  setSort: (sort: TaskSort) => void
  resetSort: () => void
}

export function createDownloadsSortStore() {
  return create<DownloadsSortState>((set, get) => ({
    sort: readSavedSort(),
    toggleSort: (column) => {
      const sort = nextTaskSort(get().sort ?? DEFAULT_TASK_SORT, column)
      get().setSort(sort)
    },
    setSort: (sort) => {
      const validated = TaskSortSchema.parse(sort)
      saveSort(validated)
      set({ sort: validated })
    },
    resetSort: () => get().setSort(null),
  }))
}

// UI-only preference shared by Downloads filters and restored on app startup.
export const useDownloadsSort = createDownloadsSortStore()
