import { execFileSync } from 'node:child_process'
import path from 'node:path'

const kebabCaseExtensions = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.scss',
  '.ts',
  '.tsx',
])
const snakeCaseExtensions = new Set(['.py', '.rs'])
const excludedPrefixes = ['docs/', 'graphify-out/']

const output = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' }
).trim()
const files = output.length === 0 ? [] : output.split('\n')
const violations = []

for (const file of files) {
  if (excludedPrefixes.some((prefix) => file.startsWith(prefix))) continue

  const extension = path.extname(file)
  const convention = kebabCaseExtensions.has(extension)
    ? 'kebab-case'
    : snakeCaseExtensions.has(extension)
      ? 'snake_case'
      : null
  if (!convention) continue

  const basename = path.basename(file)
  const primaryStem = basename.slice(0, basename.indexOf('.'))
  const isCargoBinary = extension === '.rs' && file.includes('/src/bin/')
  const pattern = isCargoBinary
    ? /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/
    : convention === 'kebab-case'
      ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/
      : /^[a-z0-9]+(?:_[a-z0-9]+)*$/

  if (!pattern.test(primaryStem)) {
    const expected = isCargoBinary
      ? 'snake_case or Cargo kebab-case'
      : convention
    violations.push(`${file} (expected ${expected})`)
  }
}

if (violations.length > 0) {
  console.error('Invalid code file names:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(
    `File naming check passed (${files.length} Git-visible files scanned)`
  )
}
