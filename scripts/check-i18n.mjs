import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']
// i18next treats `_zero` as an exact-count override even for locales whose
// cardinal PluralRules categories do not contain `zero`.
const PLURAL_CATEGORY_EXTENSIONS = new Set(['zero'])
const PLURAL_SUFFIX = new RegExp(
  `_(?<category>${PLURAL_CATEGORIES.join('|')})$`
)
// Match i18next's escaped, unescaped (`{{- value}}`), and formatted
// (`{{value, format}}`) interpolation forms while comparing variable names.
const PLACEHOLDER = /\{\{\s*-?\s*([A-Za-z0-9_.-]+)(?:\s*,[^{}]*)?\s*\}\}/g

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')
const defaultCatalogModule = path.join(
  projectRoot,
  'src/shared/constants/locales.ts'
)
const defaultLocalesDirectory = path.join(projectRoot, 'src/shared/locales')

function isContainer(value) {
  return value !== null && typeof value === 'object'
}

function setDifference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)))
}

function sameSet(left, right) {
  return left.size === right.size && setDifference(left, right).size === 0
}

function formatValues(values) {
  const sorted = [...values].sort()
  return sorted.length === 0 ? '(none)' : sorted.join(', ')
}

function formatKeyList(keys, limit = 12) {
  const sorted = [...keys].sort()
  const visible = sorted.slice(0, limit).map((key) => `"${key}"`)
  const remaining = sorted.length - visible.length
  return remaining > 0
    ? `${visible.join(', ')} (and ${remaining} more)`
    : visible.join(', ')
}

/** Flatten every scalar JSON leaf into a dot-delimited key. */
export function flattenScalarKeys(value, prefix = '', output = new Map()) {
  if (isContainer(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPrefix = prefix ? `${prefix}.${key}` : key
      flattenScalarKeys(child, childPrefix, output)
    }
    return output
  }

  if (!prefix) {
    throw new Error('translation resource must contain a JSON object')
  }
  if (output.has(prefix)) {
    throw new Error(`duplicate flattened scalar key "${prefix}"`)
  }
  output.set(prefix, value)
  return output
}

export function extractPlaceholders(value) {
  if (typeof value !== 'string') return new Set()
  return new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]))
}

function normalizeCatalog(catalog, errors, catalogLabel) {
  if (!Array.isArray(catalog)) {
    errors.push(`${catalogLabel} must be an array of locale definitions.`)
    return []
  }

  const codes = []
  const seen = new Set()
  for (const [index, definition] of catalog.entries()) {
    const code = typeof definition === 'string' ? definition : definition?.code
    if (typeof code !== 'string' || code.length === 0) {
      errors.push(
        `${catalogLabel}[${index}] must provide a non-empty string code.`
      )
      continue
    }
    if (seen.has(code)) {
      errors.push(`${catalogLabel} contains duplicate locale "${code}".`)
      continue
    }
    seen.add(code)
    codes.push(code)
  }
  return codes
}

function buildLogicalFamilies(locale, scalarKeys, errors) {
  const families = new Map()

  for (const [flatKey, value] of scalarKeys) {
    if (typeof value !== 'string') {
      errors.push(
        `${locale}: translation key "${flatKey}" must be a string; ` +
          `received ${value === null ? 'null' : typeof value}.`
      )
    }
    const match = PLURAL_SUFFIX.exec(flatKey)
    const category = match?.groups?.category ?? null
    const logicalKey = category
      ? flatKey.slice(0, -(category.length + 1))
      : flatKey
    const family = families.get(logicalKey) ?? {
      logicalKey,
      base: null,
      variants: new Map(),
      placeholders: new Set(),
    }
    const member = {
      flatKey,
      value,
      placeholders: extractPlaceholders(value),
    }

    if (category) family.variants.set(category, member)
    else family.base = member
    families.set(logicalKey, family)
  }

  for (const family of families.values()) {
    if (family.base && family.variants.size > 0) {
      errors.push(
        `${locale}: logical key "${family.logicalKey}" mixes a base key ` +
          'with plural variants. Keep either the base key or plural suffixes.'
      )
    }

    const members = family.base
      ? [family.base, ...family.variants.values()]
      : [...family.variants.values()]
    const [reference, ...rest] = members
    if (!reference) continue
    family.placeholders = reference.placeholders

    for (const member of rest) {
      if (sameSet(reference.placeholders, member.placeholders)) continue
      errors.push(
        `${locale}: placeholder mismatch inside logical key ` +
          `"${family.logicalKey}"; "${reference.flatKey}" uses ` +
          `{${formatValues(reference.placeholders)}}, while ` +
          `"${member.flatKey}" uses {${formatValues(member.placeholders)}}.`
      )
    }
  }

  return families
}

function requiredPluralCategories(locale, errors) {
  try {
    const categories = new Intl.PluralRules(locale, {
      type: 'cardinal',
    }).resolvedOptions().pluralCategories
    return PLURAL_CATEGORIES.filter((category) => categories.includes(category))
  } catch (error) {
    errors.push(
      `${locale}: Intl.PluralRules rejected this locale code ` +
        `(${error instanceof Error ? error.message : String(error)}).`
    )
    return []
  }
}

function compareLogicalKeys(localeFamilies, referenceLocale, errors) {
  const reference = localeFamilies.get(referenceLocale)
  if (!reference) return 0
  const referenceKeys = new Set(reference.keys())

  for (const [locale, families] of localeFamilies) {
    if (locale === referenceLocale) continue
    const localeKeys = new Set(families.keys())
    const missing = setDifference(referenceKeys, localeKeys)
    const extra = setDifference(localeKeys, referenceKeys)
    if (missing.size === 0 && extra.size === 0) continue

    const details = []
    if (missing.size > 0) {
      details.push(`missing ${formatKeyList(missing)}`)
    }
    if (extra.size > 0) details.push(`extra ${formatKeyList(extra)}`)
    errors.push(
      `${locale}: logical translation keys differ from ${referenceLocale}: ` +
        `${details.join('; ')}.`
    )
  }

  return referenceKeys.size
}

function checkPluralFamilies(localeFamilies, errors) {
  for (const [locale, families] of localeFamilies) {
    const required = requiredPluralCategories(locale, errors)
    const allowed = new Set([...required, ...PLURAL_CATEGORY_EXTENSIONS])
    for (const family of families.values()) {
      if (family.variants.size === 0) continue
      const missing = required.filter(
        (category) => !family.variants.has(category)
      )
      if (missing.length > 0) {
        const keys = missing.map(
          (category) => `"${family.logicalKey}_${category}"`
        )
        errors.push(
          `${locale}: plural family "${family.logicalKey}" is missing ` +
            `required categories ${missing.join(', ')}. Add ${keys.join(', ')}.`
        )
      }

      const unsupported = [...family.variants.keys()].filter(
        (category) => !allowed.has(category)
      )
      if (unsupported.length > 0) {
        const keys = unsupported.map(
          (category) => `"${family.logicalKey}_${category}"`
        )
        errors.push(
          `${locale}: plural family "${family.logicalKey}" has unsupported ` +
            `categories ${unsupported.join(', ')} for this locale. Remove ` +
            `${keys.join(', ')}; only ${formatValues(allowed)} are valid.`
        )
      }
    }
  }
}

function compareFamilyShapesAndPlaceholders(
  localeFamilies,
  referenceLocale,
  errors
) {
  const reference = localeFamilies.get(referenceLocale)
  if (!reference) return

  for (const [locale, families] of localeFamilies) {
    if (locale === referenceLocale) continue
    for (const [logicalKey, referenceFamily] of reference) {
      const family = families.get(logicalKey)
      if (!family) continue

      const referenceIsPlural = referenceFamily.variants.size > 0
      const localeIsPlural = family.variants.size > 0
      if (referenceIsPlural !== localeIsPlural) {
        errors.push(
          `${locale}: logical key "${logicalKey}" must be ` +
            `${referenceIsPlural ? 'a plural family' : 'a scalar key'} ` +
            `to match ${referenceLocale}.`
        )
      }

      if (sameSet(referenceFamily.placeholders, family.placeholders)) continue
      const missing = setDifference(
        referenceFamily.placeholders,
        family.placeholders
      )
      const extra = setDifference(
        family.placeholders,
        referenceFamily.placeholders
      )
      const details = []
      if (missing.size > 0) {
        details.push(`missing ${formatValues(missing)}`)
      }
      if (extra.size > 0) details.push(`extra ${formatValues(extra)}`)
      errors.push(
        `${locale}: placeholders for logical key "${logicalKey}" differ ` +
          `from ${referenceLocale}: ${details.join('; ')}.`
      )
    }
  }
}

export async function checkI18n({
  catalog,
  fallbackLocale,
  localesDirectory,
  catalogLabel = 'SUPPORTED_LOCALES',
}) {
  const errors = []
  const localeCodes = normalizeCatalog(catalog, errors, catalogLabel)
  const catalogCodes = new Set(localeCodes)
  let localeFiles = []

  try {
    localeFiles = (await readdir(localesDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    errors.push(
      `Cannot read locale directory "${localesDirectory}": ` +
        `${error instanceof Error ? error.message : String(error)}.`
    )
    return {
      ok: false,
      errors,
      localeCodes,
      logicalKeyCount: 0,
    }
  }

  const fileCodes = new Set(
    localeFiles.map((filename) => filename.slice(0, -'.json'.length))
  )
  for (const code of localeCodes) {
    if (fileCodes.has(code)) continue
    errors.push(
      `${catalogLabel} locale "${code}" has no matching file ` +
        `"${path.join(localesDirectory, `${code}.json`)}".`
    )
  }
  for (const code of fileCodes) {
    if (catalogCodes.has(code)) continue
    errors.push(
      `Locale file "${code}.json" is not registered in ${catalogLabel}. ` +
        'Add it to the catalog or remove the file.'
    )
  }

  const localeFamilies = new Map()
  for (const locale of localeCodes) {
    if (!fileCodes.has(locale)) continue
    const filename = path.join(localesDirectory, `${locale}.json`)
    try {
      const parsed = JSON.parse(await readFile(filename, 'utf8'))
      if (!isContainer(parsed) || Array.isArray(parsed)) {
        errors.push(`${locale}: "${filename}" must contain a JSON object.`)
        continue
      }
      const scalarKeys = flattenScalarKeys(parsed)
      localeFamilies.set(
        locale,
        buildLogicalFamilies(locale, scalarKeys, errors)
      )
    } catch (error) {
      errors.push(
        `${locale}: cannot parse "${filename}": ` +
          `${error instanceof Error ? error.message : String(error)}.`
      )
    }
  }

  const preferredReference = fallbackLocale ?? localeCodes[0]
  if (preferredReference && !catalogCodes.has(preferredReference)) {
    errors.push(
      `Fallback locale "${preferredReference}" is not registered in ` +
        `${catalogLabel}.`
    )
  }
  const referenceLocale = localeFamilies.has(preferredReference)
    ? preferredReference
    : localeFamilies.keys().next().value
  const logicalKeyCount = referenceLocale
    ? compareLogicalKeys(localeFamilies, referenceLocale, errors)
    : 0

  checkPluralFamilies(localeFamilies, errors)
  if (referenceLocale) {
    compareFamilyShapesAndPlaceholders(localeFamilies, referenceLocale, errors)
  }

  return {
    ok: errors.length === 0,
    errors,
    localeCodes,
    logicalKeyCount,
  }
}

function parseCliOptions(argv) {
  const options = {
    catalogModule: defaultCatalogModule,
    localesDirectory: defaultLocalesDirectory,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`${argument} requires a path argument`)
    if (argument === '--catalog-module') {
      options.catalogModule = path.resolve(value)
    } else if (argument === '--locales-dir') {
      options.localesDirectory = path.resolve(value)
    } else {
      throw new Error(`unknown argument "${argument}"`)
    }
    index += 1
  }
  return options
}

export async function runCli(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseCliOptions(argv)
  } catch (error) {
    console.error(
      `check:i18n configuration error: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return 1
  }

  if (options.help) {
    console.log(
      'Usage: check-i18n [--catalog-module <path>] [--locales-dir <path>]'
    )
    return 0
  }

  let catalogModule
  try {
    catalogModule = await import(pathToFileURL(options.catalogModule).href)
  } catch (error) {
    console.error(
      `check:i18n could not import locale catalog ` +
        `"${options.catalogModule}": ${
          error instanceof Error ? error.message : String(error)
        }`
    )
    return 1
  }

  const result = await checkI18n({
    catalog: catalogModule.SUPPORTED_LOCALES,
    fallbackLocale: catalogModule.FALLBACK_LOCALE,
    localesDirectory: options.localesDirectory,
  })
  if (!result.ok) {
    console.error(
      `check:i18n failed with ${result.errors.length} error(s):\n` +
        result.errors.map((error) => `- ${error}`).join('\n')
    )
    return 1
  }

  console.log(
    `check:i18n passed: ${result.localeCodes.length} locales, ` +
      `${result.logicalKeyCount} logical translation keys.`
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = await runCli()
}
