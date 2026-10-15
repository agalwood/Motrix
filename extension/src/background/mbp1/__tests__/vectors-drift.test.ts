// @vitest-environment node
// jsdom's URL global does not satisfy node:fs's file-URL check, so this test
// (readFileSync against a `new URL(..., import.meta.url)`) must run under the
// real node environment rather than the package's jsdom default.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MBP1_VECTORS_SHA256 } from '@/background/mbp1/__fixtures__/vectors'

describe('mbp1 vector fixture drift guard', () => {
  it('mbp1 vector fixture matches its recorded sha256 (cross-impl drift guard)', () => {
    const raw = readFileSync(
      new URL('../__fixtures__/mbp1-vectors.json', import.meta.url)
    )
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      MBP1_VECTORS_SHA256
    )
  })
})
