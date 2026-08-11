import { describe, expect, it } from 'vitest'
import { buildServerImageComparison } from '../../scripts/measure-server-images.mjs'

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    appBytes: 100,
    dependencyBytes: 80,
    files: 10,
    symlinks: 0,
    packageInstances: 8,
    packageNames: ['a', 'b'],
    directRoots: ['a'],
    optionalRoots: [],
    nativeBinaries: [{ path: 'node_modules/a/a.node', bytes: 10 }],
    ...overrides,
  }
}

function comparison(
  baselineSample = inventory(),
  optimizedSample = inventory({
    appBytes: 50,
    dependencyBytes: 30,
    packageInstances: 3,
    packageNames: ['a'],
  })
) {
  return buildServerImageComparison({
    target: 'linux-arm64-musl',
    samples: {
      baseline: [baselineSample, structuredClone(baselineSample)],
      optimized: [optimizedSample, structuredClone(optimizedSample)],
    },
    baseline: { imageBytes: 200, ...baselineSample },
    optimized: { imageBytes: 120, ...optimizedSample },
    stageReport: {
      passed: true,
      budgets: { artifactBytes: 96 * 1024 * 1024 },
      metrics: { artifactBytes: 50 },
    },
    dockerVersion: '29.4.0',
  })
}

describe('buildServerImageComparison', () => {
  it('reports stable material reductions and controlled stage evidence', () => {
    const report = comparison()

    expect(report.passed).toBe(true)
    expect(report.samplesStable).toEqual({ baseline: true, optimized: true })
    expect(report.reduction).toEqual({
      image: { bytes: 80, percent: 40 },
      app: { bytes: 50, percent: 50 },
      dependencies: { bytes: 50, percent: 62.5 },
      packageInstances: 5,
    })
    expect(report.controlledStage.passed).toBe(true)
  })

  it('fails comparison when repeated samples drift', () => {
    const baseline = inventory()
    const optimized = inventory({
      appBytes: 50,
      dependencyBytes: 30,
      packageInstances: 3,
    })
    const report = buildServerImageComparison({
      target: 'linux-arm64-musl',
      samples: {
        baseline: [baseline, { ...baseline, files: 11 }],
        optimized: [optimized, structuredClone(optimized)],
      },
      baseline: { imageBytes: 200, ...baseline },
      optimized: { imageBytes: 120, ...optimized },
      stageReport: { passed: true, budgets: {}, metrics: {} },
      dockerVersion: '29.4.0',
    })

    expect(report.passed).toBe(false)
    expect(report.samplesStable.baseline).toBe(false)
  })
})
