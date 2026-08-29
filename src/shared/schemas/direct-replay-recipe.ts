import { z } from 'zod'

/**
 * Request-shape facts that explain why a direct download cannot be replayed
 * from its persisted URI alone. Values are deliberately never part of this
 * schema: credentials and per-task engine options stay out of motrix.db.
 */
export const directReplayRequestModifierSchema = z.enum([
  'headers',
  'proxy',
  'extraEngineOptions',
  'engineGlobalOptions',
])

const validatorValueSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\r\n]/.test(value), 'validator contains CR/LF')

export const directResourceValidatorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('strong-etag'),
      value: validatorValueSchema.refine(
        (value) =>
          !value.startsWith('W/') &&
          value.startsWith('"') &&
          value.endsWith('"'),
        'strong ETag must be quoted and must not use W/'
      ),
      contentLength: z.number().int().nonnegative().optional(),
      capturedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('last-modified'),
      value: validatorValueSchema.refine(
        (value) => Number.isFinite(Date.parse(value)),
        'Last-Modified must be a valid HTTP date'
      ),
      contentLength: z.number().int().nonnegative(),
      capturedAt: z.number().int().nonnegative(),
    })
    .strict(),
])

const directReplayV1Schema = z
  .object({
    version: z.literal(1),
    connections: z.number().int().min(1).max(128).optional(),
    requestModifiers: z.array(directReplayRequestModifierSchema).max(4),
    replayability: z.enum(['uri-only', 'requires-credentials']),
    resourceValidator: directResourceValidatorSchema.optional(),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const uniqueModifiers = new Set(recipe.requestModifiers)
    if (uniqueModifiers.size !== recipe.requestModifiers.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'requestModifiers must not contain duplicates',
        path: ['requestModifiers'],
      })
    }

    const expectedReplayability =
      recipe.requestModifiers.length === 0 ? 'uri-only' : 'requires-credentials'
    if (recipe.replayability !== expectedReplayability) {
      ctx.addIssue({
        code: 'custom',
        message: 'replayability does not match requestModifiers',
        path: ['replayability'],
      })
    }
  })

export const directReplayRecipeSchema = directReplayV1Schema

export type DirectReplayRequestModifier = z.infer<
  typeof directReplayRequestModifierSchema
>
export type DirectResourceValidator = z.infer<
  typeof directResourceValidatorSchema
>
export type DirectReplayRecipe = z.infer<typeof directReplayRecipeSchema>

/**
 * Read a versioned recipe from a task-instance payload. Unknown versions,
 * malformed objects, and internally inconsistent claims are all treated as
 * non-replayable rather than being partially coerced.
 */
export function parseDirectReplayRecipe(
  payload: Record<string, unknown> | null | undefined
): DirectReplayRecipe | null {
  if (!payload) return null
  const parsed = directReplayRecipeSchema.safeParse(payload.directReplay)
  return parsed.success ? parsed.data : null
}

/** True only when the persisted recipe proves URI-only replay is equivalent. */
export function isUriOnlyDirectReplay(
  payload: Record<string, unknown> | null | undefined
): boolean {
  return parseDirectReplayRecipe(payload)?.replayability === 'uri-only'
}
