import type { PointerPositionConstraint } from './motion'
import type { CubicGlassEffects, CubicGlassGradientPreset } from './types'

export type RgbColor = readonly [number, number, number]

export interface GlassPalette {
  blue: RgbColor
  cell: RgbColor
  cyan: RgbColor
  pink: RgbColor
  violet: RgbColor
  warm: RgbColor
}

type GradientColor = Exclude<keyof GlassPalette, 'cell'>

interface GradientBlob {
  center: readonly [number, number]
  color: GradientColor
  intensity: number
  radius: readonly [number, number]
}

interface GradientEnvelope {
  center: readonly [number, number]
  horizontalPower: number
  intensity: number
  lowerFalloff: number
  lowerWidthScale: number
  radius: readonly [number, number]
}

export interface GradientPresetConfig {
  blobs: readonly GradientBlob[]
  envelopes: readonly GradientEnvelope[]
  lowerFalloff: number
}

export const POINTER_Y_RESPONSE_SECONDS = 1.05
export const POINTER_Y_RETURN_RESPONSE_SECONDS = 0.85

export const DEFAULT_CUBIC_GLASS_EFFECTS: CubicGlassEffects = {
  enabled: true,
  loadFade: true,
  breathing: true,
  horizontalSpeed: 50,
  pointerFollow: true,
  positionConstraint: true,
}

export const POINTER_TRAVEL: Record<
  CubicGlassGradientPreset,
  readonly [number, number]
> = {
  'blue-pink': [0.4, 0.22],
  'dual-wave': [0.34, 0.2],
}

export const POINTER_POSITION_CONSTRAINT: Record<
  CubicGlassGradientPreset,
  PointerPositionConstraint
> = {
  'blue-pink': { upward: 0.045, downward: 0.018, verticalPower: 1.35 },
  'dual-wave': { upward: 0.05, downward: 0.024, verticalPower: 1.3 },
}

export const GRADIENT_PRESETS: Record<
  CubicGlassGradientPreset,
  GradientPresetConfig
> = {
  'blue-pink': {
    lowerFalloff: 1,
    blobs: [
      {
        center: [0.33, 0.23],
        radius: [0.18, 1],
        color: 'blue',
        intensity: 1.3,
      },
      {
        center: [0.25, 0.23],
        radius: [0.15, 1],
        color: 'cyan',
        intensity: 0.04,
      },
      {
        center: [0.51, 0.23],
        radius: [0.16, 1],
        color: 'violet',
        intensity: 0.58,
      },
      {
        center: [0.66, 0.23],
        radius: [0.22, 1],
        color: 'pink',
        intensity: 1.1,
      },
    ],
    envelopes: [
      {
        center: [0.51, 0.23],
        radius: [0.225, 0.23],
        lowerFalloff: 1.9,
        lowerWidthScale: 1.28,
        intensity: 1.34,
        horizontalPower: 3,
      },
    ],
  },
  'dual-wave': {
    lowerFalloff: 1,
    blobs: [
      {
        center: [0.38, 0.36],
        radius: [0.24, 0.26],
        color: 'blue',
        intensity: 1.35,
      },
      {
        center: [0.14, 0.18],
        radius: [0.23, 0.23],
        color: 'cyan',
        intensity: 0.85,
      },
      {
        center: [0.02, -0.04],
        radius: [0.22, 0.18],
        color: 'pink',
        intensity: 0.62,
      },
      {
        center: [0.69, 0.2],
        radius: [0.18, 0.22],
        color: 'blue',
        intensity: 1.15,
      },
      {
        center: [0.86, 0.04],
        radius: [0.15, 0.2],
        color: 'pink',
        intensity: 0.7,
      },
      {
        center: [0.76, 0.03],
        radius: [0.21, 0.17],
        color: 'violet',
        intensity: 0.38,
      },
      {
        center: [0.48, -0.02],
        radius: [0.15, 0.13],
        color: 'warm',
        intensity: 0.42,
      },
    ],
    envelopes: [
      {
        center: [0.32, 0.27],
        radius: [0.38, 0.32],
        lowerFalloff: 1.35,
        lowerWidthScale: 1,
        intensity: 1.05,
        horizontalPower: 2,
      },
      {
        center: [0.72, 0.14],
        radius: [0.25, 0.22],
        lowerFalloff: 1.4,
        lowerWidthScale: 1,
        intensity: 0.9,
        horizontalPower: 2,
      },
    ],
  },
}

export const FALLBACK_PALETTE: GlassPalette = {
  cell: [0.985, 0.988, 1],
  blue: [0.34, 0.5, 0.96],
  cyan: [0.37, 0.74, 0.96],
  violet: [0.61, 0.5, 0.93],
  pink: [0.96, 0.63, 0.84],
  warm: [0.97, 0.88, 0.68],
}

export function resolveCubicGlassEffects(
  effects: Partial<CubicGlassEffects> | undefined
): CubicGlassEffects {
  const resolved = { ...DEFAULT_CUBIC_GLASS_EFFECTS, ...effects }
  const horizontalSpeed = Number.isFinite(resolved.horizontalSpeed)
    ? Math.max(0, Math.min(100, resolved.horizontalSpeed))
    : DEFAULT_CUBIC_GLASS_EFFECTS.horizontalSpeed

  return { ...resolved, horizontalSpeed }
}
