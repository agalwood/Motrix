#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_PROJECT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '..')
const DEFAULT_CONFIG_FILE = path.join(
  DEFAULT_PROJECT_DIR,
  'scripts/third-party-notices.config.json'
)
const DEFAULT_OUTPUT_DIR = path.join(DEFAULT_PROJECT_DIR, 'build/legal')
const NOTICE_FILES = ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.zh-CN.md']
const LICENSE_FILE_PATTERN =
  /^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function isRegularFile(filePath) {
  const info = await stat(filePath).catch(() => null)
  return info?.isFile() === true
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

async function resolveInstalledPackage(fromDirectory, packageName, projectDir) {
  let current = path.resolve(fromDirectory)
  const boundary = path.resolve(projectDir)

  while (isWithin(boundary, current)) {
    const manifest = path.join(
      current,
      'node_modules',
      packageName,
      'package.json'
    )
    if (await isRegularFile(manifest)) return manifest
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function readPackageLicenseFiles(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true })
  const names = entries
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))

  return Promise.all(
    names.map(async (name) => ({
      label: name,
      text: await readLicenseText(path.join(packageDirectory, name)),
    }))
  )
}

async function readLicenseText(filePath) {
  const bytes = await readFile(filePath)
  if (bytes.includes(0)) {
    throw new Error(`license file is not plain text: ${filePath}`)
  }
  return bytes.toString('utf8').replace(/\r\n/g, '\n').trimEnd()
}

async function readConfiguredLicenseFiles({
  files,
  baseDirectory,
  labelPrefix,
}) {
  return Promise.all(
    files.map(async (relativePath) => {
      const resolved = path.resolve(baseDirectory, relativePath)
      if (!isWithin(baseDirectory, resolved)) {
        throw new Error(
          `license path escapes its package/root: ${relativePath}`
        )
      }
      if (!(await isRegularFile(resolved))) {
        throw new Error(`configured license file is missing: ${resolved}`)
      }
      return {
        label: `${labelPrefix}${relativePath}`,
        text: await readLicenseText(resolved),
      }
    })
  )
}

function repositoryUrl(manifest) {
  const repository =
    typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url
  if (typeof repository !== 'string') return manifest.homepage ?? null
  const normalized = repository
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^git:\/\/github\.com\//, 'https://github.com/')
    .replace(/^github:/, '')
    .replace(/\.git$/, '')
  return /^[^/:]+\/[^/]+$/.test(normalized)
    ? `https://github.com/${normalized}`
    : normalized
}

function dependencyEntries(manifest) {
  const required = Object.keys(manifest.dependencies ?? {}).map((name) => ({
    name,
    optional: false,
  }))
  const optional = Object.keys(manifest.optionalDependencies ?? {}).map(
    (name) => ({ name, optional: true })
  )
  const byName = new Map()
  for (const dependency of [...required, ...optional]) {
    byName.set(dependency.name, dependency)
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
}

async function packageLicenseFiles({
  projectDir,
  packageDirectory,
  packageKey,
  override,
}) {
  if (override?.packageLicenseFiles) {
    return readConfiguredLicenseFiles({
      files: override.packageLicenseFiles,
      baseDirectory: packageDirectory,
      labelPrefix: `${packageKey}/`,
    })
  }

  const discovered = await readPackageLicenseFiles(packageDirectory)
  if (discovered.length > 0) return discovered
  if (!override?.fallbackLicenseFiles) {
    throw new Error(
      `${packageKey} has no top-level LICENSE/NOTICE file; add a reviewed packageOverrides entry`
    )
  }
  const fallback = await readConfiguredLicenseFiles({
    files: override.fallbackLicenseFiles,
    baseDirectory: projectDir,
    labelPrefix: 'repository:',
  })
  return fallback.map((license) => ({
    ...license,
    text: override.attribution
      ? `Attribution: ${override.attribution}\n\n${license.text}`
      : license.text,
  }))
}

export async function collectRuntimePackages({
  projectDir = DEFAULT_PROJECT_DIR,
  packageOverrides = {},
} = {}) {
  const resolvedProjectDir = await realpath(projectDir)
  const rootManifest = await readJson(
    path.join(resolvedProjectDir, 'package.json')
  )
  const queue = dependencyEntries(rootManifest).map((dependency) => ({
    ...dependency,
    fromDirectory: resolvedProjectDir,
    parentKey: null,
  }))
  const packages = new Map()
  const rootDependencies = new Set()
  const relationships = new Set()

  for (let index = 0; index < queue.length; index += 1) {
    const dependency = queue[index]
    const manifestPath = await resolveInstalledPackage(
      dependency.fromDirectory,
      dependency.name,
      resolvedProjectDir
    )
    if (!manifestPath) {
      if (dependency.optional) continue
      throw new Error(
        `declared runtime dependency is not installed: ${dependency.name} (required by ${dependency.parentKey ?? rootManifest.name})`
      )
    }

    const manifest = await readJson(manifestPath)
    const packageKey = `${manifest.name}@${manifest.version}`
    if (dependency.parentKey) {
      relationships.add(`${dependency.parentKey}\0${packageKey}`)
    } else {
      rootDependencies.add(packageKey)
    }
    if (packages.has(packageKey)) continue

    const licenseDeclared = manifest.license
    if (typeof licenseDeclared !== 'string' || licenseDeclared.trim() === '') {
      throw new Error(`${packageKey} has no declared license in package.json`)
    }
    const packageDirectory = await realpath(path.dirname(manifestPath))
    const override = packageOverrides[packageKey]
    const licenseFiles = await packageLicenseFiles({
      projectDir: resolvedProjectDir,
      packageDirectory,
      packageKey,
      override,
    })
    packages.set(packageKey, {
      key: packageKey,
      name: manifest.name,
      version: manifest.version,
      licenseDeclared,
      licenseConcluded: override?.licenseConcluded ?? licenseDeclared,
      repository: repositoryUrl(manifest),
      attribution: override?.attribution ?? null,
      licenseFiles,
    })

    for (const child of dependencyEntries(manifest)) {
      queue.push({
        ...child,
        fromDirectory: packageDirectory,
        parentKey: packageKey,
      })
    }
  }

  for (const packageKey of Object.keys(packageOverrides)) {
    if (!packages.has(packageKey)) {
      throw new Error(
        `packageOverrides contains a stale or platform-incompatible entry: ${packageKey}`
      )
    }
  }

  return {
    root: { name: rootManifest.name, version: rootManifest.version },
    packages: [...packages.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    ),
    rootDependencies: [...rootDependencies].sort((left, right) =>
      left.localeCompare(right)
    ),
    relationships: [...relationships]
      .map((entry) => {
        const [from, to] = entry.split('\0')
        return { from, to }
      })
      .sort((left, right) =>
        `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`)
      ),
  }
}

function interpolate(template, values) {
  return template.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = values[key]
    if (typeof value !== 'string') {
      throw new Error(`missing metadata field for template: ${key}`)
    }
    return value
  })
}

async function collectExternalComponents(projectDir, config) {
  const components = []
  for (const component of config.externalComponents ?? []) {
    let metadata = {}
    let packageDirectory = null
    if (component.metadataFile) {
      const rootMetadata = await readJson(
        path.join(projectDir, component.metadataFile)
      )
      let selectedMetadata = rootMetadata
      for (const segment of component.metadataPath ?? []) {
        selectedMetadata = selectedMetadata?.[segment]
      }
      if (
        typeof selectedMetadata !== 'object' ||
        selectedMetadata === null ||
        Array.isArray(selectedMetadata)
      ) {
        throw new Error(
          `external component ${component.id} has an invalid metadataPath`
        )
      }
      metadata = { ...rootMetadata, ...selectedMetadata }
    }
    if (component.package) {
      const manifestPath = await resolveInstalledPackage(
        projectDir,
        component.package,
        projectDir
      )
      if (!manifestPath) {
        throw new Error(
          `external package is not installed: ${component.package}`
        )
      }
      metadata = await readJson(manifestPath)
      packageDirectory = await realpath(path.dirname(manifestPath))
    }

    const name = component.nameField
      ? metadata[component.nameField]
      : component.name
    const version = component.versionField
      ? metadata[component.versionField]
      : metadata.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`external component ${component.id} has invalid metadata`)
    }

    const repository = component.sourceTemplate
      ? interpolate(component.sourceTemplate, metadata)
      : repositoryUrl(metadata)
    const rootLicenses = await readConfiguredLicenseFiles({
      files: component.licenseFiles ?? [],
      baseDirectory: projectDir,
      labelPrefix: 'repository:',
    })
    const packageLicenses = component.packageLicenseFiles
      ? await readConfiguredLicenseFiles({
          files: component.packageLicenseFiles,
          baseDirectory: packageDirectory,
          labelPrefix: `${component.package}@${version}/`,
        })
      : []

    for (const required of component.requiredRuntimeNoticeFiles ?? []) {
      const filePath = path.resolve(packageDirectory, required)
      if (
        !isWithin(packageDirectory, filePath) ||
        !(await isRegularFile(filePath))
      ) {
        throw new Error(
          `required runtime notice is missing for ${component.id}: ${required}`
        )
      }
    }

    components.push({
      id: component.id,
      name,
      version,
      scope: component.scope,
      licenseDeclared: component.licenseDeclared,
      licenseConcluded: component.licenseConcluded ?? component.licenseDeclared,
      repository,
      licenseFiles: [...rootLicenses, ...packageLicenses],
      requiredRuntimeNoticeFiles: component.requiredRuntimeNoticeFiles ?? [],
    })
  }
  return components.sort((left, right) => left.id.localeCompare(right.id))
}

async function collectManualAssets(projectDir, config) {
  const notices = await Promise.all(
    NOTICE_FILES.map((name) => readFile(path.join(projectDir, name), 'utf8'))
  )
  const assets = []
  for (const asset of config.manualAssets ?? []) {
    for (const relativePath of asset.paths) {
      const filePath = path.resolve(projectDir, relativePath)
      if (!isWithin(projectDir, filePath) || !(await isRegularFile(filePath))) {
        throw new Error(`manual third-party asset is missing: ${relativePath}`)
      }
    }
    for (const [index, notice] of notices.entries()) {
      if (!notice.includes(asset.noticeMarker)) {
        throw new Error(
          `${NOTICE_FILES[index]} does not document manual asset ${asset.id} (${asset.noticeMarker})`
        )
      }
    }
    assets.push(asset)
  }
  return assets.sort((left, right) => left.id.localeCompare(right.id))
}

async function assertExternalComponentNotices(
  projectDir,
  config,
  externalComponents
) {
  const notices = await Promise.all(
    NOTICE_FILES.map((name) => readFile(path.join(projectDir, name), 'utf8'))
  )
  const byId = new Map(
    externalComponents.map((component) => [component.id, component])
  )
  for (const declaration of config.externalComponents ?? []) {
    const component = byId.get(declaration.id)
    for (const markerTemplate of declaration.noticeMarkers ?? []) {
      const marker = interpolate(markerTemplate, component)
      for (const [index, notice] of notices.entries()) {
        if (!notice.includes(marker)) {
          throw new Error(
            `${NOTICE_FILES[index]} does not contain ${declaration.id} marker: ${marker}`
          )
        }
      }
    }
  }
}

async function assertReviewedRepositoryLicenseFiles(projectDir, config) {
  for (const [relativePath, expectedDigest] of Object.entries(
    config.reviewedRepositoryLicenseFiles ?? {}
  )) {
    const filePath = path.resolve(projectDir, relativePath)
    if (!isWithin(projectDir, filePath) || !(await isRegularFile(filePath))) {
      throw new Error(
        `reviewed repository license file is missing: ${relativePath}`
      )
    }
    const actualDigest = sha256(await readFile(filePath))
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `reviewed repository license file changed: ${relativePath} (expected ${expectedDigest}, got ${actualDigest})`
      )
    }
  }
}

function assertAllowedLicenses(config, packages, externalComponents) {
  const allowed = new Set(config.allowedLicenseExpressions ?? [])
  for (const component of [...packages, ...externalComponents]) {
    if (!allowed.has(component.licenseDeclared)) {
      throw new Error(
        `${component.name}@${component.version} uses unreviewed license expression: ${component.licenseDeclared}`
      )
    }
    if (!allowed.has(component.licenseConcluded)) {
      throw new Error(
        `${component.name}@${component.version} concludes to unreviewed license expression: ${component.licenseConcluded}`
      )
    }
  }
}

function escapeTableCell(value) {
  return String(value ?? '—')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

function renderDependencyInventory({
  packages,
  externalComponents,
  manualAssets,
}) {
  const lines = [
    '# Runtime Third-Party Dependency Inventory',
    '',
    '<!-- Generated by scripts/generate-third-party-notices.mjs. Do not edit. -->',
    '',
    'This inventory is generated from the root runtime dependency declarations and the installed, lockfile-resolved package manifests. Only package-root license and notice files are discovered automatically; reviewed exceptions are declared in `scripts/third-party-notices.config.json`.',
    '',
    '## npm runtime dependency graph',
    '',
    '| Package | Version | Declared license | Concluded license | Source |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const pkg of packages) {
    const source = pkg.repository ? `<${pkg.repository}>` : '—'
    lines.push(
      `| ${escapeTableCell(pkg.name)} | ${escapeTableCell(pkg.version)} | \`${escapeTableCell(pkg.licenseDeclared)}\` | \`${escapeTableCell(pkg.licenseConcluded)}\` | ${source} |`
    )
  }

  lines.push(
    '',
    '## Explicit non-npm components',
    '',
    '| Component | Version | Scope | License | Source |',
    '| --- | --- | --- | --- | --- |'
  )
  for (const component of externalComponents) {
    lines.push(
      `| ${escapeTableCell(component.name)} | ${escapeTableCell(component.version)} | ${escapeTableCell(component.scope)} | \`${escapeTableCell(component.licenseDeclared)}\` | ${component.repository ? `<${component.repository}>` : '—'} |`
    )
  }

  lines.push(
    '',
    '## Manually declared assets',
    '',
    '| Asset | Scope | License reference | Repository paths |',
    '| --- | --- | --- | --- |'
  )
  for (const asset of manualAssets) {
    lines.push(
      `| ${escapeTableCell(asset.name)} | ${escapeTableCell(asset.scope)} | \`${escapeTableCell(asset.licenseDeclared)}\` | ${asset.paths.map((entry) => `\`${entry}\``).join('<br>')} |`
    )
  }
  return `${lines.join('\n')}\n`
}

function renderConsolidatedLicenses(packages, externalComponents) {
  const groups = new Map()
  for (const component of [...packages, ...externalComponents]) {
    for (const license of component.licenseFiles) {
      const digest = sha256(license.text)
      const group = groups.get(digest) ?? {
        digest,
        text: license.text,
        sources: new Set(),
        components: new Set(),
      }
      group.sources.add(license.label)
      group.components.add(`${component.name}@${component.version}`)
      groups.set(digest, group)
    }
  }

  const lines = [
    'THIRD-PARTY LICENSE TEXTS',
    'Generated by scripts/generate-third-party-notices.mjs. Do not edit.',
  ]
  for (const group of [...groups.values()].sort((left, right) =>
    left.digest.localeCompare(right.digest)
  )) {
    lines.push(
      '',
      '='.repeat(80),
      `SHA-256: ${group.digest}`,
      `Components: ${[...group.components].sort().join(', ')}`,
      `Sources: ${[...group.sources].sort().join(', ')}`,
      '-'.repeat(80),
      group.text
    )
  }
  return `${lines.join('\n')}\n`
}

function spdxId(prefix, key) {
  const normalized = key.replace(/[^A-Za-z0-9.-]+/g, '-')
  return `SPDXRef-${prefix}-${normalized}-${sha256(key).slice(0, 10)}`
}

function renderSpdx({
  root,
  packages,
  rootDependencies,
  relationships,
  externalComponents,
  manualAssets,
}) {
  const packageIds = new Map(
    packages.map((pkg) => [pkg.key, spdxId('Package', pkg.key)])
  )
  const rootId = spdxId('Package', `${root.name}@${root.version}`)
  const externalIds = new Map(
    externalComponents.map((component) => [
      component.id,
      spdxId('Component', `${component.id}@${component.version}`),
    ])
  )
  const assetIds = new Map(
    manualAssets.map((asset) => [asset.id, spdxId('Asset', asset.id)])
  )
  const namespaceHash = sha256(
    JSON.stringify({
      root,
      packages: packages.map((pkg) => pkg.key),
      external: externalComponents.map((component) => component.id),
      assets: manualAssets.map((asset) => asset.id),
    })
  )
  const spdxPackages = [
    {
      SPDXID: rootId,
      name: root.name,
      versionInfo: root.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
    },
    ...packages.map((pkg) => ({
      SPDXID: packageIds.get(pkg.key),
      name: pkg.name,
      versionInfo: pkg.version,
      downloadLocation: pkg.repository ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: pkg.licenseConcluded,
      licenseDeclared: pkg.licenseDeclared,
      copyrightText: pkg.attribution ?? 'NOASSERTION',
    })),
    ...externalComponents.map((component) => ({
      SPDXID: externalIds.get(component.id),
      name: component.name,
      versionInfo: component.version,
      downloadLocation: component.repository ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: component.licenseConcluded,
      licenseDeclared: component.licenseDeclared,
      copyrightText: 'NOASSERTION',
      comment: `Distribution scope: ${component.scope}`,
    })),
    ...manualAssets.map((asset) => ({
      SPDXID: assetIds.get(asset.id),
      name: asset.name,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: asset.licenseDeclared,
      licenseDeclared: asset.licenseDeclared,
      copyrightText: 'NOASSERTION',
      comment: `Distribution scope: ${asset.scope}; paths: ${asset.paths.join(', ')}`,
    })),
  ]
  const spdxRelationships = [
    {
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: rootId,
    },
    ...rootDependencies.map((packageKey) => ({
      spdxElementId: rootId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: packageIds.get(packageKey),
    })),
    ...relationships.map((relationship) => ({
      spdxElementId: packageIds.get(relationship.from),
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: packageIds.get(relationship.to),
    })),
    ...externalComponents.map((component) => ({
      spdxElementId: rootId,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: externalIds.get(component.id),
    })),
    ...manualAssets.map((asset) => ({
      spdxElementId: rootId,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: assetIds.get(asset.id),
    })),
  ]

  return `${JSON.stringify(
    {
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `${root.name}-${root.version}-distributed-components`,
      documentNamespace: `https://motrix.app/spdx/${root.version}/${namespaceHash}`,
      creationInfo: {
        created: new Date(0).toISOString(),
        creators: ['Tool: scripts/generate-third-party-notices.mjs'],
      },
      packages: spdxPackages,
      relationships: spdxRelationships,
      hasExtractedLicensingInfos: [
        {
          licenseId: 'LicenseRef-UI8-Standard-License',
          name: 'UI8 Standard License',
          seeAlsos: ['https://ui8.net/licensing'],
          extractedText:
            'See THIRD_PARTY_NOTICES.md for the proprietary asset notice.',
        },
        {
          licenseId: 'LicenseRef-Apple-San-Francisco-Font-License',
          name: 'Apple San Francisco Font License',
          seeAlsos: ['https://developer.apple.com/fonts/'],
          extractedText:
            'See THIRD_PARTY_NOTICES.md for the proprietary font notice.',
        },
      ],
    },
    null,
    2
  )}\n`
}

export async function buildThirdPartyBundle({
  projectDir = DEFAULT_PROJECT_DIR,
  configFile = DEFAULT_CONFIG_FILE,
} = {}) {
  const resolvedProjectDir = await realpath(projectDir)
  const config = await readJson(configFile)
  if (config.schemaVersion !== 1) {
    throw new Error(
      `unsupported third-party notice config schema: ${config.schemaVersion}`
    )
  }
  const graph = await collectRuntimePackages({
    projectDir: resolvedProjectDir,
    packageOverrides: config.packageOverrides,
  })
  const [externalComponents, manualAssets] = await Promise.all([
    collectExternalComponents(resolvedProjectDir, config),
    collectManualAssets(resolvedProjectDir, config),
  ])
  await Promise.all([
    assertExternalComponentNotices(
      resolvedProjectDir,
      config,
      externalComponents
    ),
    assertReviewedRepositoryLicenseFiles(resolvedProjectDir, config),
  ])
  assertAllowedLicenses(config, graph.packages, externalComponents)

  return {
    packageCount: graph.packages.length,
    files: {
      'THIRD_PARTY_DEPENDENCIES.md': renderDependencyInventory({
        packages: graph.packages,
        externalComponents,
        manualAssets,
      }),
      'THIRD_PARTY_LICENSES.txt': renderConsolidatedLicenses(
        graph.packages,
        externalComponents
      ),
      'sbom.spdx.json': renderSpdx({
        ...graph,
        externalComponents,
        manualAssets,
      }),
    },
  }
}

export async function writeThirdPartyBundle({
  outputDir = DEFAULT_OUTPUT_DIR,
  ...options
} = {}) {
  const bundle = await buildThirdPartyBundle(options)
  await mkdir(outputDir, { recursive: true })
  await Promise.all(
    Object.entries(bundle.files).map(([name, content]) =>
      writeFile(path.join(outputDir, name), content, 'utf8')
    )
  )
  return bundle
}

function parseArgs(argv) {
  const args = { check: false, outputDir: DEFAULT_OUTPUT_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--check') args.check = true
    else if (token === '--output-dir') {
      const value = argv[index + 1]
      if (!value) throw new Error('--output-dir requires a value')
      args.outputDir = path.resolve(value)
      index += 1
    } else {
      throw new Error(`unknown argument: ${token}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await access(path.join(DEFAULT_PROJECT_DIR, 'node_modules'), constants.R_OK)
  const bundle = args.check
    ? await buildThirdPartyBundle()
    : await writeThirdPartyBundle({ outputDir: args.outputDir })
  const action = args.check ? 'validated' : 'generated'
  process.stdout.write(
    `[third-party-notices] ${action} ${bundle.packageCount} runtime packages\n`
  )
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`[third-party-notices] ${error.message}\n`)
    process.exitCode = 1
  })
}
