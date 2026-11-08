import { z } from 'zod'

/** Payload of plural task-id commands, including Commands.RetryTasks. */
export const taskIdsPayloadSchema = z.array(z.string().min(1)).min(1)

/** Older clients send only the ID. An explicit digest is scoped to one retry. */
export const reAddTaskPayloadSchema = z.union([
  z
    .string()
    .min(1)
    .transform((taskId) => ({ taskId, sha256: undefined })),
  z
    .object({
      taskId: z.string().min(1),
      sha256: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{64}$/i)
        .toLowerCase(),
    })
    .strict(),
])

/** Payload of Commands.RemoveTasks. */
export const removeTasksPayloadSchema = z.object({
  taskIds: taskIdsPayloadSchema,
  deleteWithFiles: z.boolean(),
})

export type RemoveTasksPayload = z.infer<typeof removeTasksPayloadSchema>
