import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'

export function MenuNavigationFocus() {
  const { pathname, state } = useLocation()
  const action = useNavigationType()
  useEffect(() => {
    if (
      !state?.menuNavigationFocus ||
      action === 'POP' ||
      pathname === '/downloads'
    )
      return
    // The layout retains hidden settings and migration panels across navigation.
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        (element) => !element.closest('[hidden], [inert]')
      )
    const target =
      visible('[role="dialog"] h2') ??
      visible('[data-downloads-grid]') ??
      visible('main h1')
    if (!target) return
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }, [pathname, state, action])
  return null
}
