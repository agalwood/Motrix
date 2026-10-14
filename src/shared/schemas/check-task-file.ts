import { z } from 'zod'

/** Request to check whether a task's output file exists. */
export const checkTaskFileExistsPayloadSchema = z.object({
  taskId: z.string().trim().min(1),
})

export type CheckTaskFileExistsPayload = z.infer<
  typeof checkTaskFileExistsPayloadSchema
>

/** Result of checking whether a task's output file exists. */
export const checkTaskFileExistsResultSchema = z.object({
  exists: z.boolean(),
})

export type CheckTaskFileExistsResult = z.infer<
  typeof checkTaskFileExistsResultSchema
>
