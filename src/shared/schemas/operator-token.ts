import { z } from 'zod'

// Storage and transport bounds only; strength never determines acceptance.
export const operatorTokenSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value))

export const changeOperatorTokenSchema = z
  .object({ currentToken: z.string().max(4096), newToken: operatorTokenSchema })
  .strict()

export const changeOperatorTokenResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'invalid',
      'incorrectToken',
      'managed',
      'unavailable',
      'rateLimited',
    ]),
  }),
])

export type ChangeOperatorTokenResult = z.infer<
  typeof changeOperatorTokenResultSchema
>

/** A deliberately modest hint, not a strength score or an acceptance rule. */
export function isWeakOperatorToken(value: string): boolean {
  const token = value.trim().toLowerCase()
  return (
    [...token].length < 12 ||
    /^\d+$/.test(token) ||
    /^(.{1,4})\1+$/u.test(token) ||
    /^(password|qwerty|admin|letmein|motrix)[\d!@#$%^&*._-]*$/.test(token)
  )
}
