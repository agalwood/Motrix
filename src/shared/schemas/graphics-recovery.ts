import { z } from 'zod'

export const graphicsRecoveryNoticeSchema = z.object({
  id: z.uuid(),
})

export type GraphicsRecoveryNotice = z.infer<
  typeof graphicsRecoveryNoticeSchema
>
