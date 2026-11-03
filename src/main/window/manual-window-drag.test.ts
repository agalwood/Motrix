import { describe, expect, it, vi } from 'vitest'
import { beginManualWindowDrag } from './manual-window-drag'

describe('beginManualWindowDrag', () => {
  it('moves the window by the cursor delta until stopped', () => {
    const setPosition = vi.fn()
    const win = {
      getBounds: vi.fn(() => ({ x: 20, y: 30, width: 800, height: 600 })),
      isDestroyed: vi.fn(() => false),
      setPosition,
    }

    const drag = beginManualWindowDrag(win, { x: 100, y: 200 })
    drag.move({ x: 140, y: 230 })
    expect(setPosition).toHaveBeenLastCalledWith(60, 60, false)

    drag.stop()
    drag.move({ x: 200, y: 300 })
    expect(setPosition).toHaveBeenCalledOnce()
  })

  it('does not move a destroyed window', () => {
    const win = {
      getBounds: vi.fn(() => ({ x: 20, y: 30, width: 800, height: 600 })),
      isDestroyed: vi.fn(() => true),
      setPosition: vi.fn(),
    }
    const drag = beginManualWindowDrag(win, { x: 25, y: 35 })
    drag.move({ x: 30, y: 40 })
    drag.move({ x: 40, y: 50 })

    expect(win.setPosition).not.toHaveBeenCalled()
  })
})
