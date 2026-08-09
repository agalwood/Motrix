import {
  POINTER_POSITION_CONSTRAINT,
  POINTER_TRAVEL,
  POINTER_Y_RESPONSE_SECONDS,
  POINTER_Y_RETURN_RESPONSE_SECONDS,
} from './config'
import {
  isSpringSettled,
  resolveHorizontalResponseSeconds,
  resolvePointerOffset,
  type SpringAxisState,
  stepCriticalSpring,
} from './motion'
import type { CubicGlassEffects, CubicGlassGradientPreset } from './types'
import { createCubicGlassWebGlScene } from './webgl-scene'

export interface CubicGlassRendererController {
  dispose: (contextLost?: boolean) => void
  schedule: () => void
}

export const IDLE_CUBIC_GLASS_RENDERER: CubicGlassRendererController = {
  dispose: () => {},
  schedule: () => {},
}

export function startCubicGlassRenderer(
  canvas: HTMLCanvasElement,
  root: HTMLDivElement,
  readPreset: () => CubicGlassGradientPreset,
  readEffects: () => CubicGlassEffects,
  readInteractionElement: () => HTMLElement | null
): CubicGlassRendererController {
  const scene = createCubicGlassWebGlScene(canvas)
  if (!scene) return IDLE_CUBIC_GLASS_RENDERER
  const webGlScene = scene

  let animationFrame = 0
  let boundsDirty = true
  let cssHeight = 0
  let cssWidth = 0
  let disposed = false
  let dprQuery: MediaQueryList | null = null
  let finePointerQuery: MediaQueryList | null = null
  let lastTimestamp = 0
  let reducedMotionQuery: MediaQueryList | null = null
  let rootBounds = { height: 0, left: 0, top: 0, width: 0 }
  let sceneDirty = true
  let pointerClientX = 0
  let pointerClientY = 0
  let pointerInside = false
  let targetX = 0
  let targetY = 0
  let xSpring: SpringAxisState = { value: 0, velocity: 0 }
  let ySpring: SpringAxisState = { value: 0, velocity: 0 }
  const interactionElement =
    readInteractionElement() ?? root.parentElement ?? root

  const pointerFollowEnabled = () => {
    const effects = readEffects()
    return (
      effects.enabled &&
      effects.pointerFollow &&
      reducedMotionQuery?.matches !== true &&
      finePointerQuery?.matches !== false
    )
  }

  const springIsSettled = () =>
    isSpringSettled(xSpring, targetX) && isSpringSettled(ySpring, targetY)

  const setPointerInside = (inside: boolean) => {
    if (pointerInside === inside) return
    pointerInside = inside
    root.dataset.pointerActive = String(inside)
  }

  const returnToOrigin = (immediate = false) => {
    targetX = 0
    targetY = 0
    setPointerInside(false)
    if (immediate) {
      xSpring = { value: 0, velocity: 0 }
      ySpring = { value: 0, velocity: 0 }
      lastTimestamp = 0
    }
  }

  const refreshBounds = () => {
    const bounds = root.getBoundingClientRect()
    rootBounds = {
      height: bounds.height,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
    }
    cssWidth = bounds.width
    cssHeight = bounds.height
    boundsDirty = false
  }

  const refreshPointerTarget = () => {
    if (!pointerInside) return
    const preset = readPreset()
    const [travelX, travelY] = POINTER_TRAVEL[preset]
    const effects = readEffects()
    const target = resolvePointerOffset(
      pointerClientX,
      pointerClientY,
      rootBounds,
      { x: travelX, y: travelY },
      effects.positionConstraint
        ? POINTER_POSITION_CONSTRAINT[preset]
        : undefined
    )
    targetX = target.x
    targetY = target.y
  }

  function scheduleFrame() {
    if (
      disposed ||
      animationFrame !== 0 ||
      document.visibilityState === 'hidden'
    ) {
      return
    }
    animationFrame = requestAnimationFrame(draw)
  }

  function draw(timestamp: number) {
    animationFrame = 0
    if (disposed) return

    if (boundsDirty) {
      refreshBounds()
    }
    if (cssWidth < 1 || cssHeight < 1) return

    if (!pointerFollowEnabled()) returnToOrigin(true)
    refreshPointerTarget()
    const wasSettled = springIsSettled()
    if (!wasSettled) {
      const deltaSeconds =
        lastTimestamp === 0 ? 1 / 60 : (timestamp - lastTimestamp) / 1000
      const horizontalResponse = resolveHorizontalResponseSeconds(
        readEffects().horizontalSpeed
      )
      const xResponse = pointerInside
        ? horizontalResponse
        : horizontalResponse * 0.88
      const yResponse = pointerInside
        ? POINTER_Y_RESPONSE_SECONDS
        : POINTER_Y_RETURN_RESPONSE_SECONDS
      xSpring = stepCriticalSpring(xSpring, targetX, xResponse, deltaSeconds)
      ySpring = stepCriticalSpring(ySpring, targetY, yResponse, deltaSeconds)
      if (springIsSettled()) {
        xSpring = { value: targetX, velocity: 0 }
        ySpring = { value: targetY, velocity: 0 }
      }
    }
    lastTimestamp = timestamp
    const moving = !springIsSettled()

    const requestedPixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const pixelBudgetRatio = Math.sqrt(
      (moving ? 2_000_000 : 5_000_000) / (cssWidth * cssHeight)
    )
    const pixelRatio = Math.min(requestedPixelRatio, pixelBudgetRatio)
    const width = Math.max(1, Math.round(cssWidth * pixelRatio))
    const height = Math.max(1, Math.round(cssHeight * pixelRatio))

    webGlScene.render({
      height,
      offsetX: xSpring.value,
      offsetY: ySpring.value,
      preset: readPreset(),
      refreshScene: sceneDirty,
      width,
    })
    sceneDirty = false
    root.dataset.renderer = 'webgl2'
    canvas.dataset.ready = 'true'
    if (moving) {
      scheduleFrame()
    } else {
      lastTimestamp = 0
    }
  }

  const scheduleSceneDraw = () => {
    sceneDirty = true
    if (!pointerFollowEnabled()) {
      returnToOrigin(reducedMotionQuery?.matches === true)
    }
    scheduleFrame()
  }

  const invalidateBounds = () => {
    boundsDirty = true
    scheduleSceneDraw()
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (
      (event.pointerType && event.pointerType !== 'mouse') ||
      !pointerFollowEnabled()
    ) {
      return
    }
    if (boundsDirty) refreshBounds()
    const inside =
      event.clientX >= rootBounds.left &&
      event.clientX <= rootBounds.left + rootBounds.width &&
      event.clientY >= rootBounds.top &&
      event.clientY <= rootBounds.top + rootBounds.height
    if (!inside) {
      const needsReturnFrame = pointerInside || !springIsSettled()
      returnToOrigin()
      if (needsReturnFrame) scheduleFrame()
      return
    }

    pointerClientX = event.clientX
    pointerClientY = event.clientY
    setPointerInside(true)
    refreshPointerTarget()
    scheduleFrame()
  }

  const handlePointerLeave = () => {
    const needsReturnFrame = pointerInside || !springIsSettled()
    returnToOrigin()
    if (needsReturnFrame) scheduleFrame()
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(invalidateBounds)
  resizeObserver?.observe(root)

  const themeObserver =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scheduleSceneDraw)
  themeObserver?.observe(document.documentElement, {
    attributeFilter: ['class'],
    attributes: true,
  })

  const handleDprChange = () => {
    bindDprQuery()
    invalidateBounds()
  }
  const bindDprQuery = () => {
    dprQuery?.removeEventListener('change', handleDprChange)
    dprQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
    dprQuery?.addEventListener('change', handleDprChange)
  }
  const handleReducedMotionChange = () => {
    if (reducedMotionQuery?.matches) returnToOrigin(true)
    scheduleSceneDraw()
  }
  const handlePointerCapabilityChange = () => {
    if (!finePointerQuery?.matches) returnToOrigin(true)
    scheduleSceneDraw()
  }
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
      animationFrame = 0
      returnToOrigin(true)
      return
    }
    lastTimestamp = 0
    scheduleSceneDraw()
  }
  bindDprQuery()
  if (typeof window.matchMedia === 'function') {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)')
    reducedMotionQuery.addEventListener('change', handleReducedMotionChange)
    finePointerQuery.addEventListener('change', handlePointerCapabilityChange)
  }
  interactionElement.addEventListener('pointerleave', handlePointerLeave)
  interactionElement.addEventListener('pointercancel', handlePointerLeave)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('blur', handlePointerLeave)
  window.addEventListener('resize', invalidateBounds)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  scheduleSceneDraw()

  const dispose = (contextLost = false) => {
    if (disposed) return
    disposed = true
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame)
    resizeObserver?.disconnect()
    themeObserver?.disconnect()
    dprQuery?.removeEventListener('change', handleDprChange)
    reducedMotionQuery?.removeEventListener('change', handleReducedMotionChange)
    finePointerQuery?.removeEventListener(
      'change',
      handlePointerCapabilityChange
    )
    interactionElement.removeEventListener('pointerleave', handlePointerLeave)
    interactionElement.removeEventListener('pointercancel', handlePointerLeave)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('blur', handlePointerLeave)
    window.removeEventListener('resize', invalidateBounds)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    webGlScene.dispose(contextLost)
  }

  return { dispose, schedule: scheduleSceneDraw }
}
