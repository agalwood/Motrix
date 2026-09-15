import { z } from 'zod'
import { create } from 'zustand'
import {
  clampColumnWidth,
  defaultTaskColumns,
  type TaskColumn,
} from './columns'
import { TASK_SORT_COLUMNS, type TaskSortColumn } from './sort'

const STORAGE_KEY = 'motrix.downloads.view.v1'
const ViewPreferencesSchema = z.object({
  version: z.literal(1),
  columns: z
    .array(
      z.object({
        id: z.enum(TASK_SORT_COLUMNS),
        width: z.number().finite().min(40).max(1200),
        visible: z.boolean(),
      })
    )
    .length(TASK_SORT_COLUMNS.length)
    .refine(
      (columns) =>
        new Set(columns.map((column) => column.id)).size ===
        TASK_SORT_COLUMNS.length
    ),
  inspectorVisible: z.boolean(),
  inspectorSnap: z.enum(['compact', 'medium', 'expanded']),
})

function defaults() {
  return {
    version: 1 as const,
    columns: defaultTaskColumns(),
    inspectorVisible: false,
    inspectorSnap: 'medium' as const,
  }
}

function readPreferences() {
  try {
    const saved = ViewPreferencesSchema.parse(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    )
    return {
      ...saved,
      columns: saved.columns.map((column) => ({
        ...column,
        width: clampColumnWidth(column.id, column.width),
        visible: column.id === 'name' || column.visible,
      })),
    }
  } catch {
    return defaults()
  }
}

export type InspectorTab =
  | 'overview'
  | 'files'
  | 'pieces'
  | 'peers'
  | 'trackers'
  | 'activity'

interface DownloadsViewState {
  inspectorTab: InspectorTab
  setInspectorTab: (tab: InspectorTab) => void
  columns: TaskColumn[]
  inspectorVisible: boolean
  inspectorSnap: 'compact' | 'medium' | 'expanded'
  setColumnVisible: (id: TaskSortColumn, visible: boolean) => void
  setColumnWidth: (id: TaskSortColumn, width: number, persist?: boolean) => void
  moveColumn: (id: TaskSortColumn, before: TaskSortColumn) => void
  resetColumns: () => void
  setInspectorVisible: (visible: boolean) => void
  setInspectorSnap: (snap: 'compact' | 'medium' | 'expanded') => void
  persist: () => void
}

export function createDownloadsViewStore() {
  return create<DownloadsViewState>((set, get) => ({
    ...readPreferences(),
    inspectorTab: 'overview',
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    persist: () => {
      const { columns, inspectorVisible, inspectorSnap } = get()
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 1,
            columns,
            inspectorVisible,
            inspectorSnap,
          })
        )
      } catch {
        // The view remains usable when storage is blocked or full.
      }
    },
    setColumnVisible: (id, visible) => {
      set({
        columns: get().columns.map((column) =>
          column.id === id
            ? { ...column, visible: id === 'name' || visible }
            : column
        ),
      })
      get().persist()
    },
    setColumnWidth: (id, width, persist = true) => {
      set({
        columns: get().columns.map((column) =>
          column.id === id
            ? { ...column, width: clampColumnWidth(id, width) }
            : column
        ),
      })
      if (persist) get().persist()
    },
    moveColumn: (id, before) => {
      if (id === before) return
      const columns = [...get().columns]
      const source = columns.findIndex((column) => column.id === id)
      if (source < 0) return
      const [column] = columns.splice(source, 1)
      const target = columns.findIndex((column) => column.id === before)
      if (target < 0) return
      columns.splice(target, 0, column)
      set({ columns })
      get().persist()
    },
    resetColumns: () => {
      set({ columns: defaultTaskColumns() })
      get().persist()
    },
    setInspectorVisible: (inspectorVisible) => {
      set({ inspectorVisible })
      get().persist()
    },
    setInspectorSnap: (inspectorSnap) => {
      set({ inspectorSnap })
      get().persist()
    },
  }))
}

export const useDownloadsView = createDownloadsViewStore()
