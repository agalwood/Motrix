import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- JavaScript verification script intentionally has no declarations
import {
  validateThreatEvidenceManifest,
  verifyThreatEvidence,
} from '../../scripts/verify-remote-extension-threat-evidence.mjs'

function completeManifest(
  path = 'tests/security.test.ts',
  testName = 'blocks attack'
) {
  return {
    schemaVersion: 1,
    threats: Array.from({ length: 29 }, (_, index) => ({
      id: `T${String(index + 1).padStart(2, '0')}`,
      evidence: [{ repository: 'motrix', path, testName }],
    })),
  }
}

describe('remote Extension threat evidence', () => {
  it('requires an exact, complete T01-T29 mapping', () => {
    expect(
      validateThreatEvidenceManifest(completeManifest()).threats
    ).toHaveLength(29)
    expect(() =>
      validateThreatEvidenceManifest({
        ...completeManifest(),
        threats: completeManifest().threats.slice(0, 28),
      })
    ).toThrow(/missing: T29/)
    expect(() =>
      validateThreatEvidenceManifest({
        ...completeManifest(),
        threats: [
          ...completeManifest().threats.slice(0, 28),
          completeManifest().threats[0],
        ],
      })
    ).toThrow(/unique T01-T29/)
  })

  it.each([
    '../security.test.ts',
    '/tmp/security.test.ts',
    'tests/security.ts',
    'tests\\security.test.ts',
  ])('rejects unsafe evidence path %j', (path) => {
    expect(() =>
      validateThreatEvidenceManifest(completeManifest(path))
    ).toThrow(/relative test file/)
  })

  it('verifies that every mapped file and title still exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'motrix-threat-evidence-'))
    const motrixRepository = join(root, 'motrix')
    const extensionRepository = join(root, 'extension')
    const evidencePath = join(motrixRepository, 'tests/security.test.ts')
    const manifestPath = join(root, 'manifest.json')
    mkdirSync(dirname(evidencePath), { recursive: true })
    mkdirSync(extensionRepository, { recursive: true })
    writeFileSync(evidencePath, "it('blocks attack', () => {})\n")
    writeFileSync(manifestPath, JSON.stringify(completeManifest()))

    expect(
      verifyThreatEvidence({
        manifestPath,
        motrixRepository,
        extensionRepository,
      })
    ).toEqual({ threatCount: 29, evidenceCount: 29 })

    writeFileSync(evidencePath, "it('renamed test', () => {})\n")
    expect(() =>
      verifyThreatEvidence({
        manifestPath,
        motrixRepository,
        extensionRepository,
      })
    ).toThrow(/evidence title is missing/)
  })
})
