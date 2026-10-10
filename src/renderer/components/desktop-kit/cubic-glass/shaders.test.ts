import { describe, expect, it } from 'vitest'
import {
  CUBIC_GLASS_FRAGMENT_SHADER,
  MAX_GRADIENT_BLOBS,
  MAX_GRADIENT_ENVELOPES,
} from './shaders'

describe('cubic glass shaders', () => {
  it('keeps shader array lengths in sync with the scene capacity', () => {
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain(
      `uniform vec4 u_blob_geometry[${MAX_GRADIENT_BLOBS}]`
    )
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain(
      `uniform vec4 u_envelope_geometry[${MAX_GRADIENT_ENVELOPES}]`
    )
  })
})
