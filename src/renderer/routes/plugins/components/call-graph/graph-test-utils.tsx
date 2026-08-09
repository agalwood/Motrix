import { TooltipProvider } from '@renderer/components/ui/tooltip'
import type { RenderResult } from '@testing-library/react'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement, ReactNode } from 'react'

interface GraphTestEnvironmentOptions {
  width?: number
  height?: number
}

interface PropertySnapshot {
  key: PropertyKey
  descriptor: PropertyDescriptor | undefined
}

function sizedRect(
  element: HTMLElement,
  width: number,
  height: number
): DOMRect {
  const elementWidth = Number.parseFloat(element.style.width) || width
  const elementHeight = Number.parseFloat(element.style.height) || height

  return {
    x: 0,
    y: 0,
    top: 0,
    right: elementWidth,
    bottom: elementHeight,
    left: 0,
    width: elementWidth,
    height: elementHeight,
    toJSON: () => ({}),
  }
}

export function installGraphTestEnvironment({
  width = 960,
  height = 540,
}: GraphTestEnvironmentOptions = {}): () => void {
  const globalSnapshots: PropertySnapshot[] = [
    {
      key: 'ResizeObserver',
      descriptor: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
    },
    {
      key: 'DOMMatrixReadOnly',
      descriptor: Object.getOwnPropertyDescriptor(
        globalThis,
        'DOMMatrixReadOnly'
      ),
    },
  ]
  const elementSnapshots: PropertySnapshot[] = [
    'clientWidth',
    'clientHeight',
    'offsetWidth',
    'offsetHeight',
    'getBoundingClientRect',
  ].map((key) => ({
    key,
    descriptor: Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
  }))

  class GraphResizeObserver implements ResizeObserver {
    readonly #callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback
    }

    disconnect(): void {}

    observe(target: Element): void {
      const contentRect = (target as HTMLElement).getBoundingClientRect()
      this.#callback(
        [
          {
            target,
            contentRect,
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        this
      )
    }

    unobserve(): void {}
  }

  class GraphDOMMatrixReadOnly {
    readonly a: number
    readonly b = 0
    readonly c = 0
    readonly d: number
    readonly e = 0
    readonly f = 0
    readonly m11: number
    readonly m22: number

    constructor(transform = '') {
      const values = transform
        .match(/matrix\(([^)]+)\)/)?.[1]
        ?.split(',')
        .map(Number)
      this.a = Number.isFinite(values?.[0]) ? (values?.[0] ?? 1) : 1
      this.d = Number.isFinite(values?.[3]) ? (values?.[3] ?? 1) : 1
      this.m11 = this.a
      this.m22 = this.d
    }
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: GraphResizeObserver,
  })
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
    configurable: true,
    writable: true,
    value: GraphDOMMatrixReadOnly,
  })
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
    offsetWidth: { configurable: true, get: () => width },
    offsetHeight: { configurable: true, get: () => height },
    getBoundingClientRect: {
      configurable: true,
      value(this: HTMLElement) {
        return sizedRect(this, width, height)
      },
    },
  })

  return () => {
    for (const snapshot of [...globalSnapshots, ...elementSnapshots]) {
      const target = globalSnapshots.includes(snapshot)
        ? globalThis
        : HTMLElement.prototype
      if (snapshot.descriptor) {
        Object.defineProperty(target, snapshot.key, snapshot.descriptor)
      } else {
        Reflect.deleteProperty(target, snapshot.key)
      }
    }
  }
}

export function renderInReactFlowProvider(ui: ReactElement): RenderResult {
  function GraphTestProviders({ children }: { children: ReactNode }) {
    return (
      <TooltipProvider>
        <ReactFlowProvider>{children}</ReactFlowProvider>
      </TooltipProvider>
    )
  }

  return render(ui, {
    wrapper: GraphTestProviders,
  })
}
