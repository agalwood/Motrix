import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FIREFOX_CASES,
  verifyTakeoverReport,
} from '../verify-takeover-report.mjs'

function completeReport() {
  return {
    schemaVersion: 1,
    suite: 'firefox-browser-integration',
    backend: 'mdxp-simulator',
    revision: 'current-revision',
    browserVersion: '143.0',
    extensionSha256: 'a'.repeat(64),
    status: 'passed',
    fetchReceiver: 'passed',
    cases: FIREFOX_CASES.map((name) => ({
      name,
      status: 'passed',
      result: { name, requests: [{ method: 'GET' }], mdxp: { taskCount: 0 } },
    })),
  }
}

test('accepts complete, correctly attributed evidence', () => {
  verifyTakeoverReport(completeReport(), {
    revision: 'current-revision',
    browser: '143.0',
  })
})
for (const status of ['running', 'failed', 'skipped']) {
  test(`rejects ${status} runs`, () => {
    const report = completeReport()
    report.status = status
    assert.throws(() => verifyTakeoverReport(report))
  })
}
test('rejects missing, duplicated, and failed scenarios', () => {
  for (const mutate of [
    (cases) => cases.pop(),
    (cases) => {
      cases[1] = cases[0]
    },
    (cases) => {
      cases[0].status = 'failed'
    },
  ]) {
    const report = completeReport()
    mutate(report.cases)
    assert.throws(() => verifyTakeoverReport(report))
  }
})
test('rejects evidence from a different revision or browser', () => {
  assert.throws(() =>
    verifyTakeoverReport(completeReport(), { revision: 'old-revision' })
  )
  assert.throws(() =>
    verifyTakeoverReport(completeReport(), { browser: '144.0' })
  )
})
test('rejects a mislabeled backend and absent network evidence', () => {
  for (const mutate of [
    (report) => {
      report.backend = 'real-motrix'
    },
    (report) => {
      report.cases[0].result.requests = []
    },
    (report) => {
      delete report.cases[0].result.mdxp
    },
  ]) {
    const report = completeReport()
    mutate(report)
    assert.throws(() => verifyTakeoverReport(report))
  }
})
