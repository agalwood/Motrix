import { TASK_SORT_COLUMNS, type TaskSortColumn } from './sort'

export const TASK_ROW_HEIGHT = 36
export const TASK_HEADER_HEIGHT = 36

export const TASK_COLUMNS: Record<
  TaskSortColumn,
  { width: number; min: number; max: number; numeric?: boolean }
> = {
  name: { width: 200, min: 160, max: 900 },
  size: { width: 84, min: 72, max: 240, numeric: true },
  progress: { width: 104, min: 100, max: 300, numeric: true },
  status: { width: 100, min: 80, max: 240 },
  down: { width: 128, min: 128, max: 240, numeric: true },
  up: { width: 128, min: 128, max: 240, numeric: true },
  eta: { width: 112, min: 112, max: 240, numeric: true },
  connections: { width: 90, min: 72, max: 240, numeric: true },
  createdAt: { width: 196, min: 140, max: 300 },
  finishedAt: { width: 196, min: 140, max: 300 },
}

export function clampColumnWidth(column: TaskSortColumn, width: number) {
  const definition = TASK_COLUMNS[column]
  return Number.isFinite(width)
    ? Math.round(Math.max(definition.min, Math.min(definition.max, width)))
    : definition.width
}

export function defaultTaskColumns() {
  return TASK_SORT_COLUMNS.map((id) => ({
    id,
    width: TASK_COLUMNS[id].width,
    visible: true,
  }))
}

export type TaskColumn = ReturnType<typeof defaultTaskColumns>[number]

export function taskGridStyle(columns: readonly TaskColumn[]) {
  return {
    gridTemplateColumns: columns
      .map((column) =>
        column.id === 'name'
          ? `minmax(${column.width}px, 1fr)`
          : `${column.width}px`
      )
      .join(' '),
    minWidth: columns.reduce((sum, column) => sum + column.width, 0) + 24,
  }
}
