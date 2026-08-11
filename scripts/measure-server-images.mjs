import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { stringifySortedJson } from './server-package-utils.mjs'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 4 * 1024 * 1024

async function docker(args) {
  const result = await execFileAsync('docker', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
  return result.stdout.trim()
}

const INVENTORY_SCRIPT = [
  "import { lstat, readdir, readFile } from 'node:fs/promises'",
  "import path from 'node:path'",
  "const root = '/app'",
  'let appBytes = 0',
  'let dependencyBytes = 0',
  'let files = 0',
  'let symlinks = 0',
  'const packages = []',
  'const nativeBinaries = []',
  'function packageRecord(relative) {',
  "  const parts = relative.split('/')",
  "  if (parts.at(-1) !== 'package.json') return undefined",
  "  const index = parts.lastIndexOf('node_modules')",
  '  if (index < 0) return undefined',
  '  const first = parts[index + 1]',
  '  if (!first) return undefined',
  "  const manifestIndex = first.startsWith('@') ? index + 3 : index + 2",
  '  if (manifestIndex !== parts.length - 1) return undefined',
  "  const name = first.startsWith('@') ? first + '/' + parts[index + 2] : first",
  "  return { destination: parts.slice(0, manifestIndex).join('/'), name }",
  '}',
  'async function walk(directory, relativeDirectory) {',
  '  const entries = await readdir(directory, { withFileTypes: true })',
  '  entries.sort((left, right) => left.name.localeCompare(right.name))',
  '  for (const entry of entries) {',
  '    const absolute = path.join(directory, entry.name)',
  "    const relative = relativeDirectory ? relativeDirectory + '/' + entry.name : entry.name",
  '    const info = await lstat(absolute)',
  '    if (info.isSymbolicLink()) { symlinks += 1; appBytes += info.size; continue }',
  '    if (info.isDirectory()) { await walk(absolute, relative); continue }',
  '    if (!info.isFile()) continue',
  '    files += 1',
  '    appBytes += info.size',
  "    if (relative.startsWith('node_modules/')) dependencyBytes += info.size",
  "    if (relative.endsWith('.node')) nativeBinaries.push({ path: relative, bytes: info.size })",
  '    const record = packageRecord(relative)',
  '    if (record) {',
  "      const manifest = JSON.parse(await readFile(absolute, 'utf8'))",
  '      packages.push({ ...record, version: manifest.version })',
  '    }',
  '  }',
  '}',
  'await walk(root, "")',
  "const manifest = JSON.parse(await readFile('/app/package.json', 'utf8'))",
  'packages.sort((left, right) => left.destination.localeCompare(right.destination))',
  'nativeBinaries.sort((left, right) => left.path.localeCompare(right.path))',
  'const packageNames = [...new Set(packages.map((entry) => entry.name))].sort()',
  'console.log(JSON.stringify({',
  '  appBytes,',
  '  dependencyBytes,',
  '  files,',
  '  symlinks,',
  '  packageInstances: packages.length,',
  '  packageNames,',
  '  directRoots: Object.keys(manifest.dependencies ?? {}).sort(),',
  '  optionalRoots: Object.keys(manifest.optionalDependencies ?? {}).sort(),',
  '  nativeBinaries,',
  '}))',
].join('\n')

function reduction(baseline, optimized) {
  const bytes = baseline - optimized
  return {
    bytes,
    percent: baseline === 0 ? 0 : Number(((bytes / baseline) * 100).toFixed(2)),
  }
}

export function buildServerImageComparison({
  target,
  samples,
  baseline,
  optimized,
  stageReport,
  dockerVersion,
}) {
  const baselineStable = samples.baseline.every(
    (sample) => JSON.stringify(sample) === JSON.stringify(samples.baseline[0])
  )
  const optimizedStable = samples.optimized.every(
    (sample) => JSON.stringify(sample) === JSON.stringify(samples.optimized[0])
  )
  const imageReduction = reduction(baseline.imageBytes, optimized.imageBytes)
  const appReduction = reduction(baseline.appBytes, optimized.appBytes)
  const dependencyReduction = reduction(
    baseline.dependencyBytes,
    optimized.dependencyBytes
  )
  const packageInstanceReduction =
    baseline.packageInstances - optimized.packageInstances
  const passed = Boolean(
    baselineStable &&
      optimizedStable &&
      imageReduction.bytes > 0 &&
      appReduction.bytes > 0 &&
      dependencyReduction.bytes > 0 &&
      packageInstanceReduction > 0 &&
      stageReport?.passed === true
  )
  return {
    schemaVersion: 1,
    target,
    passed,
    sampleCount: samples.baseline.length,
    samplesStable: { baseline: baselineStable, optimized: optimizedStable },
    baseline,
    optimized,
    reduction: {
      image: imageReduction,
      app: appReduction,
      dependencies: dependencyReduction,
      packageInstances: packageInstanceReduction,
    },
    controlledStage: {
      passed: stageReport?.passed === true,
      budgets: stageReport?.budgets,
      metrics: stageReport?.metrics,
    },
    toolVersions: {
      docker: dockerVersion,
      node: process.versions.node,
    },
  }
}

async function inspectImage(image) {
  const metadata = JSON.parse(await docker(['image', 'inspect', image]))[0]
  return {
    image,
    imageId: metadata.Id,
    imageBytes: metadata.Size,
    architecture: metadata.Architecture,
  }
}

async function inventoryImage(image) {
  const output = await docker([
    'run',
    '--rm',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '--eval',
    INVENTORY_SCRIPT,
  ])
  return JSON.parse(output)
}

async function measureImage(image, sampleCount) {
  const metadata = await inspectImage(image)
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await inventoryImage(image))
  }
  return {
    summary: { ...metadata, ...samples[0] },
    samples,
  }
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (index === 0 && argument === '--') continue
    if (!argument.startsWith('--'))
      throw new Error(`unknown argument: ${argument}`)
    const key = argument.slice(2)
    if (
      ![
        'baseline-image',
        'optimized-image',
        'report',
        'samples',
        'stage-report',
        'target',
      ].includes(key)
    ) {
      throw new Error(`unknown option: --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    index += 1
  }
  for (const key of [
    'baseline-image',
    'optimized-image',
    'report',
    'stage-report',
    'target',
  ]) {
    if (!options[key]) throw new Error(`--${key} is required`)
  }
  return options
}

export async function measureServerImages(options) {
  const sampleCount = options.samples ?? 3
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 2 ||
    sampleCount > 10
  ) {
    throw new Error('image measurement samples must be an integer from 2 to 10')
  }
  const stageReport = JSON.parse(await readFile(options.stageReport, 'utf8'))
  if (stageReport.target?.key !== options.target) {
    throw new Error(
      'controlled stage report target does not match image target'
    )
  }
  const [baselineMeasurement, optimizedMeasurement, dockerVersion] =
    await Promise.all([
      measureImage(options.baselineImage, sampleCount),
      measureImage(options.optimizedImage, sampleCount),
      docker(['version', '--format', '{{.Server.Version}}']),
    ])
  const report = buildServerImageComparison({
    target: options.target,
    samples: {
      baseline: baselineMeasurement.samples,
      optimized: optimizedMeasurement.samples,
    },
    baseline: baselineMeasurement.summary,
    optimized: optimizedMeasurement.summary,
    stageReport,
    dockerVersion,
  })
  await mkdir(path.dirname(path.resolve(options.report)), { recursive: true })
  await writeFile(options.report, stringifySortedJson(report), { mode: 0o644 })
  if (!report.passed) {
    throw new Error(
      'Server image comparison did not pass material-reduction gates'
    )
  }
  return report
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const raw = parseArguments(process.argv.slice(2))
  measureServerImages({
    baselineImage: raw['baseline-image'],
    optimizedImage: raw['optimized-image'],
    report: raw.report,
    samples: raw.samples ? Number.parseInt(raw.samples, 10) : undefined,
    stageReport: raw['stage-report'],
    target: raw.target,
  })
    .then((report) => {
      console.log(
        `Server image comparison passed: ${report.reduction.image.bytes} bytes (${report.reduction.image.percent}%)`
      )
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
