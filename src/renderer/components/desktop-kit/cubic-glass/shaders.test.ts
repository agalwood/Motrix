import { describe, expect, it } from 'vitest'
import {
  CUBIC_GLASS_FRAGMENT_SHADER,
  CUBIC_GLASS_VERTEX_SHADER,
  MAX_GRADIENT_BLOBS,
  MAX_GRADIENT_ENVELOPES,
} from './shaders'

describe('cubic glass shaders', () => {
  it('keeps the fullscreen triangle vertex shader contract', () => {
    expect(CUBIC_GLASS_VERTEX_SHADER).toContain('gl_VertexID')
    expect(CUBIC_GLASS_VERTEX_SHADER).toContain('gl_Position')
  })

  it('keeps array limits and scene uniforms in sync', () => {
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain(
      `uniform vec4 u_blob_geometry[${MAX_GRADIENT_BLOBS}]`
    )
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain(
      `uniform vec4 u_envelope_geometry[${MAX_GRADIENT_ENVELOPES}]`
    )
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain('uniform vec2 u_glow_offset')
    expect(CUBIC_GLASS_FRAGMENT_SHADER).toContain('out vec4 outColor')
  })
})
