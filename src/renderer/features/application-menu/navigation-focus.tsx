import { useEffect } from 'react'
import { useLocation } from 'react-router'

let destination: string | null = null
export function requestMenuNavigationFocus(path: string): void {
  destination = path
}
export function MenuNavigationFocus() {
  const location = useLocation()
  useEffect(() => {
    if (!destination || location.pathname !== destination) return
    destination = null
    const target = document.querySelector<HTMLElement>(
      '[data-downloads-grid], [role="dialog"] h2, main h1'
    )
    if (!target || target.closest('[inert]')) return
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }, [location.pathname])
  return null
}
