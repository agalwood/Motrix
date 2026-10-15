import { zodResolver } from '@hookform/resolvers/zod'
import type { FieldValues, Resolver } from 'react-hook-form'
import type { ZodType } from 'zod'

/**
 * @hookform/resolvers resolves its Zod v4 declarations through pnpm's hoisted
 * Zod 3 compatibility package, while this application uses Zod 4.4. Runtime
 * support is compatible, so keep the type adaptation in one boundary.
 */
const compatibleZodResolver = zodResolver as unknown as <
  TFieldValues extends FieldValues,
>(
  schema: ZodType<TFieldValues>
) => Resolver<TFieldValues>

export function zodFormResolver<TFieldValues extends FieldValues>(
  schema: ZodType<TFieldValues>
): Resolver<TFieldValues> {
  return compatibleZodResolver(schema)
}
