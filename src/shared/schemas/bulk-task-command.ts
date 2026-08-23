import { z } from 'zod'

/** Payload of plural task-id commands, including Commands.RetryTasks. */
export const taskIdsPayloadSchema = z.array(z.string().min(1)).min(1)

/** Payload of Commands.RemoveTasks. */
export const removeTasksPayloadSchema = z.object({
  taskIds: taskIdsPayloadSchema,
  deleteWithFiles: z.boolean(),
})

export type RemoveTasksPayload = z.infer<typeof removeTasksPayloadSchema>
