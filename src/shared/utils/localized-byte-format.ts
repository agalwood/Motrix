import type { ByteUnitSystem } from '@shared/schemas/byte-unit-system'
import type { TFunction } from 'i18next'
import {
  type ByteFormatOptions,
  type ByteValue,
  type FormattedByteParts,
  formatByteParts,
} from './format-bytes'

type ByteUnit = FormattedByteParts['unit']

/** Localize presentation only; unit selection and rounding stay byte-exact. */
export function createLocalizedByteFormatter(
  unitSystem: ByteUnitSystem,
  locale: string,
  t: TFunction
) {
  const integers = new Intl.NumberFormat(locale, { useGrouping: false })
  const separator =
    integers.formatToParts(1.1).find((part) => part.type === 'decimal')
      ?.value ?? '.'
  const digits = Array.from({ length: 10 }, (_, digit) =>
    integers.format(digit)
  )
  const localizeNumber = (number: string) => {
    const [integer, fraction] = number.split('.')
    const whole = integers.format(BigInt(integer))
    return fraction === undefined
      ? whole
      : `${whole}${separator}${fraction.replace(/\d/g, (digit) => digits[Number(digit)])}`
  }
  const perSecond = (value: string) => t('units.perSecond', { value })
  const formatByteUnit = (unit: ByteUnit, speed = false) => {
    const label = t(`units.bytes.${unit.toLowerCase()}`)
    return speed ? perSecond(label) : label
  }
  const formatByteQuantity = (number: string | number, unit: ByteUnit) =>
    `${localizeNumber(String(number))} ${formatByteUnit(unit)}`
  const formatBytes = (bytes: ByteValue, options?: ByteFormatOptions) => {
    const parts = formatByteParts(bytes, { unitSystem, ...options })
    return formatByteQuantity(parts.number, parts.unit)
  }
  const formatSpeed = (bytes: ByteValue) =>
    perSecond(formatBytes(bytes, { decimals: 1 }))
  const formatSpeedLimit = (bytes: ByteValue) => {
    const parts = formatByteParts(bytes, { unitSystem, decimals: 1 })
    return perSecond(
      formatByteQuantity(parts.number.replace(/\.0$/, ''), parts.unit)
    )
  }
  return {
    unitSystem,
    formatBytes,
    formatSpeed,
    formatSpeedLimit,
    formatByteUnit,
    formatByteQuantity,
  }
}
