import {
  type ByteUnitSystem,
  DEFAULT_BYTE_UNIT_SYSTEM,
} from '@shared/schemas/byte-unit-system'

const UNITS = {
  decimal: ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'],
  binary: ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'],
} as const

export type ByteValue = number | bigint | string
export interface ByteFormatOptions {
  unitSystem?: ByteUnitSystem
  decimals?: 0 | 1 | 2
}
export interface FormattedByteParts {
  number: string
  unit: (typeof UNITS)[ByteUnitSystem][number]
}

function toByteCount(value: ByteValue): bigint {
  if (typeof value === 'bigint') return value > 0n ? value : 0n
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return 0n
    return BigInt(Math.floor(value))
  }
  if (!/^\d+$/.test(value)) return 0n
  return BigInt(value)
}

export function formatByteParts(
  bytes: ByteValue,
  {
    unitSystem = DEFAULT_BYTE_UNIT_SYSTEM,
    decimals = 2,
  }: ByteFormatOptions = {}
): FormattedByteParts {
  const value = toByteCount(bytes)
  const units = UNITS[unitSystem]
  const base = unitSystem === 'binary' ? 1024n : 1000n
  let unitIndex = 0
  let unitSize = 1n
  while (unitIndex < units.length - 1 && value >= unitSize * base) {
    unitIndex += 1
    unitSize *= base
  }
  if (unitIndex === 0) return { number: value.toString(), unit: 'B' }

  const scale = 10n ** BigInt(decimals)
  let rounded = (value * scale + unitSize / 2n) / unitSize
  // Promote after rounding as well: never display 1000.00 KB or 1024.00 KiB.
  if (rounded >= base * scale && unitIndex < units.length - 1) {
    unitIndex += 1
    unitSize *= base
    rounded = (value * scale + unitSize / 2n) / unitSize
  }
  const number =
    decimals === 0
      ? rounded.toString()
      : `${rounded / scale}.${(rounded % scale).toString().padStart(decimals, '0')}`
  return { number, unit: units[unitIndex] }
}

export function formatBytes(
  bytes: ByteValue,
  options?: ByteFormatOptions
): string {
  const parts = formatByteParts(bytes, options)
  return `${parts.number} ${parts.unit}`
}

export function formatSpeed(
  bytes: ByteValue,
  unitSystem = DEFAULT_BYTE_UNIT_SYSTEM
): string {
  return `${formatBytes(bytes, { unitSystem, decimals: 1 })}/s`
}
