import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyTestReports(expected, reports) {
  const wanted = new Set(expected.map((entry) => entry.file))
  if (wanted.size === 0 || wanted.size !== expected.length) {
    throw new Error('Empty or duplicate test discovery')
  }
  const seen = new Set()
  let tests = 0
  let skipped = 0
  for (const report of reports) {
    if (
      report.success !== true ||
      report.numFailedTests !== 0 ||
      report.numFailedTestSuites !== 0 ||
      !Array.isArray(report.testResults) ||
      report.testResults.length === 0
    ) {
      throw new Error('Failed or empty test shard')
    }
    for (const result of report.testResults) {
      if (!wanted.has(result.name))
        throw new Error(`Unexpected test file: ${result.name}`)
      if (seen.has(result.name))
        throw new Error(`Duplicate test file: ${result.name}`)
      seen.add(result.name)
    }
    tests += report.numTotalTests
    skipped += report.numPendingTests + report.numTodoTests
  }
  const missing = [...wanted].filter((file) => !seen.has(file))
  if (missing.length)
    throw new Error(`Missing test files: ${missing.join(', ')}`)
  return { files: seen.size, tests, skipped }
}

function main() {
  const directory = 'output/ci/reports'
  const names = readdirSync(directory).sort()
  const shards = [1, 2, 3, 4].map((index) => `shard-${index}.json`)
  if (JSON.stringify(names) !== JSON.stringify(shards)) {
    throw new Error('Expected exactly four shard reports')
  }
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
  const result = verifyTestReports(
    readJson('output/ci/test-files.json'),
    names.map((name) => readJson(path.join(directory, name)))
  )
  const summary = `Verified ${result.files} test files exactly once across four shards; ${result.tests} tests (${result.skipped} skipped/todo).\n`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
}
