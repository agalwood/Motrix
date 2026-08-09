/**
 * Malformed or shape-violating JSON degrades to `null` rather than throwing —
 * the repo's validate-on-read convention for `error_detail_params` /
 * `errorDetailParams` columns. Shared by `MotrixDatabase` and
 * `TaskInspectorActivityStore`, which previously carried byte-identical
 * copies of this function.
 */
export function parseDetailParams(
  raw: string | null
): Record<string, string> | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'string') return null
    }
    return parsed as Record<string, string>
  } catch {
    return null
  }
}
