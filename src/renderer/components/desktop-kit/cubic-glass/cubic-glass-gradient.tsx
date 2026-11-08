import { cn } from '@renderer/lib/utils'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { resolveCubicGlassEffects } from './config'
import type { CubicGlassRendererController } from './renderer'
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
  const rendererRef = useRef<CubicGlassRendererController | null>(null)
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
    rendererRef.current?.schedule()
  })

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas || typeof WebGL2RenderingContext === 'undefined') {
      return
    }

    let generation = 0
    let timer: number | undefined
    let idle: number | undefined
    let renderer: CubicGlassRendererController | null = null
    const cancelStart = () => {
      generation++
      window.clearTimeout(timer)
      if (idle !== undefined) window.cancelIdleCallback(idle)
      idle = undefined
    }
    const createRenderer = async (current: number) => {
      try {
        const { startCubicGlassRenderer } = await import('./renderer')
        if (current !== generation) return
        renderer = startCubicGlassRenderer(
          canvas,
          root,
          () => presetRef.current,
          () => effectsRef.current,
          () => interactionRef?.current ?? root.parentElement
        )
        rendererRef.current = renderer
      } catch {
        // The decorative renderer is optional; leave the background blank if
        // its chunk or GPU initialization fails.
      }
    }
    const scheduleStart = () => {
      cancelStart()
      const current = generation
      // Paint the empty-state content before loading shaders or creating a
      // GPU context, which can be expensive under virtualized graphics.
      timer = window.setTimeout(() => {
        const start = () => {
          idle = undefined
          if (current === generation) void createRenderer(current)
        }
        if (typeof window.requestIdleCallback === 'function') {
          idle = window.requestIdleCallback(start, { timeout: 1500 })
        } else {
          start()
        }
      }, 200)
    }
    scheduleStart()
    const onContextLost = (event: Event) => {
      event.preventDefault()
      cancelStart()
      renderer?.dispose(true)
      renderer = null
      rendererRef.current = renderer
      root.dataset.renderer = 'fallback'
      canvas.dataset.ready = 'false'
    }
    const onContextRestored = () => {
      scheduleStart()
    }

    canvas.addEventListener('webglcontextlost', onContextLost)
    canvas.addEventListener('webglcontextrestored', onContextRestored)
    return () => {
      cancelStart()
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      renderer?.dispose()
      rendererRef.current = null
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
      className={cn('cubic-glass-motion pointer-events-none', className)}
    >
      <canvas
        ref={canvasRef}
        data-ready="false"
        className="block size-full opacity-0 data-[ready=true]:opacity-100"
      />
    </div>
  )
}
