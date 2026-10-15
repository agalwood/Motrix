import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const FIREFOX_CASES = Object.freeze([
  'known',
  'probe-only',
  'confirm',
  'small',
  'unknown-chrome',
  'unknown-motrix',
  'early-default',
  'early-direct',
  'early-no-type',
  'early-confirm-accept',
  'early-confirm-browser',
  'early-confirm-cancel',
  'early-failed',
  'early-unknown',
  'early-disconnect-before',
  'early-invalid-result',
  'early-delayed',
  'early-small',
  'early-excluded',
  'early-off',
  'early-kill',
  'early-pdf',
])

/** Reject incomplete evidence even when the runner exits successfully. */
export function verifyTakeoverReport(report, { revision, browser } = {}) {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.suite, 'firefox-browser-integration')
  assert.equal(report.backend, 'mdxp-simulator')
  assert.equal(report.status, 'passed')
  assert.match(report.browserVersion, /^\d+\./)
  assert.match(report.extensionSha256, /^[a-f0-9]{64}$/)
  assert.equal(report.fetchReceiver, 'passed')
  if (revision) assert.equal(report.revision, revision, 'stale source revision')
  if (browser && browser !== 'latest')
    assert.equal(report.browserVersion, browser, 'unexpected Firefox version')
  assert.deepEqual(
    report.cases.map((item) => item.name).sort(),
    [...FIREFOX_CASES].sort(),
    'missing, duplicate, or unexpected scenarios'
  )
  for (const item of report.cases) {
    assert.equal(item.status, 'passed', item.name)
    assert.equal(item.result?.name, item.name)
    assert.ok(item.result.requests.length > 0, `${item.name}: no HTTP evidence`)
    assert.ok(
      Number.isInteger(item.result.mdxp.taskCount),
      `${item.name}: no MDXP evidence`
    )
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
  verifyTakeoverReport(report, {
    revision: process.env.GITHUB_SHA,
    browser: process.env.EXPECTED_FIREFOX_VERSION,
  })
  console.log(`Verified ${report.cases.length} browser integration scenarios`)
}
