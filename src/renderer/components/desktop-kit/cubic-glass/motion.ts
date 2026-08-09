export interface SpringAxisState {
  value: number
  velocity: number
}

export interface PointerOffset {
  x: number
  y: number
}

export interface PointerPositionConstraint {
  downward: number
  upward: number
  verticalPower: number
}

const SPRING_EPSILON = 0.00008
const FAST_HORIZONTAL_RESPONSE_SECONDS = 0.5
const SLOW_HORIZONTAL_RESPONSE_SECONDS = 5.5

export function resolveHorizontalResponseSeconds(speed: number): number {
  const normalizedSpeed = Math.max(0, Math.min(100, speed)) / 100
  return (
    SLOW_HORIZONTAL_RESPONSE_SECONDS -
    (SLOW_HORIZONTAL_RESPONSE_SECONDS - FAST_HORIZONTAL_RESPONSE_SECONDS) *
      normalizedSpeed
  )
}

export function stepCriticalSpring(
  state: SpringAxisState,
  target: number,
  responseSeconds: number,
  deltaSeconds: number
): SpringAxisState {
  const response = Math.max(responseSeconds, 0.05)
  const delta = Math.min(Math.max(deltaSeconds, 0), 0.05)
  const omega = (2 * Math.PI) / response
  const displacement = state.value - target
  const coefficient = state.velocity + omega * displacement
  const decay = Math.exp(-omega * delta)

  return {
    value: target + (displacement + coefficient * delta) * decay,
    velocity: (state.velocity - omega * coefficient * delta) * decay,
  }
}

export function resolvePointerOffset(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'height' | 'left' | 'top' | 'width'>,
  travel: PointerOffset,
  positionConstraint?: PointerPositionConstraint
): PointerOffset {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 }

  const x = Math.max(
    -1,
    Math.min(1, ((clientX - bounds.left) / bounds.width) * 2 - 1)
  )
  const y = Math.max(
    -1,
    Math.min(1, 1 - ((clientY - bounds.top) / bounds.height) * 2)
  )

  if (!positionConstraint) return { x: x * travel.x, y: y * travel.y }

  const verticalLimit =
    y >= 0 ? positionConstraint.upward : positionConstraint.downward
  const constrainedY =
    Math.sign(y) *
    Math.abs(y) ** positionConstraint.verticalPower *
    verticalLimit

  return { x: x * travel.x, y: constrainedY }
}

export function isSpringSettled(
  state: SpringAxisState,
  target: number
): boolean {
  return (
    Math.abs(state.value - target) < SPRING_EPSILON &&
    Math.abs(state.velocity) < SPRING_EPSILON
  )
}
