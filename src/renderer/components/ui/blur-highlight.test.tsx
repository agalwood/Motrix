import '@testing-library/jest-dom/vitest'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlurHighlight } from './blur-highlight'

interface ObserverHarness {
  callback: IntersectionObserverCallback
  disconnect: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
  options?: IntersectionObserverInit
  unobserve: ReturnType<typeof vi.fn>
}

let observer: ObserverHarness
let observerConstructionCount = 0

function installIntersectionObserver() {
  observerConstructionCount = 0
  class MockIntersectionObserver {
    readonly root = null
    readonly rootMargin: string
    readonly thresholds: readonly number[]
    readonly disconnect = vi.fn()
    readonly observe = vi.fn()
    readonly takeRecords = vi.fn(() => [])
    readonly unobserve = vi.fn()

    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      observerConstructionCount += 1
      this.rootMargin = options?.rootMargin ?? '0px'
      this.thresholds = [Number(options?.threshold ?? 0)]
      observer = {
        callback,
        disconnect: this.disconnect,
        observe: this.observe,
        options,
        unobserve: this.unobserve,
      }
    }
  }

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
}

function emitIntersection(isIntersecting: boolean) {
  act(() => {
    observer.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  })
}

describe('BlurHighlight', () => {
  beforeEach(() => {
    installIntersectionObserver()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('highlights every string occurrence without changing the text', () => {
    const { container } = render(
      <BlurHighlight highlightedBits={['data']}>
        one data two data
      </BlurHighlight>
    )

    const root = container.querySelector('[data-slot="blur-highlight"]')
    const bits = container.querySelectorAll('[data-slot="blur-highlight-bit"]')
    expect(root).toHaveTextContent('one data two data')
    expect(bits).toHaveLength(2)
    expect([...bits].map((bit) => bit.textContent)).toEqual(['data', 'data'])
  })

  it('highlights only the requested one-based occurrence', () => {
    const { container } = render(
      <BlurHighlight highlightedBits={[{ text: 'one', occurrence: 2 }]}>
        one one one
      </BlurHighlight>
    )

    const root = container.querySelector(
      '[data-slot="blur-highlight"]'
    ) as HTMLElement
    expect(root.childNodes).toHaveLength(3)
    expect(root.childNodes[0]?.textContent).toBe('one ')
    expect(root.childNodes[1]).toHaveAttribute(
      'data-slot',
      'blur-highlight-bit'
    )
    expect(root.childNodes[1]?.textContent).toBe('one')
    expect(root.childNodes[2]?.textContent).toBe(' one')
  })

  it('maps motion props to stable CSS variables', () => {
    const { container } = render(
      <BlurHighlight
        highlightedBits={['motion']}
        blurAmount={12}
        inactiveOpacity={0.2}
        blurDelay={0.15}
        blurDuration={0.65}
        highlightDelay={0.35}
        highlightDuration={0.9}
        highlightColor="#000000"
        highlightDirection="right"
      >
        test motion
      </BlurHighlight>
    )

    const root = container.querySelector(
      '[data-slot="blur-highlight"]'
    ) as HTMLElement
    expect(root).toHaveAttribute('data-highlight-direction', 'right')
    expect(root.style.getPropertyValue('--blur-highlight-blur')).toBe('12px')
    expect(
      root.style.getPropertyValue('--blur-highlight-inactive-opacity')
    ).toBe('0.2')
    expect(root.style.getPropertyValue('--blur-highlight-blur-duration')).toBe(
      '0.65s'
    )
    expect(root.style.getPropertyValue('--blur-highlight-delay')).toBe('0.35s')
    expect(root.style.getPropertyValue('--blur-highlight-duration')).toBe(
      '0.9s'
    )
    expect(root.style.getPropertyValue('--blur-highlight-color')).toBe(
      '#000000'
    )
  })

  it('tracks the viewport and can settle after one reveal', () => {
    const { container } = render(
      <BlurHighlight
        highlightedBits={['text']}
        viewportOptions={{ once: true, amount: 0.25 }}
      >
        some text
      </BlurHighlight>
    )
    const root = container.querySelector('[data-slot="blur-highlight"]')

    expect(observer.options).toEqual({ rootMargin: '-20%', threshold: 0.25 })
    expect(root).toHaveAttribute('data-in-view', 'false')
    emitIntersection(true)
    emitIntersection(false)
    expect(root).toHaveAttribute('data-in-view', 'true')
    expect(observer.unobserve).toHaveBeenCalledOnce()
  })

  it('falls back to visible without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { container } = render(
      <BlurHighlight highlightedBits={['text']}>some text</BlurHighlight>
    )

    expect(
      container.querySelector('[data-slot="blur-highlight"]')
    ).toHaveAttribute('data-in-view', 'true')
  })

  it('settles immediately when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
    const { container } = render(
      <BlurHighlight highlightedBits={['text']}>some text</BlurHighlight>
    )

    expect(
      container.querySelector('[data-slot="blur-highlight"]')
    ).toHaveAttribute('data-in-view', 'true')
    expect(observerConstructionCount).toBe(0)
  })
})
