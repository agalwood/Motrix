import { securityFixture } from '@test-utils/plugin-security'
import { describe, expect, it } from 'vitest'
import {
  assertPolicyTransition,
  matchingAdvisories,
  verifySecurityPolicy,
} from './policy-verifier'

const now = Date.parse('2026-10-06T00:00:00Z')

describe('plugin security wire trust', () => {
  it('authenticates exact policy bytes with the independent pinned key', () => {
    const fixture = securityFixture()
    const policy = fixture.policy(now)
    expect(
      verifySecurityPolicy(fixture.sign(policy), fixture.trust.publicKeys)
    ).toEqual(policy)
    expect(() =>
      verifySecurityPolicy(
        fixture.sign(policy),
        securityFixture().trust.publicKeys
      )
    ).toThrow('signature')
    const envelope = JSON.parse(fixture.sign(policy))
    envelope.payload = Buffer.from(
      JSON.stringify({ ...policy, revision: 99 })
    ).toString('base64')
    expect(() =>
      verifySecurityPolicy(JSON.stringify(envelope), fixture.trust.publicKeys)
    ).toThrow('signature')
  })

  it('rejects unknown instructions, ambiguous rules, and unsupported formats', () => {
    const fixture = securityFixture()
    const policy = fixture.policy(now)
    for (const invalid of [
      { ...policy, schemaVersion: 2 },
      { ...policy, execute: 'anything' },
      { ...policy, advisories: [...policy.advisories, ...policy.advisories] },
      {
        ...policy,
        advisories: [
          { ...policy.advisories[0], url: 'https://attacker.test/' },
        ],
      },
      {
        ...policy,
        advisories: [
          {
            ...policy.advisories[0],
            affected: [
              {
                kind: 'plugin',
                pluginId: 'x',
                beforeExclusive: '1.0.0',
                fromInclusive: '2.0.0',
              },
            ],
          },
        ],
      },
    ])
      expect(() =>
        verifySecurityPolicy(fixture.sign(invalid), fixture.trust.publicKeys)
      ).toThrow()
  })

  it('requires explicit withdrawal and monotonic revisions', () => {
    const fixture = securityFixture()
    const first = fixture.policy(now, { revision: 2 })
    expect(() =>
      assertPolicyTransition(first, { ...first, revision: 1 })
    ).toThrow('rollback')
    expect(() =>
      assertPolicyTransition(first, { ...first, advisories: [] })
    ).toThrow('reused')
    expect(() =>
      assertPolicyTransition(first, { ...first, revision: 3, advisories: [] })
    ).toThrow('withdrawal')
    expect(() =>
      assertPolicyTransition(first, {
        ...first,
        revision: 3,
        advisories: first.advisories.map((entry) => ({
          ...entry,
          status: 'withdrawn',
        })),
      })
    ).not.toThrow()
  })

  it('matches prerelease bounds and exact archives independently of plugin identity', () => {
    const fixture = securityFixture()
    const policy = fixture.policy(now, {
      advisories: [
        {
          id: 'MTX-TEST-2',
          status: 'active',
          reason: 'vulnerability',
          affected: [
            {
              kind: 'plugin',
              pluginId: 'motrix.scraper-hook',
              fromInclusive: '1.0.0-beta.2',
              beforeExclusive: '1.0.0-beta.4',
            },
            { kind: 'archive', sha256: 'a'.repeat(64) },
          ],
        },
      ],
    })
    expect(
      matchingAdvisories(policy, {
        pluginId: 'motrix.scraper-hook',
        version: '1.0.0-beta.3',
      })
    ).toHaveLength(1)
    for (const version of ['1.0.0-beta.1', '1.0.0-beta.4', '1.0.0'])
      expect(
        matchingAdvisories(policy, { pluginId: 'motrix.scraper-hook', version })
      ).toHaveLength(0)
    expect(
      matchingAdvisories(policy, {
        pluginId: 'renamed.plugin',
        version: '9.9.9',
        archiveSha256: 'a'.repeat(64),
      })
    ).toHaveLength(1)
  })
})
