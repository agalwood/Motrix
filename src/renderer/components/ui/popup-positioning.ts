import { createContext, useContext, useMemo } from 'react'

type CollisionPadding =
  | number
  | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

/** null means no host boundary; zero keeps its identity while fullscreen. */
export const PopupTopInsetContext = createContext<number | null>(null)

export function usePopupPositioning(padding?: CollisionPadding) {
  const topInset = useContext(PopupTopInsetContext) ?? 0
  return useMemo(() => {
    if (topInset <= 0) return { collisionPadding: padding }
    const sides =
      typeof padding === 'number'
        ? { top: padding, right: padding, bottom: padding, left: padding }
        : padding
    return {
      collisionPadding: {
        top: Math.max(topInset, sides?.top ?? 5),
        right: sides?.right ?? 5,
        bottom: sides?.bottom ?? 5,
        left: sides?.left ?? 5,
      },
      // Permit cross-axis shifting when an anchor is inside the reserved band.
      // Padding alone still lets a bottom popup remain above the safe boundary.
      sticky: true,
    }
  }, [padding, topInset])
}
