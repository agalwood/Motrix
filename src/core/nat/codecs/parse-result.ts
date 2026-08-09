import type { ErrorCode } from '@shared/errors'

// Discriminated union for codec results. Codecs NEVER throw — they return ParseErr.
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode; detail?: string }

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value }
}

export function parseErr<T = never>(
  error: ErrorCode,
  detail?: string
): ParseResult<T> {
  return { ok: false, error, detail }
}
