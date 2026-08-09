/**
 * Conversions between better-sqlite3 `safeIntegers()` rows and JavaScript
 * numbers, shared by the SQLite-backed stores.
 */

export function safeIntegerFromSql(value: unknown, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${label} exceeds the JavaScript safe integer range`)
    }
    return value
  }
  if (typeof value !== 'bigint') {
    throw new RangeError(`${label} is not an integer`)
  }
  if (
    value < BigInt(Number.MIN_SAFE_INTEGER) ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError(`${label} exceeds the JavaScript safe integer range`)
  }
  return Number(value)
}

export function nonNegativeIntegerFromBigInt(
  value: bigint,
  label: string
): number {
  const converted = safeIntegerFromSql(value, label)
  if (converted < 0) {
    throw new RangeError(`${label} must be non-negative`)
  }
  return converted
}

export function requireSafeTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer timestamp`)
  }
}

export function requireSafePositiveTimestamp(
  value: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer timestamp`)
  }
}
