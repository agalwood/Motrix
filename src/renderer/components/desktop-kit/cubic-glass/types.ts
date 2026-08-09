import type { RefObject } from 'react'

export type CubicGlassGradientPreset = 'blue-pink' | 'dual-wave'

export interface CubicGlassEffects {
  breathing: boolean
  enabled: boolean
  horizontalSpeed: number
  loadFade: boolean
  pointerFollow: boolean
  positionConstraint: boolean
}

export interface CubicGlassGradientProps {
  className?: string
  effects?: Partial<CubicGlassEffects>
  interactionRef?: RefObject<HTMLElement | null>
  preset?: CubicGlassGradientPreset
}
