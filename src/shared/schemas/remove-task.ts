import { z } from 'zod'

export const removeTaskPayloadSchema = z.object({
  taskId: z.string().min(1),
  deleteWithFiles: z.boolean(),
})

export type RemoveTaskPayload = z.infer<typeof removeTaskPayloadSchema>
