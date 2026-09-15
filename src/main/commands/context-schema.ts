import { TaskStatus } from '@shared/types/task'
import { z } from 'zod'

export const MenuContextPatchSchema = z.object({
  selectedTaskIds: z.array(z.string().min(1)).optional(),
  selectedTaskGeneration: z.number().int().nonnegative().optional(),
  selectedCanPause: z.boolean().optional(),
  selectedCanResume: z.boolean().optional(),
  selectedCanRemove: z.boolean().optional(),
  selectedCanMove: z.boolean().optional(),
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
