import {
  lstat,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  externalPackageRoots,
  normalizeRelativePath,
  scanStaticModuleSpecifiers,
  stringifySortedJson,
  validateServerRuntimeContract,
  validateServerSizeBudgets,
} from './server-package-utils.mjs'

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is unreadable: ${filePath}`, { cause: error })
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function inventoryTree(target, options = {}) {
  const info = await stat(target)
  if (info.isFile()) return { bytes: info.size, files: 1 }
  let bytes = 0
  let files = 0
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (options.skipNodeModules && entry.name === 'node_modules') continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile()) {
        const entryInfo = await stat(entryPath)
        bytes += entryInfo.size
        files += 1
      } else {
        throw new Error(`audit input contains a non-file entry: ${entryPath}`)
      }
    }
  }
  await walk(target)
  return { bytes, files }
}

async function auditInputs(repoRoot, inputs, collectExternals) {
  const records = []
  const specifiers = new Set()
  for (const input of inputs) {
    const source = path.join(repoRoot, input.source)
    const info = await lstat(source).catch(() => null)
    if (info?.isSymbolicLink()) {
      throw new Error(`top-level audit input is a symlink: ${input.source}`)
    }
    if (
      !info ||
      (input.type === 'file' ? !info.isFile() : !info.isDirectory())
    ) {
      throw new Error(`missing ${input.type} input: ${input.source}`)
    }
    if (collectExternals) {
      const entries =
        input.type === 'file'
          ? [source]
          : (Array.isArray(input.entry) ? input.entry : [input.entry]).map(
              (entry) => path.join(source, entry)
            )
      for (const [index, entry] of entries.entries()) {
        if (
          input.type === 'directory' &&
          !(await stat(entry).catch(() => null))?.isFile()
        ) {
          const relativeEntry = Array.isArray(input.entry)
            ? input.entry[index]
            : input.entry
          throw new Error(
            `missing build entry: ${input.source}/${relativeEntry}`
          )
        }
      }
      if (input.scanExternals) {
        const modules =
          input.type === 'directory'
            ? await listJavaScriptFiles(source)
            : entries
        for (const modulePath of modules) {
          const sourceText = await readFile(modulePath, 'utf8')
          for (const specifier of scanStaticModuleSpecifiers(sourceText)) {
            specifiers.add(specifier)
          }
        }
      }
    }
    records.push({
      source: input.source,
      destination: input.destination,
      type: input.type,
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.scanExternals !== undefined
        ? { scanExternals: input.scanExternals }
        : {}),
      inventory: await inventoryTree(source),
    })
  }
  return { records, specifiers: [...specifiers].sort() }
}

async function listJavaScriptFiles(directory) {
  const files = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
        files.push(entryPath)
      }
    }
  }
  await walk(directory)
  return files
}

async function resolvePackageRoot(repoRoot, name) {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  const candidates = [path.join(repoRoot, 'node_modules', name, 'package.json')]
  try {
    candidates.push(require.resolve(`${name}/package.json`))
  } catch {
    try {
      let current = path.dirname(require.resolve(name))
      while (current !== path.dirname(current)) {
        candidates.push(path.join(current, 'package.json'))
        current = path.dirname(current)
      }
    } catch {
      // The caller reports the missing runtime root below.
    }
  }
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null)
    if (!info?.isFile()) continue
    const manifest = await readJson(candidate, `package ${name}`)
    if (manifest.name !== name || typeof manifest.version !== 'string') continue
    const root = await realpath(path.dirname(candidate))
    if (root !== repoRoot && !isInside(repoRoot, root)) {
      throw new Error(`resolved package ${name} escapes repository root`)
    }
    return { manifest, root }
  }
  throw new Error(`runtime root ${name} is not installed`)
}

function sumInventory(records) {
  return records.reduce(
    (total, record) => ({
      bytes: total.bytes + record.inventory.bytes,
      files: total.files + record.inventory.files,
    }),
    { bytes: 0, files: 0 }
  )
}

export async function auditServerRuntime(options = {}) {
  const repoRoot = await realpath(
    path.resolve(options.repoRoot ?? REPOSITORY_ROOT)
  )
  const contract = validateServerRuntimeContract(
    options.contract ??
      (await readJson(
        path.join(repoRoot, 'scripts/server-runtime-dependencies.json'),
        'server runtime contract'
      ))
  )
  validateServerSizeBudgets(
    options.budgets ??
      (await readJson(
        path.join(repoRoot, 'scripts/server-package-size-budgets.json'),
        'server size budgets'
      ))
  )
  const rootManifest = await readJson(
    path.join(repoRoot, 'package.json'),
    'root package manifest'
  )
  const build = await auditInputs(repoRoot, contract.buildInputs, true)
  const resources = await auditInputs(repoRoot, contract.resourceInputs, false)
  const observedRoots = externalPackageRoots(build.specifiers)
  const unexpectedRoots = observedRoots.filter(
    (name) => !contract.runtimeRoots.includes(name)
  )
  const staleRoots = contract.runtimeRoots.filter(
    (name) => !observedRoots.includes(name)
  )
  if (unexpectedRoots.length > 0 || staleRoots.length > 0) {
    throw new Error(
      [
        unexpectedRoots.length > 0
          ? `unexpected runtime roots: ${unexpectedRoots.join(', ')}`
          : undefined,
        staleRoots.length > 0
          ? `stale runtime roots: ${staleRoots.join(', ')}`
          : undefined,
      ]
        .filter(Boolean)
        .join('; ')
    )
  }

  const packages = []
  for (const name of contract.runtimeRoots) {
    const declaredVersion = rootManifest.dependencies?.[name]
    if (typeof declaredVersion !== 'string') {
      throw new Error(`runtime root ${name} is not a root dependency`)
    }
    const resolved = await resolvePackageRoot(repoRoot, name)
    packages.push({
      name,
      declaredVersion,
      version: resolved.manifest.version,
      inventory: await inventoryTree(resolved.root, { skipNodeModules: true }),
      source: normalizeRelativePath(
        path.relative(repoRoot, resolved.root),
        `source for ${name}`
      ),
    })
  }

  return {
    schemaVersion: 1,
    rootVersion: rootManifest.version,
    rootProductionDeclarations: {
      dependencies: Object.keys(rootManifest.dependencies ?? {}).length,
      optionalDependencies: Object.keys(rootManifest.optionalDependencies ?? {})
        .length,
    },
    externals: {
      specifiers: build.specifiers,
      roots: observedRoots,
    },
    buildInputs: build.records,
    resourceInputs: resources.records,
    controlledInputs: {
      build: sumInventory(build.records),
      resources: sumInventory(resources.records),
    },
    runtimeRoots: packages,
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (!['--report', '--root'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for ${argument}`)
    }
    options[argument.slice(2)] = value
    index += 1
  }
  return options
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const report = await auditServerRuntime({ repoRoot: args.root })
  const output = stringifySortedJson(report)
  if (args.report) {
    const reportPath = path.resolve(args.report)
    await writeFile(reportPath, output)
  }
  process.stdout.write(output)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
