import { describe, expect, it } from 'vitest'
import {
  computeRetryDelayMs,
  intersectPermissions,
  missingRequiredPermissions,
  PostDeliveryQuotaConfigSchema,
  PostDeliverySchedulerConfigSchema,
} from './delivery-types'

describe('post-delivery configuration', () => {
  it('applies the specified operational defaults', () => {
    expect(PostDeliverySchedulerConfigSchema.parse({})).toMatchObject({
      leaseMs: 120_000,
      claimBatch: 64,
      globalWorkers: 8,
      maxAttempts: 12,
      maxActiveAgeMs: 7 * 24 * 60 * 60_000,
      breakerThreshold: 5,
      breakerWindowMs: 10 * 60_000,
      breakerPauseMs: 15 * 60_000,
    })
  })

  it('rejects a delay cap below the base and global quotas below plugin quotas', () => {
    expect(() =>
      PostDeliverySchedulerConfigSchema.parse({
        baseDelayMs: 60_000,
        delayCapMs: 59_999,
      })
    ).toThrow()
    expect(() =>
      PostDeliveryQuotaConfigSchema.parse({
        pluginActiveBytes: 64 * 1024 * 1024,
        globalActiveBytes: 63 * 1024 * 1024,
      })
    ).toThrow()
  })
})

describe('post-delivery retry and permission helpers', () => {
  it('uses capped exponential delay followed by bounded injected jitter', () => {
    expect(
      computeRetryDelayMs(
        1,
        { baseDelayMs: 1_000, delayCapMs: 60_000 },
        { factor: () => 0.75 }
      )
    ).toBe(750)
    expect(
      computeRetryDelayMs(
        20,
        { baseDelayMs: 1_000, delayCapMs: 60_000 },
        { factor: () => 1.25 }
      )
    ).toBe(75_000)
    expect(() =>
      computeRetryDelayMs(
        1,
        { baseDelayMs: 1_000, delayCapMs: 60_000 },
        { factor: () => 1.251 }
      )
    ).toThrow()
  })

  it('never expands historical permissions with a later grant', () => {
    const effective = intersectPermissions(
      ['http', 'metadata'],
      ['metadata', 'notify']
    )
    expect(effective).toEqual(['metadata'])
    expect(missingRequiredPermissions(['http'], effective)).toEqual(['http'])
  })
})
