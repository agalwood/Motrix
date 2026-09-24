import { z } from 'zod'

export const moveTasksPayloadSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(1000),
  direction: z.enum(['up', 'down', 'top', 'bottom']),
})
export type MoveTasksPayload = z.infer<typeof moveTasksPayloadSchema>

export const moveTasksResultSchema = z.object({
  moved: z.array(z.string()),
  unchanged: z.array(z.string()),
  failed: z.array(z.object({ taskId: z.string(), reason: z.string() })),
})
export type MoveTasksResult = z.infer<typeof moveTasksResultSchema>
