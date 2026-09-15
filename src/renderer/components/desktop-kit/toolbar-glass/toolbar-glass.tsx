import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createDisplacementMap } from './displacement-map'
import './toolbar-glass.css'

const SOLID_MATERIAL_QUERY =
  '(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)'

function solidMaterialRequested() {
  return window.matchMedia?.(SOLID_MATERIAL_QUERY).matches === true
}

function subscribeMaterialPreference(listener: () => void) {
  const query = window.matchMedia?.(SOLID_MATERIAL_QUERY)
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}

/** Decorative background only; the existing controls keep their DOM and focus. */
export function ToolbarGlass({ enabled }: { enabled: boolean }) {
  const solid = useSyncExternalStore(
    subscribeMaterialPreference,
    solidMaterialRequested,
    () => true
  )
  return enabled && !solid ? <GlassLayer /> : null
}

function GlassLayer() {
  const id = `toolbar-glass-${useId().replaceAll(':', '')}`
  const layerRef = useRef<HTMLSpanElement>(null)
  const imageRef = useRef<SVGFEImageElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const layer = layerRef.current
    // SVG backdrop filters are supported by Electron/Chromium. Other web
    // engines retain the CSS frost; syntax acceptance alone is insufficient.
    const chromium =
      __MOTRIX_TARGET__ === 'electron' ||
      /Chrom(e|ium)\//.test(navigator.userAgent)
    if (
      !layer ||
      !chromium ||
      typeof CSS === 'undefined' ||
      !CSS.supports('backdrop-filter', `url("#${id}")`)
    )
      return
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return
    let frame = 0
    let lastSize = ''

    const update = () => {
      frame = 0
      const bounds = layer.getBoundingClientRect()
      if (bounds.width < 1 || bounds.height < 1) return
      // CSS-pixel maps suffice for this small, softly refracted rim. Bound
      // allocations even if an unexpected layout stretches the surface.
      const width = Math.min(1024, Math.round(bounds.width))
      const height = Math.min(128, Math.round(bounds.height))
      const size = `${width}:${height}`
      if (lastSize === size) return
      lastSize = size
      canvas.width = width
      canvas.height = height
      const map = context.createImageData(width, height)
      map.data.set(createDisplacementMap(width, height))
      context.putImageData(map, 0, 0)
      imageRef.current?.setAttribute('href', canvas.toDataURL())
      setReady(true)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    schedule()
    const observer = new ResizeObserver(schedule)
    observer.observe(layer)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      canvas.width = 0
      canvas.height = 0
    }
  }, [id])

  return (
    <span
      ref={layerRef}
      data-slot="toolbar-glass"
      data-refraction={ready}
      className="toolbar-glass"
      aria-hidden="true"
      style={
        ready
          ? { backdropFilter: `url("#${id}") blur(2px) saturate(1.08)` }
          : undefined
      }
    >
      {/* Percentage feImage dimensions need the real surface viewport. A
          zero-sized SVG makes the map empty and shifts the entire backdrop. */}
      <svg
        className="absolute inset-0 size-full"
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <filter
            id={id}
            x="0%"
            y="0%"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            <feImage
              ref={imageRef}
              x="0%"
              y="0%"
              width="100%"
              height="100%"
              preserveAspectRatio="none"
              result="rim"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="rim"
              scale="8"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
    </span>
  )
}
