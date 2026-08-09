import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import type { z } from 'zod/v4'

/** Exported separately for testing without React Router context. */
export function parseSearchParams<T extends z.ZodType>(
  searchParams: URLSearchParams,
  schema: T
): z.infer<T> {
  const raw: Record<string, string> = {}
  for (const [key, value] of searchParams.entries()) {
    raw[key] = value
  }
  return schema.parse(raw) as z.infer<T>
}

/** Invalid or missing params silently fall back to schema defaults. */
export function useTypedSearchParams<T extends z.ZodType>(schema: T) {
  const [searchParams, setSearchParams] = useSearchParams()

  const parsed = parseSearchParams(searchParams, schema)

  const update = useCallback(
    (partial: Partial<z.infer<T>>) => {
      setSearchParams((prev) => {
        for (const [k, v] of Object.entries(
          partial as Record<string, unknown>
        )) {
          if (v == null || v === '') {
            prev.delete(k)
          } else {
            prev.set(k, String(v))
          }
        }
        return prev
      })
    },
    [setSearchParams]
  )

  return [parsed, update] as const
}
