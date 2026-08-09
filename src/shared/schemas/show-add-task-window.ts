import { z } from 'zod'
import type { addTaskFormSchema } from './add-task'

/**
 * Optional payload for Commands.ShowAddTaskWindow. When `prefill`
 * is provided, the main process will forward it to the new window
 * via Events.SetAddTaskMode after did-finish-load.
 *
 * The form schema is a discriminated union; `partial()` requires
 * a single shape, so we use a permissive z.record here. The
 * receiving side validates again via setAddTaskModeEventPayloadSchema.
 */
export const showAddTaskWindowSchema = z
  .object({
    prefill: z.record(z.string(), z.unknown()).optional(),
  })
  .default({})

export type ShowAddTaskWindowPayload = z.infer<typeof showAddTaskWindowSchema>

// Re-exported for renderer-side type ergonomics — keeps
// `openAddTaskDialog(prefill)` strongly typed without forcing
// every caller to import addTaskFormSchema.
export type AddTaskPrefill = Partial<z.infer<typeof addTaskFormSchema>>
