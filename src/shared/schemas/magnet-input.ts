import { z } from 'zod'

// BEP 9 permits a 160-bit btih encoded as 40 hex or 32 Base32 characters.
const bareInfoHashSchema = z
  .string()
  .trim()
  .pipe(
    z.union([
      z
        .string()
        .regex(/^[0-9a-f]{40}$/i)
        .toLowerCase(),
      z
        .string()
        .regex(/^[a-z2-7]{32}$/i)
        .toUpperCase(),
    ])
  )

/** Only complete bare hashes are expanded; URLs and surrounding prose are untouched. */
export function infoHashToMagnetUri(input: string): string | null {
  const result = bareInfoHashSchema.safeParse(input)
  return result.success ? `magnet:?xt=urn:btih:${result.data}` : null
}

/** Preserve line order, blank lines, and unrecognized input for inline editing. */
export function normalizeMagnetInputLines(input: string): string {
  return input
    .split('\n')
    .map((line) => infoHashToMagnetUri(line) ?? line)
    .join('\n')
}
