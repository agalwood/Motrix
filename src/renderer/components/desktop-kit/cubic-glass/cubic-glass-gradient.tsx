import { cn } from '@renderer/lib/utils'
import { useLayoutEffect, useRef } from 'react'
import { resolveCubicGlassEffects } from './config'
import {
  type CubicGlassRendererController,
  IDLE_CUBIC_GLASS_RENDERER,
  startCubicGlassRenderer,
} from './renderer'
import type { CubicGlassGradientProps } from './types'
import './cubic-glass-gradient.css'

export function CubicGlassGradient({
  className,
  effects,
  interactionRef,
  preset = 'blue-pink',
}: CubicGlassGradientProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const presetRef = useRef(preset)
  const effectsRef = useRef(resolveCubicGlassEffects(effects))
  const rendererRef = useRef<CubicGlassRendererController>(
    IDLE_CUBIC_GLASS_RENDERER
  )
  const resolvedEffects = resolveCubicGlassEffects(effects)
  const loadFadeEnabled = resolvedEffects.enabled && resolvedEffects.loadFade
  const breathingEnabled = resolvedEffects.enabled && resolvedEffects.breathing
  const pointerFollowEnabled =
    resolvedEffects.enabled && resolvedEffects.pointerFollow
  const positionConstraintEnabled =
    pointerFollowEnabled && resolvedEffects.positionConstraint

  presetRef.current = preset
  effectsRef.current = resolvedEffects

  useLayoutEffect(() => {
    rendererRef.current.schedule()
  })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (!loadFadeEnabled || typeof requestAnimationFrame === 'undefined') {
      root.dataset.revealReady = 'true'
      return
    }

    root.dataset.revealReady = 'false'
    const frame = requestAnimationFrame(() => {
      root.dataset.revealReady = 'true'
    })
    return () => cancelAnimationFrame(frame)
  }, [loadFadeEnabled])

  useLayoutEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas || typeof WebGL2RenderingContext === 'undefined') {
      return
    }

    const createRenderer = () =>
      startCubicGlassRenderer(
        canvas,
        root,
        () => presetRef.current,
        () => effectsRef.current,
        () => interactionRef?.current ?? root.parentElement
      )
    let renderer = createRenderer()
    rendererRef.current = renderer
    const onContextLost = (event: Event) => {
      event.preventDefault()
      renderer.dispose(true)
      renderer = IDLE_CUBIC_GLASS_RENDERER
      rendererRef.current = renderer
      root.dataset.renderer = 'fallback'
      canvas.dataset.ready = 'false'
    }
    const onContextRestored = () => {
      renderer = createRenderer()
      rendererRef.current = renderer
    }

    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      renderer.dispose()
      rendererRef.current = IDLE_CUBIC_GLASS_RENDERER
    }
  }, [interactionRef])

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-renderer="fallback"
      data-slot="cubic-glass-gradient"
      data-preset={preset}
      data-effect-breathing={breathingEnabled}
      data-effect-load-fade={loadFadeEnabled}
      data-effect-pointer-follow={pointerFollowEnabled}
      data-effect-position-constraint={positionConstraintEnabled}
      data-horizontal-speed={resolvedEffects.horizontalSpeed}
      data-pointer-active="false"
      data-reveal-ready={loadFadeEnabled ? 'false' : 'true'}
      className={cn(
        'cubic-glass-fallback cubic-glass-motion pointer-events-none',
        className
      )}
    >
      <canvas
        ref={canvasRef}
        data-ready="false"
        className="block size-full opacity-0 data-[ready=true]:opacity-100"
      />
    </div>
  )
}
