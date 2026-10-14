import { z } from 'zod'

/** 检查任务对应文件是否存在所使用的参数定义 */
export const checkTaskFileExistsPayloadSchema = z.object({
  taskId: z.string().trim().min(1),
})

export type CheckTaskFileExistsPayload = z.infer<
  typeof checkTaskFileExistsPayloadSchema
>

/** 检查任务对应文件是否存在所返回的结果定义 */
export const checkTaskFileExistsResultSchema = z.object({
  exists: z.boolean(),
})

export type CheckTaskFileExistsResult = z.infer<
  typeof checkTaskFileExistsResultSchema
>
