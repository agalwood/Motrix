import { z } from 'zod'

export const openTaskFilePayloadSchema = z.object({
  taskId: z.string().trim().min(1),
})
