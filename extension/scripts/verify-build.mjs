import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { init, parse } from 'es-module-lexer'

await init()

const SUPPORTED_VARIANTS = new Set([
  'chromium',
  'firefox',
  'webstore',
  'safari',
])
const GENERIC_IIFE_SCRIPTS = [
  'src/content/sniffer-relay.js',
  'src/content/sniffer-entry.js',
]
const YOUTUBE_IIFE_SCRIPT = 'src/content/youtube-sniffer-entry.js'
const OS_METADATA = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

function collectFiles(directory) {
  const files = []
  const visit = (currentDirectory) => {
    for (const name of readdirSync(currentDirectory)) {
      const path = join(currentDirectory, name)
      if (statSync(path).isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(directory)
  return files
}

function collectManifestReferences(manifest) {
  const references = new Map()
  const add = (value, origin) => {
    if (typeof value !== 'string' || value.length === 0) return
    const origins = references.get(value) ?? []
    origins.push(origin)
    references.set(value, origins)
  }
  const addValues = (record, origin) => {
    if (!record || typeof record !== 'object') return
    for (const value of Object.values(record)) add(value, origin)
  }

  addValues(manifest.icons, 'icons')
  for (const key of ['action', 'browser_action', 'page_action']) {
    const action = manifest[key]
    if (!action) continue
    add(action.default_popup, `${key}.default_popup`)
    addValues(action.default_icon, `${key}.default_icon`)
  }
  add(manifest.options_page, 'options_page')
  add(manifest.options_ui?.page, 'options_ui.page')
  add(manifest.devtools_page, 'devtools_page')
  add(manifest.side_panel?.default_path, 'side_panel.default_path')
  add(manifest.background?.service_worker, 'background.service_worker')
  for (const file of manifest.background?.scripts ?? []) {
    add(file, 'background.scripts')
  }
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const file of contentScript.js ?? []) add(file, 'content_scripts.js')
    for (const file of contentScript.css ?? []) add(file, 'content_scripts.css')
  }
  for (const resourceGroup of manifest.web_accessible_resources ?? []) {
    for (const file of resourceGroup.resources ?? []) {
      add(file, 'web_accessible_resources.resources')
    }
  }
  addValues(manifest.chrome_url_overrides, 'chrome_url_overrides')
  for (const file of manifest.sandbox?.pages ?? []) add(file, 'sandbox.pages')

  return references
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('**', '*').replaceAll('*', '.*')}$`)
}

function verifyManifestReferences(outputPath, relativeFiles, references) {
  for (const [reference, origins] of references) {
    const normalized = reference.replaceAll('\\', '/').replace(/^\/+/, '')
    if (
      normalized.split('/').includes('..') ||
      /^[a-z][a-z\d+.-]*:/i.test(normalized)
    ) {
      throw new Error(
        `Manifest has an invalid local reference (${origins.join(', ')}): ${reference}`
      )
    }
    const found = normalized.includes('*')
      ? relativeFiles.some((file) => globToRegExp(normalized).test(file))
      : existsSync(join(outputPath, ...normalized.split('/')))
    if (!found) {
      throw new Error(
        `Manifest reference is missing (${origins.join(', ')}): ${reference}`
      )
    }
  }
}

function verifyManifestLocales(outputPath, manifest) {
  const defaultLocale = manifest.default_locale
  if (typeof defaultLocale !== 'string' || defaultLocale.length === 0) {
    throw new Error('Build manifest is missing default_locale')
  }

  const localesPath = join(outputPath, '_locales')
  if (!existsSync(localesPath)) {
    throw new Error('Build output is missing _locales')
  }

  const locales = readdirSync(localesPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (!locales.includes(defaultLocale)) {
    throw new Error(`Build output is missing default locale: ${defaultLocale}`)
  }

  const messageKeys = new Set(
    [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)]
      .map((match) => match[1])
      .filter(Boolean)
  )
  if (messageKeys.size === 0) {
    throw new Error('Build manifest contains no localized message references')
  }

  for (const locale of locales) {
    const messagesPath = join(localesPath, locale, 'messages.json')
    if (!existsSync(messagesPath)) {
      throw new Error(`Build locale is missing messages.json: ${locale}`)
    }
    const messages = JSON.parse(readFileSync(messagesPath, 'utf8'))
    for (const key of messageKeys) {
      const message = messages[key]?.message
      if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error(`Build locale is missing message ${key}: ${locale}`)
      }
    }
  }

  return locales.length
}

export function findModuleSyntax(source, fileName) {
  const [imports, exports] = parse(source, fileName)
  const violations = []
  const addViolation = (offset, label) => {
    const prefix = source.slice(0, offset)
    const line = prefix.split('\n').length
    const character = offset - prefix.lastIndexOf('\n')
    violations.push(`${label} at ${line}:${character}`)
  }

  for (const imported of imports) {
    const label =
      imported.type === 'import-meta'
        ? 'import.meta'
        : imported.type === 'dynamic'
          ? 'dynamic import'
          : 'static import'
    addViolation(imported.importStart, label)
  }
  for (const exported of exports) addViolation(exported.exportStart, 'export')
  return violations
}

function verifyIifeScript(outputPath, scriptPath, expectSourceMap) {
  const absolutePath = join(outputPath, ...scriptPath.split('/'))
  if (!existsSync(absolutePath)) {
    throw new Error(`Expected IIFE content script is missing: ${scriptPath}`)
  }
  const source = readFileSync(absolutePath, 'utf8')
  try {
    new Script(source, { filename: scriptPath })
  } catch (error) {
    throw new Error(
      `Content script is not valid classic JavaScript: ${scriptPath}`,
      {
        cause: error,
      }
    )
  }
  const violations = findModuleSyntax(source, scriptPath)
  if (violations.length > 0) {
    throw new Error(
      `IIFE content script contains module syntax: ${scriptPath} (${violations.join('; ')})`
    )
  }
  const sourceMapPath = `${absolutePath}.map`
  if (expectSourceMap && !existsSync(sourceMapPath)) {
    throw new Error(
      `Debug build is missing an IIFE source map: ${scriptPath}.map`
    )
  }
  if (!expectSourceMap && /[#@]\s*sourceMappingURL=/.test(source)) {
    throw new Error(`Release IIFE refers to a source map: ${scriptPath}`)
  }
}

function verifyYouTubeExclusions(variant, manifest, files, outputPath) {
  const manifestText = JSON.stringify(manifest)
  if (/youtube\.com|youtu\.be/i.test(manifestText)) {
    throw new Error(`${variant} manifest still declares a YouTube host`)
  }
  const forbiddenFile = files.find((path) =>
    /youtube-sniffer/i.test(relative(outputPath, path))
  )
  if (forbiddenFile) {
    throw new Error(
      `${variant} output contains a YouTube sniffer: ${relative(outputPath, forbiddenFile)}`
    )
  }
  for (const path of files) {
    if (!/\.(?:js|json|map)$/.test(path)) continue
    const source = readFileSync(path, 'utf8')
    if (
      /googlevideo\.com\/videoplayback|youtube-v01-not-yet-implemented/i.test(
        source
      )
    ) {
      throw new Error(
        `${variant} output contains executable YouTube capability: ${relative(outputPath, path)}`
      )
    }
  }
}

function verifyDynamicCodeAbsence(files, outputPath) {
  const forbidden = [
    {
      pattern: /(^|[^\w$.])eval\s*\(/,
      label: 'eval call',
    },
    {
      pattern: /(^|[^\w$.])Function\s*\(/,
      label: 'Function constructor',
    },
    {
      pattern:
        /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Function\s*(?:[;,]|$)/m,
      label: 'aliased Function constructor',
    },
  ]

  for (const path of files) {
    if (!path.endsWith('.js')) continue
    const source = readFileSync(path, 'utf8')
    const match = forbidden.find(({ pattern }) => pattern.test(source))
    if (match) {
      throw new Error(
        `Build output contains a ${match.label}: ${relative(outputPath, path)}`
      )
    }
  }
}

export function verifySafariManifest(manifest) {
  for (const permission of ['downloads', 'notifications', 'nativeMessaging']) {
    if (manifest.permissions?.includes(permission)) {
      throw new Error(
        `Safari preview requests unavailable permission: ${permission}`
      )
    }
  }
  if (manifest.minimum_chrome_version || manifest.browser_specific_settings) {
    throw new Error("Safari manifest contains another browser's settings")
  }
  if (
    manifest.web_accessible_resources?.some(
      (resource) => 'use_dynamic_url' in resource
    )
  ) {
    throw new Error('Safari manifest contains Chromium dynamic resource URLs')
  }
  if (
    manifest.background?.service_worker ||
    manifest.background?.scripts?.length !== 1 ||
    manifest.background.type !== 'module' ||
    manifest.background.persistent !== false
  ) {
    throw new Error(
      'Safari build requires a nonpersistent module background page'
    )
  }
}

export function verifyBuild(variant) {
  const release =
    variant === 'webstore' ||
    (variant === 'safari' && process.env.MOTRIX_SAFARI_RELEASE === '1')
  if (!SUPPORTED_VARIANTS.has(variant)) {
    throw new Error(
      `Expected a build variant (${[...SUPPORTED_VARIANTS].join(', ')}), received: ${variant ?? '<none>'}`
    )
  }

  const outputPath = fileURLToPath(
    new URL(`../dist/${variant}/`, import.meta.url)
  )
  if (!existsSync(outputPath)) {
    throw new Error(`Build output is missing: ${outputPath}`)
  }

  const manifestPath = join(outputPath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`Build manifest is missing: ${manifestPath}`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (variant === 'safari') verifySafariManifest(manifest)
  const files = collectFiles(outputPath)
  const relativeFiles = files.map((path) =>
    relative(outputPath, path).split(sep).join('/')
  )

  const metadataFile = relativeFiles.find((path) =>
    OS_METADATA.has(path.split('/').at(-1))
  )
  if (metadataFile) {
    throw new Error(`Build output contains OS metadata: ${metadataFile}`)
  }

  const references = collectManifestReferences(manifest)
  verifyManifestReferences(outputPath, relativeFiles, references)
  const localeCount = verifyManifestLocales(outputPath, manifest)
  verifyDynamicCodeAbsence(files, outputPath)

  const expectedIifeScripts = [...GENERIC_IIFE_SCRIPTS]
  if (variant === 'chromium') expectedIifeScripts.push(YOUTUBE_IIFE_SCRIPT)
  const referencedFiles = new Set(references.keys())
  for (const scriptPath of expectedIifeScripts) {
    if (!referencedFiles.has(scriptPath)) {
      throw new Error(
        `IIFE content script is not referenced by the manifest: ${scriptPath}`
      )
    }
    verifyIifeScript(outputPath, scriptPath, !release)
  }

  const sourceMapFiles = relativeFiles.filter((path) => path.endsWith('.map'))
  if (release) {
    if (sourceMapFiles.length > 0) {
      throw new Error(
        `${variant} release output contains source maps: ${sourceMapFiles.join(', ')}`
      )
    }
    const sourceMapReference = files.find(
      (path) =>
        /\.(?:css|js)$/.test(path) &&
        /[#@]\s*sourceMappingURL=/.test(readFileSync(path, 'utf8'))
    )
    if (sourceMapReference) {
      throw new Error(
        `${variant} release output refers to a source map: ${relative(outputPath, sourceMapReference)}`
      )
    }
    verifyYouTubeExclusions(variant, manifest, files, outputPath)
  } else {
    if (sourceMapFiles.length === 0) {
      throw new Error(`${variant} debug build contains no source maps`)
    }
    if (variant === 'firefox' || variant === 'safari') {
      verifyYouTubeExclusions(variant, manifest, files, outputPath)
    } else if (!JSON.stringify(manifest).includes('youtube.com')) {
      throw new Error(`${variant} full build is missing the YouTube capability`)
    }
  }

  console.log(
    `Verified ${variant} artifact: ${files.length} files, ${references.size} manifest references, ${localeCount} locales, ${expectedIifeScripts.length} self-contained IIFE content scripts`
  )
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyBuild(process.argv[2])
}
