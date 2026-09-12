import { z } from 'zod'

/** Reuse persisted field constraints without silently recovering invalid input. */
export function settingsInputObject<
  Shape extends Record<string, z.ZodCatch<z.ZodType>>,
>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      field.removeCatch(),
    ])
  ) as { [Key in keyof Shape]: ReturnType<Shape[Key]['removeCatch']> }
  return z.object(shape)
}
