import { TaskStatus } from '@shared/types/task'
import { z } from 'zod'

export const MenuContextPatchSchema = z.object({
  selectedTaskId: z.string().nullable().optional(),
  selectedTaskStatus: z.enum(TaskStatus).nullable().optional(),
  selectedTaskAtTop: z.boolean().optional(),
  selectedTaskAtBottom: z.boolean().optional(),
  hasAnyActiveTask: z.boolean().optional(),
  hasAnyPausedTask: z.boolean().optional(),
  hasStoppedTasks: z.boolean().optional(),
  currentRoute: z.string().optional(),
})

export type MenuContextPatch = z.infer<typeof MenuContextPatchSchema>
