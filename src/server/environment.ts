export function parseServerBoolean(
  value: string | undefined,
  name: string,
  fallback = false
): boolean {
  if (value === undefined || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new Error(`${name} must be true, false, 1, or 0`)
}

export function parseServerPort(
  value: string | undefined,
  name: string,
  fallback: number,
  options: { allowZero?: boolean } = {}
): number {
  if (value === undefined || value.trim() === '') return fallback
  const port = Number(value)
  const minimum = options.allowZero ? 0 : 1
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${name} must be an integer between ${minimum} and 65535`)
  }
  return port
}
