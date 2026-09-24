import type { TFunction } from 'i18next'
import { z } from 'zod'

export function settingsFieldSchema(
  schema: z.ZodType,
  path: readonly PropertyKey[]
): z.ZodType | undefined {
  let field: z.ZodType | undefined = schema
  for (const key of path) {
    if (field instanceof z.ZodObject) field = field.shape[String(key)]
    else if (field instanceof z.ZodArray) field = field.element as z.ZodType
    else return undefined
  }
  return field
}

export interface SettingsValidationOptions {
  scales?: Record<string, number>
  displayRanges?: Record<string, { min: number; max: number; integer: boolean }>
}

export function settingsValidationError(
  t: TFunction,
  schema: z.ZodType,
  options: SettingsValidationOptions = {}
): z.core.$ZodErrorMap {
  return (issue) => {
    if (
      issue.code === 'custom' &&
      typeof issue.params?.settingIssue === 'string'
    ) {
      return t(`settings.validation.${issue.params.settingIssue}`)
    }
    const path = issue.path ?? []
    const name = path.join('.')
    const field = settingsFieldSchema(schema, path)
    const scale = options.scales?.[name] ?? 1
    const range = options.displayRanges?.[name]
    if (field instanceof z.ZodNumber) {
      const min =
        range?.min ?? (field.minValue == null ? null : field.minValue / scale)
      const max =
        range?.max ?? (field.maxValue == null ? null : field.maxValue / scale)
      const integer = range?.integer ?? (field.isInt && scale === 1)
      if (issue.code === 'invalid_type' && issue.expected !== 'int') {
        return t('settings.validation.number')
      }
      if (
        issue.code === 'invalid_type' &&
        issue.expected === 'int' &&
        scale !== 1
      )
        return t('settings.validation.wholeBytes')
      if (
        min != null &&
        max != null &&
        (range != null || field.maxValue !== Number.MAX_SAFE_INTEGER)
      ) {
        return t(
          integer
            ? 'settings.validation.integerRange'
            : 'settings.validation.range',
          { min, max }
        )
      }
      if (issue.code === 'invalid_type' && issue.expected === 'int') {
        return t(
          scale === 1
            ? 'settings.validation.integer'
            : 'settings.validation.wholeBytes'
        )
      }
      if (issue.code === 'too_small')
        return t('settings.validation.minimum', { min })
      if (issue.code === 'too_big')
        return t('settings.validation.maximum', { max })
    }
    if (issue.code === 'too_big') {
      return t(
        issue.origin === 'array'
          ? 'settings.validation.itemCount'
          : 'settings.validation.textLength',
        { max: issue.maximum }
      )
    }
    if (
      issue.code === 'invalid_value' ||
      (issue.code === 'invalid_type' && issue.expected === 'boolean')
    ) {
      return t('settings.validation.selection')
    }
    if (issue.code === 'invalid_format' && issue.format === 'url')
      return t('settings.validation.httpUrl')
    if (
      issue.code === 'invalid_format' &&
      name.startsWith('speedLimit.auto.schedule.')
    )
      return t('settings.validation.time')
    if (issue.code === 'custom') return t('settings.validation.text')
    return t('settings.validation.invalid')
  }
}
