import { isIP } from 'node:net'
import { z } from 'zod'

export const dsmText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^\P{Cc}*$/u)
export const dsmUsername = dsmText(128)
  .min(1)
  .regex(/^(?!-)(?!.*[\s:[\]\\/]).+$/u)
export const validDsmUsername = (name: string): boolean =>
  dsmUsername.safeParse(name).success
export const dsmContextSchema = z.object({
  cookie: dsmText(8192).min(1),
  remoteAddress: z.string().refine((s) => isIP(s) !== 0),
  serverAddress: z.string().refine((s) => isIP(s) !== 0),
  serverPort: z.coerce.number().int().min(1).max(65535),
  scheme: z.enum(['http', 'https']),
  host: dsmText(512).optional(),
  userAgent: dsmText(2048).optional(),
})
export type DsmContext = z.infer<typeof dsmContextSchema>
