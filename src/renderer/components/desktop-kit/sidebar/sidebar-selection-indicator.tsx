import { getReducedMotion } from '@renderer/lib/reduced-motion'
import { type RefObject, useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

export function SidebarSelectionIndicator({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>
}) {
  const location = useLocation()
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const previousPath = useRef(location.pathname)
  const positioned = useRef(false)
  const animationDeadline = useRef(0)

  useEffect(() => {
    const container = containerRef.current
    const indicator = indicatorRef.current
    if (!container || !indicator) return

    const update = (animate: boolean) => {
      const activeButton = container.querySelector<HTMLElement>(
        '[data-slot="sidebar-menu-button"][data-active="true"]'
      )
      if (!activeButton) {
        indicator.dataset.visible = 'false'
        return
      }

      const containerRect = container.getBoundingClientRect()
      const activeRect = activeButton.getBoundingClientRect()
      if (activeRect.width <= 0 || activeRect.height <= 0) return

      indicator.dataset.visible = 'true'
      const shouldAnimate = animate && positioned.current && !getReducedMotion()
      indicator.style.transition = shouldAnimate
        ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), width 220ms cubic-bezier(0.22, 1, 0.36, 1), height 220ms cubic-bezier(0.22, 1, 0.36, 1)'
        : 'none'
      if (shouldAnimate) animationDeadline.current = performance.now() + 260
      indicator.style.transform = `translate3d(${activeRect.left - containerRect.left}px, ${activeRect.top - containerRect.top}px, 0)`
      indicator.style.width = `${activeRect.width}px`
      indicator.style.height = `${activeRect.height}px`
      positioned.current = true
    }

    const pathChanged = previousPath.current !== location.pathname
    previousPath.current = location.pathname
    update(pathChanged)
    const readyPoll =
      positioned.current || typeof window === 'undefined'
        ? null
        : window.setInterval(() => {
            update(false)
            if (positioned.current && readyPoll !== null) {
              window.clearInterval(readyPoll)
            }
          }, 50)
    const readyTimeout =
      readyPoll === null
        ? null
        : window.setTimeout(() => {
            window.clearInterval(readyPoll)
          }, 2_000)

    const updateWithoutAnimation = () => {
      if (performance.now() < animationDeadline.current) return
      if (
        typeof indicator.getAnimations === 'function' &&
        indicator.getAnimations().length > 0
      )
        return
      update(false)
    }
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateWithoutAnimation)
    observer?.observe(container)
    const mutations =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(updateWithoutAnimation)
    mutations?.observe(container, {
      attributeFilter: ['data-active'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    container.addEventListener('scroll', updateWithoutAnimation, true)
    return () => {
      if (readyPoll !== null) window.clearInterval(readyPoll)
      if (readyTimeout !== null) window.clearTimeout(readyTimeout)
      observer?.disconnect()
      mutations?.disconnect()
      container.removeEventListener('scroll', updateWithoutAnimation, true)
    }
  }, [containerRef, location.pathname])

  return (
    <span
      ref={indicatorRef}
      aria-hidden="true"
      data-slot="sidebar-selection"
      data-visible="false"
      className="pointer-events-none absolute top-0 left-0 z-0 rounded-md bg-sidebar-active opacity-0 data-[visible=true]:opacity-100"
    />
  )
}
