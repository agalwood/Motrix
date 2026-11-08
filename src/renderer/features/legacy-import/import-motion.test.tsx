import '@testing-library/jest-dom/vitest'
import { setAppReduceMotion } from '@renderer/lib/reduced-motion'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ImportCount,
  ImportMotionScope,
  ImportStageContent,
} from './import-motion'

const originalAnimate = Element.prototype.animate
const animations: Array<{
  cancel: ReturnType<typeof vi.fn>
  playState: string
}> = []
const animate = vi.fn(() => {
  const animation = { cancel: vi.fn(), playState: 'running' }
  animations.push(animation)
  return animation
})

function Counter({
  value,
  active = true,
}: {
  value: number
  active?: boolean
}) {
  return (
    <ImportMotionScope active={active}>
      <button type="button">Select</button>
      <output aria-label="Selected">
        <ImportCount value={value} />
      </output>
    </ImportMotionScope>
  )
}

beforeEach(() => {
  setAppReduceMotion(false)
  animations.length = 0
  animate.mockClear()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animate,
  })
})

afterEach(() => {
  cleanup()
  setAppReduceMotion(false)
  if (originalAnimate) Element.prototype.animate = originalAnimate
  else Reflect.deleteProperty(Element.prototype, 'animate')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('migration motion', () => {
  it('shows actual counts immediately and replaces an interrupted response', () => {
    const view = render(<Counter value={6} />)
    expect(animate).not.toHaveBeenCalled()
    view.rerender(<Counter value={5} />)
    expect(screen.getByRole('status')).toHaveTextContent('5')
    view.rerender(<Counter value={2} />)
    expect(screen.getByRole('status')).toHaveTextContent('2')
    expect(animations[0].cancel).toHaveBeenCalledOnce()
    expect(animate).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(animations[1].cancel).toHaveBeenCalledOnce()
  })

  it('cancels running feedback on app reduction and does not replay stale counts', () => {
    const view = render(<Counter value={6} />)
    view.rerender(<Counter value={5} />)
    act(() => setAppReduceMotion(true))
    expect(animations[0].cancel).toHaveBeenCalledOnce()
    view.rerender(<Counter value={4} />)
    act(() => setAppReduceMotion(false))
    expect(screen.getByRole('status')).toHaveTextContent('4')
    expect(animate).toHaveBeenCalledTimes(1)
    view.rerender(<Counter value={3} />)
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('keeps keyboard changes immediate and resumes feedback with pointer input', () => {
    const view = render(<Counter value={6} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    view.rerender(<Counter value={0} />)
    expect(screen.getByRole('status')).toHaveTextContent('0')
    expect(animate).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('button'))
    expect(animate).not.toHaveBeenCalled()
    view.rerender(<Counter value={6} />)
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it('stops feedback while the retained page is inactive or the document is hidden', () => {
    const view = render(<Counter value={6} />)
    view.rerender(<Counter value={5} />)
    view.rerender(<Counter value={5} active={false} />)
    expect(animations[0].cancel).toHaveBeenCalledOnce()
    view.rerender(<Counter value={2} active={false} />)
    view.rerender(<Counter value={2} />)
    expect(animate).toHaveBeenCalledTimes(1)
    view.rerender(<Counter value={1} />)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    expect(animations[1].cancel).toHaveBeenCalledOnce()
    view.rerender(<Counter value={0} />)
    expect(screen.getByRole('status')).toHaveTextContent('0')
    expect(animate).toHaveBeenCalledTimes(2)
  })

  it('honors system reduction and renders stage actions without an animation delay', () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
    const click = vi.fn()
    render(
      <ImportMotionScope active>
        <ImportStageContent>
          <button type="button" onClick={click}>
            Import
          </button>
        </ImportStageContent>
      </ImportMotionScope>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(click).toHaveBeenCalledOnce()
    expect(animate).not.toHaveBeenCalled()
  })
})
